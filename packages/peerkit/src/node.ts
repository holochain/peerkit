import { getLogger, type Logger } from "@logtape/logtape";
import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentId,
  AgentsReceivedCallback,
  IAgentStore,
  IKeyPair,
  ITransport,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  NodeAddress,
  NodeId,
  PeerConnectedCallback,
  RelayAddress,
} from "@peerkit/api";
import { createNode, type CreateNodeOptions } from "@peerkit/transport-libp2p";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AgentKeyPair, decodeAgentId } from "./agent.js";
import { buildOwnAgentInfo } from "./agent-info.js";
import {
  getAgentsReceivedCallback,
  type AgentsReceivedObserver,
} from "./common.js";
import { serializeAgentInfoList } from "./serialize.js";

/**
 * App-level message handler. Receives the sender's {@link AgentId} rather than
 * an ephemeral transport-level {@link NodeId}.
 */
export type AppMessageHandler = (
  fromAgent: AgentId,
  message: Uint8Array,
) => Promise<void>;

export type PeerkitNodeTransportFactory = (
  options: CreateNodeOptions,
) => Promise<ITransport>;

/**
 * Builds a {@link PeerkitNode}.
 *
 * `networkAccessHandler` and `messageHandler` are required; everything else is
 * optional and can be supplied via the fluent setters before calling
 * {@link build}.
 *
 * @example
 * ```ts
 * const node = await new PeerkitNodeBuilder({
 *   networkAccessHandler: async () => true,
 *   messageHandler: async (fromAgent, data) => { ... },
 * })
 *   .withId("node1")
 *   .withBootstrapRelays([relayAddress])
 *   .build();
 * ```
 */
export class PeerkitNodeBuilder {
  bootstrapRelays: RelayAddress[] = [];
  id?: string;
  addresses?: NodeAddress[];
  networkAccessBytes?: NetworkAccessBytes;
  agentStore?: IAgentStore;
  nodeTransportFactory?: PeerkitNodeTransportFactory;
  agentsReceivedObserver?: (agentIds: AgentId[]) => void;
  connectedToRelayObserver?: (address: RelayAddress) => void;

  readonly networkAccessHandler: NetworkAccessHandler;
  readonly messageHandler: AppMessageHandler;

  constructor({
    networkAccessHandler,
    messageHandler,
  }: {
    networkAccessHandler: NetworkAccessHandler;
    messageHandler: AppMessageHandler;
  }) {
    this.networkAccessHandler = networkAccessHandler;
    this.messageHandler = messageHandler;
  }

  withBootstrapRelays(relays: RelayAddress[]): this {
    this.bootstrapRelays = relays;
    return this;
  }

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withAddresses(addresses: NodeAddress[]): this {
    this.addresses = addresses;
    return this;
  }

  withNetworkAccessBytes(bytes: NetworkAccessBytes): this {
    this.networkAccessBytes = bytes;
    return this;
  }

  withAgentStore(store: IAgentStore): this {
    this.agentStore = store;
    return this;
  }

  withTransportFactory(factory: PeerkitNodeTransportFactory): this {
    this.nodeTransportFactory = factory;
    return this;
  }

  withAgentsReceivedObserver(fn: (agentIds: AgentId[]) => void): this {
    this.agentsReceivedObserver = fn;
    return this;
  }

  withRelayConnectedObserver(fn: (address: NodeAddress) => void): this {
    this.connectedToRelayObserver = fn;
    return this;
  }

  private buildAgentLayer(
    keyPair: AgentKeyPair,
    logger: Logger,
    agentStore: IAgentStore,
  ): {
    networkAccessBytesWithKey: Uint8Array;
    networkAccessHandler: NetworkAccessHandler;
    messageHandler: MessageHandler;
    agentsReceivedCallback: AgentsReceivedCallback;
  } {
    // NodeId → AgentId, populated during the access handshake before any
    // message stream can open.
    const agentByNodeId = new Map<NodeId, AgentId>();

    // Prepend this node's public key to the access bytes, so
    // the remote can map our NodeId to our AgentId at handshake time.
    const publicKeyBytes = decodeAgentId(keyPair.agentId());
    const networkAccessBytes = this.networkAccessBytes ?? new Uint8Array(0); // empty if none set
    const networkAccessBytesWithKey = new Uint8Array(
      networkAccessBytes.length + publicKeyBytes.length,
    );
    // [ownPublicKey, networkAccessBytes]
    networkAccessBytesWithKey.set(publicKeyBytes, 0);
    networkAccessBytesWithKey.set(networkAccessBytes, publicKeyBytes.length);

    // Wrap the user's handler: extract the remote's public key from the first
    // bytes (length of public key), record the mapping, then delegate with the remainder.
    const appNetworkAccessHandler = this.networkAccessHandler;
    const networkAccessHandler: NetworkAccessHandler = async (
      nodeId,
      bytes,
    ) => {
      if (bytes.length >= publicKeyBytes.length) {
        agentByNodeId.set(
          nodeId,
          bytesToHex(bytes.subarray(0, publicKeyBytes.length)),
        );
      } else {
        logger.warn(
          "Peer did not send an AgentId in access bytes — messages from this node will be dropped {*}",
          { nodeId },
        );
      }
      return appNetworkAccessHandler(
        nodeId,
        bytes.length > publicKeyBytes.length
          ? bytes.subarray(publicKeyBytes.length)
          : new Uint8Array(0),
      );
    };

    const appMessageHandler = this.messageHandler;
    const messageHandler: MessageHandler = async (
      fromNode,
      message,
      _transport,
    ) => {
      const agentId = agentByNodeId.get(fromNode);
      if (agentId !== undefined) {
        await appMessageHandler(agentId, message);
        return;
      }
      logger.warn("Message from node with no agent mapping — dropping {*}", {
        fromNode,
      });
    };

    const appAgentsObserver = this.agentsReceivedObserver;
    const agentsObserver: AgentsReceivedObserver | undefined = appAgentsObserver
      ? (_fromNode, agentInfos) =>
          appAgentsObserver(agentInfos.map((info) => info.agentId))
      : undefined;

    const agentsReceivedCallback = getAgentsReceivedCallback(
      logger,
      agentStore,
      agentsObserver,
    );

    return {
      networkAccessBytesWithKey,
      networkAccessHandler,
      messageHandler,
      agentsReceivedCallback,
    };
  }

  async build(): Promise<PeerkitNode> {
    const keyPair = new AgentKeyPair();
    const agentStore = this.agentStore ?? new MemoryAgentStore();
    const logger = getLogger(["peerkit", "node"]).with({
      id: this.id,
      agentId: keyPair.agentId(),
    });

    const {
      networkAccessBytesWithKey,
      networkAccessHandler,
      messageHandler,
      agentsReceivedCallback,
    } = this.buildAgentLayer(keyPair, logger, agentStore);

    const peerConnectedCallback: PeerConnectedCallback = async (
      nodeId,
      transport,
    ) => {
      const agentInfos = agentStore.getAll();
      if (agentInfos.length) {
        try {
          await transport.sendAgents(
            nodeId,
            serializeAgentInfoList(agentInfos),
          );
        } catch (error) {
          logger.error("Failed to send agents to peer {*}", { nodeId, error });
        }
      }
    };

    const relayConnectedObserver = this.connectedToRelayObserver;
    const connectedToRelayCallback = async (
      relayedNodeAddress: NodeAddress,
      relayNodeId: string,
      transport: ITransport,
    ) => {
      const existingAgentInfo = agentStore.get(keyPair.agentId());
      const addresses = [
        ...(existingAgentInfo?.addresses ?? []),
        relayedNodeAddress,
      ];
      const agentInfoSigned = buildOwnAgentInfo(
        keyPair,
        addresses,
        Date.now() + 60_000,
      );
      const agentInfos = [agentInfoSigned];
      agentStore.store(agentInfos);
      try {
        await transport.sendAgents(
          relayNodeId,
          serializeAgentInfoList(agentInfos),
        );
      } catch (error) {
        logger.error("Failed to send agents to relay {*}", {
          relayedNodeAddress,
          relayNodeId,
          error,
        });
      }
      relayConnectedObserver?.(relayedNodeAddress);
    };

    const transport = this.nodeTransportFactory
      ? await this.nodeTransportFactory({
          id: this.id,
          addrs: this.addresses,
          bootstrapRelays: this.bootstrapRelays,
          networkAccessBytes: networkAccessBytesWithKey,
          agentsReceivedCallback,
          peerConnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler,
          messageHandler,
        })
      : await createNode({
          id: this.id,
          addrs: this.addresses,
          bootstrapRelays: this.bootstrapRelays,
          networkAccessBytes: networkAccessBytesWithKey,
          agentsReceivedCallback,
          peerConnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler,
          messageHandler,
        });
    return new PeerkitNode(keyPair, transport, agentStore);
  }
}

export class PeerkitNode {
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;
  readonly keyPair: IKeyPair;

  constructor(
    keyPair: IKeyPair,
    transport: ITransport,
    agentStore: IAgentStore,
  ) {
    this.keyPair = keyPair;
    this.transport = transport;
    this.agentStore = agentStore;
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
