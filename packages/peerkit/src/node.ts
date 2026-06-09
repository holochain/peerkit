import { getLogger, type Logger } from "@logtape/logtape";
import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentId,
  AgentsReceivedCallback,
  IAgentKeyStore,
  IAgentStore,
  IKeyPair,
  INodeModule,
  IPeerkitNode,
  IStream,
  ITransport,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  NodeAddress,
  NodeId,
  PeerConnectedCallback,
  PeerDisconnectedCallback,
  RelayDialAddress,
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

const DEFAULT_ICE_SERVER_URLS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.services.mozilla.com:3478",
];

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
 *   agentKeyStore,
 *   networkAccessHandler: async () => true,
 *   messageHandler: async (fromAgent, data) => { ... },
 * })
 *   .withId("node1")
 *   .withBootstrapRelays([relayAddress])
 *   .build();
 * ```
 */
export class PeerkitNodeBuilder {
  bootstrapRelays: RelayDialAddress[] = [];
  id?: string;
  addresses?: NodeAddress[];
  iceServerUrls?: string[];
  networkAccessBytes?: NetworkAccessBytes;
  agentStore?: IAgentStore;
  nodeTransportFactory?: PeerkitNodeTransportFactory;
  agentsReceivedObserver?: (agentIds: AgentId[]) => void;
  peerConnectedObserver?: (fromAgent: AgentId) => void;
  peerDisconnectedObserver?: (fromAgent: AgentId) => void;
  connectedToRelayObserver?: (address: NodeAddress) => void;
  private readonly modules: INodeModule[] = [];

  readonly networkAccessHandler: NetworkAccessHandler;
  readonly messageHandler: AppMessageHandler;
  readonly agentKeyStore: IAgentKeyStore;

  constructor({
    agentKeyStore,
    networkAccessHandler,
    messageHandler,
  }: {
    agentKeyStore: IAgentKeyStore;
    networkAccessHandler: NetworkAccessHandler;
    messageHandler: AppMessageHandler;
  }) {
    this.agentKeyStore = agentKeyStore;
    this.networkAccessHandler = networkAccessHandler;
    this.messageHandler = messageHandler;
  }

  withBootstrapRelays(relays: RelayDialAddress[]): this {
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

  withIceServerUrls(urls: string[]): this {
    this.iceServerUrls = urls;
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

  withModule(module: INodeModule): this {
    this.modules.push(module);
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
    // the remote can map NodeId to AgentId at handshake time.
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
      ? (_fromNode, agentInfos) => {
          appAgentsObserver(agentInfos.map((info) => info.agentId));
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
    const keyPair = await AgentKeyPair.load_or_create(this.agentKeyStore);
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

    const AGENT_INFO_TTL_MS = 15 * 60 * 1000; // 15 minutes
    // Renew well before expiry so peers always have a live entry.
    const RENEWAL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

    // Tracks relay connections, so the renewal timer can re-send fresh agent
    // info to each relay the node is connected to.
    const relayConnections = new Map<NodeId, ITransport>();

    const signAndSendAgentInfo = async (
      addresses: NodeAddress[],
      relayId: NodeId,
      relayTransport: ITransport,
    ): Promise<void> => {
      const agentInfoSigned = buildOwnAgentInfo(
        keyPair,
        addresses,
        Date.now() + AGENT_INFO_TTL_MS,
      );
      agentStore.store([agentInfoSigned]);
      await relayTransport.sendAgents(
        relayId,
        serializeAgentInfoList([agentInfoSigned]),
      );
    };

    const relayConnectedObserver = this.connectedToRelayObserver;
    const connectedToRelayCallback = async (
      relayedNodeAddress: NodeAddress,
      relayNodeId: NodeId,
      transport: ITransport,
    ) => {
      const existingAgentInfo = agentStore.get(keyPair.agentId());
      const addresses = [
        ...(existingAgentInfo?.addresses ?? []),
        relayedNodeAddress,
      ];
      try {
        await signAndSendAgentInfo(addresses, relayNodeId, transport);
      } catch (error) {
        logger.error("Failed to send agents to relay {*}", {
          relayedNodeAddress,
          relayNodeId,
          error,
        });
      }
      relayConnections.set(relayNodeId, transport);
      relayConnectedObserver?.(relayedNodeAddress);
    };

    const transport = this.nodeTransportFactory
      ? await this.nodeTransportFactory({
          id: this.id,
          addrs: this.addresses,
          iceServerUrls: this.iceServerUrls,
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
          iceServerUrls: this.iceServerUrls || DEFAULT_ICE_SERVER_URLS,
          bootstrapRelays: this.bootstrapRelays,
          networkAccessBytes: networkAccessBytesWithKey,
          agentsReceivedCallback,
          peerConnectedCallback,
          peerDisconnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler,
          messageHandler,
        });

    const renewalTimer = setInterval(() => {
      const ownInfo = agentStore.get(keyPair.agentId());
      if (!ownInfo || relayConnections.size === 0) return;
      for (const [relayId, transport] of relayConnections) {
        if (!transport.isConnected(relayId)) {
          relayConnections.delete(relayId);
          continue;
        }
        signAndSendAgentInfo(ownInfo.addresses, relayId, transport).catch(
          (error) => {
            logger.error("Failed to renew agent info with relay {*}", {
              relayId,
              error,
            });
          },
        );
      }
    }, RENEWAL_INTERVAL_MS);
    // Do not let the interval prevent the process from termination.
    (
      renewalTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();

    const node = new PeerkitNode(
      keyPair,
      transport,
      agentStore,
      agentByNodeId,
      nodeByAgentId,
      renewalTimer,
    );

    try {
      for (const module of this.modules) {
        await node.register(module);
      }
      return node;
    } catch (error) {
      await node.shutDown().catch(() => undefined);
      throw error;
    }
  }
}

export class PeerkitNode implements IPeerkitNode {
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;
  readonly keyPair: IKeyPair;
  private readonly modules: INodeModule[] = [];
  private readonly agentByNodeId: Map<NodeId, AgentId>;
  private readonly nodeByAgentId: Map<AgentId, NodeId>;
  private readonly renewalTimer: ReturnType<typeof setInterval>;

  constructor(
    keyPair: IKeyPair,
    transport: ITransport,
    agentStore: IAgentStore,
    agentByNodeId: Map<NodeId, AgentId>,
    nodeByAgentId: Map<AgentId, NodeId>,
    renewalTimer: ReturnType<typeof setInterval>,
  ) {
    this.keyPair = keyPair;
    this.transport = transport;
    this.agentStore = agentStore;
    this.agentByNodeId = agentByNodeId;
    this.nodeByAgentId = nodeByAgentId;
    this.renewalTimer = renewalTimer;
  }

  async register(module: INodeModule) {
    this.modules.push(module);
    module.init(this);
    await module.start?.();
  }

  get ownAgentId(): AgentId {
    return this.keyPair.agentId();
  }

  async createStream(agentId: AgentId, protocol: string): Promise<IStream> {
    const nodeId = this.nodeByAgentId.get(agentId);
    if (nodeId === undefined) {
      throw new Error(`No connection to agent ${agentId}`);
    }
    return this.transport.createStream(nodeId, protocol);
  }

  registerStreamHandler(
    protocol: string,
    handler: (fromAgent: AgentId, stream: IStream) => void,
  ): void {
    this.transport.registerStreamHandler(protocol, (nodeId, stream) => {
      const agentId = this.agentByNodeId.get(nodeId);
      if (agentId === undefined) {
        stream.close();
        return;
      }
      handler(agentId, stream);
    });
  }

  isConnected(toAgent: AgentId): boolean {
    const nodeId = this.nodeByAgentId.get(toAgent);
    if (nodeId === undefined) return false;
    return this.transport.isConnected(nodeId);
  }

  getConnectedAgents(): AgentId[] {
    return this.transport
      .getConnectedPeers()
      .map((nodeId) => this.agentByNodeId.get(nodeId))
      .filter((agentId) => agentId !== undefined);
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
    clearInterval(this.renewalTimer);
    const stopErrors: unknown[] = [];
    for (const module of this.modules) {
      try {
        module.stop?.();
      } catch (error) {
        stopErrors.push(error);
      }
    }
    await this.transport.shutDown();
    if (stopErrors.length > 0) {
      throw new AggregateError(
        stopErrors,
        "One or more modules failed to stop",
      );
    }
  }
}
