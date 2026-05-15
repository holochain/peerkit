import { getLogger } from "@logtape/logtape";
import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentsReceivedCallback,
  IAgentStore,
  IKeyPair,
  ITransport,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  NodeAddress,
  PeerConnectedCallback,
  RelayAddress,
} from "@peerkit/api";
import { createNode, type CreateNodeOptions } from "@peerkit/transport-libp2p";
import { AgentKeyPair } from "./agent.js";
import { buildOwnAgentInfo } from "./agent-info.js";
import { getAgentsReceivedCallback } from "./common.js";
import { serializeAgentInfoList } from "./serialize.js";

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
 *   messageHandler: async (nodeId, data) => { ... },
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

  readonly networkAccessHandler: NetworkAccessHandler;
  readonly messageHandler: MessageHandler;

  constructor({
    networkAccessHandler,
    messageHandler,
  }: {
    networkAccessHandler: NetworkAccessHandler;
    messageHandler: MessageHandler;
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

  async build(): Promise<PeerkitNode> {
    const keyPair = new AgentKeyPair();
    const agentStore = this.agentStore ?? new MemoryAgentStore();
    const logger = getLogger(["peerkit", "node"]).with({
      id: this.id,
      agentId: keyPair.agentId(),
    });
    const agentsReceivedCallback: AgentsReceivedCallback =
      getAgentsReceivedCallback(logger, agentStore);
    const peerConnectedCallback: PeerConnectedCallback = async (nodeId) => {
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
    const connectedToRelayCallback = async (
      relayedNodeAddress: NodeAddress,
      relayNodeId: string,
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
    };
    const transport = this.nodeTransportFactory
      ? await this.nodeTransportFactory({
          id: this.id,
          addrs: this.addresses,
          bootstrapRelays: this.bootstrapRelays,
          networkAccessBytes: this.networkAccessBytes,
          agentsReceivedCallback,
          peerConnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler: this.networkAccessHandler,
          messageHandler: this.messageHandler,
        })
      : await createNode({
          id: this.id,
          addrs: this.addresses,
          bootstrapRelays: this.bootstrapRelays,
          networkAccessBytes: this.networkAccessBytes,
          agentsReceivedCallback,
          peerConnectedCallback,
          connectedToRelayCallback,
          networkAccessHandler: this.networkAccessHandler,
          messageHandler: this.messageHandler,
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
