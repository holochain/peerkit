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
  PeerDisconnectedCallback,
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
  agentsReceivedObserver?: (fromAgent: AgentId, agentIds: AgentId[]) => void;
  peerConnectedObserver?: (fromAgent: AgentId) => void;
  peerDisconnectedObserver?: (fromAgent: AgentId) => void;
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

  withAgentsReceivedObserver(
    fn: (fromAgent: AgentId, agentIds: AgentId[]) => void,
  ): this {
    this.agentsReceivedObserver = fn;
    return this;
  }

  withPeerConnectedObserver(fn: (fromAgent: AgentId) => void): this {
    this.peerConnectedObserver = fn;
    return this;
  }

  withPeerDisconnectedObserver(fn: (fromAgent: AgentId) => void): this {
    this.peerDisconnectedObserver = fn;
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
    agentByNodeId: Map<NodeId, AgentId>;
    nodeByAgentId: Map<AgentId, NodeId>;
  } {
    // Bidirectional maps populated during the access handshake before any
    // message stream can open.
    const agentByNodeId = new Map<NodeId, AgentId>();
    const nodeByAgentId = new Map<AgentId, NodeId>();

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
        const agentId = bytesToHex(bytes.subarray(0, publicKeyBytes.length));
        agentByNodeId.set(nodeId, agentId);
        nodeByAgentId.set(agentId, nodeId);
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
      ? (fromNode, agentInfos) => {
          const fromAgent = agentByNodeId.get(fromNode);
          if (fromAgent !== undefined) {
            appAgentsObserver(
              fromAgent,
              agentInfos.map((info) => info.agentId),
            );
          }
        }
      : undefined;

    const agentsReceivedCallback = getAgentsReceivedCallback(
      agentStore,
      agentsObserver,
    );

    return {
      networkAccessBytesWithKey,
      networkAccessHandler,
      messageHandler,
      agentsReceivedCallback,
      agentByNodeId,
      nodeByAgentId,
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
      agentByNodeId,
      nodeByAgentId,
    } = this.buildAgentLayer(keyPair, logger, agentStore);

    const peerConnectedObserver = this.peerConnectedObserver;
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
      const fromAgent = agentByNodeId.get(nodeId);
      if (fromAgent !== undefined) {
        peerConnectedObserver?.(fromAgent);
      }
    };

    const peerDisconnectedObserver = this.peerDisconnectedObserver;
    const peerDisconnectedCallback: PeerDisconnectedCallback = async (
      nodeId,
    ) => {
      const agentId = agentByNodeId.get(nodeId);
      agentByNodeId.delete(nodeId);
      if (agentId !== undefined) {
        nodeByAgentId.delete(agentId);
        peerDisconnectedObserver?.(agentId);
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
          peerDisconnectedCallback,
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
          peerDisconnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler,
          messageHandler,
        });
    return new PeerkitNode(keyPair, transport, agentStore, nodeByAgentId);
  }
}

export class PeerkitNode {
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;
  readonly keyPair: IKeyPair;
  private readonly nodeByAgentId: Map<AgentId, NodeId>;

  constructor(
    keyPair: IKeyPair,
    transport: ITransport,
    agentStore: IAgentStore,
    nodeByAgentId: Map<AgentId, NodeId>,
  ) {
    this.keyPair = keyPair;
    this.transport = transport;
    this.agentStore = agentStore;
    this.nodeByAgentId = nodeByAgentId;
  }

  isDirectConnection(toAgent: AgentId): boolean {
    const nodeId = this.nodeByAgentId.get(toAgent);
    if (nodeId === undefined) {
      throw new Error(`No connection to agent ${toAgent}`);
    }
    return this.transport.isDirectConnection(nodeId);
  }

  async send(toAgent: AgentId, message: Uint8Array): Promise<void> {
    const nodeId = this.nodeByAgentId.get(toAgent);
    if (nodeId === undefined) {
      throw new Error(`No connection to agent ${toAgent}`);
    }
    await this.transport.send(nodeId, message);
  }

  async sendAgents(toAgent: AgentId, agents: Uint8Array): Promise<void> {
    const nodeId = this.nodeByAgentId.get(toAgent);
    if (nodeId === undefined) {
      throw new Error(`No connection to agent ${toAgent}`);
    }
    await this.transport.sendAgents(nodeId, agents);
  }

  async disconnect(fromAgent: AgentId): Promise<void> {
    const nodeId = this.nodeByAgentId.get(fromAgent);
    if (nodeId === undefined) {
      throw new Error(`No connection to agent ${fromAgent}`);
    }
    await this.transport.disconnect(nodeId);
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
