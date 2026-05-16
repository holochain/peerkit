import { getLogger } from "@logtape/logtape";
import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentId,
  AgentsReceivedCallback,
  IAgentStore,
  ITransport,
  NetworkAccessBytes,
  NetworkAccessHandler,
  PeerConnectedCallback,
} from "@peerkit/api";
import {
  createRelay,
  type CreateRelayOptions,
} from "@peerkit/transport-libp2p";
import {
  getAgentsReceivedCallback,
  type AgentsReceivedObserver,
} from "./common.js";
import { serializeAgentInfoList } from "./serialize.js";

export type PeerkitRelayTransportFactory = (
  options: CreateRelayOptions,
) => Promise<ITransport>;

/**
 * Builds a {@link PeerkitRelay}.
 *
 * `networkAccessHandler` is required; everything else is optional and can be
 * supplied via the fluent setters before calling {@link build}.
 *
 * @example
 * ```ts
 * const relay = await new PeerkitRelayBuilder(async () => true)
 *   .withId("relay")
 *   .withAddresses(["/ip4/0.0.0.0/tcp/9000"])
 *   .build();
 * ```
 */
export class PeerkitRelayBuilder {
  networkAccessHandler: NetworkAccessHandler;
  id?: string;
  addresses?: string[];
  networkAccessBytes?: NetworkAccessBytes;
  agentStore?: IAgentStore;
  relayTransportFactory?: PeerkitRelayTransportFactory;
  agentsReceivedObserver?: (agentIds: AgentId[]) => void;

  constructor(networkAccessHandler: NetworkAccessHandler) {
    this.networkAccessHandler = networkAccessHandler;
  }

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withAddresses(addresses: string[]): this {
    this.addresses = addresses;
    return this;
  }

  withNetworkAccessBytes(networkAccessBytes: NetworkAccessBytes): this {
    this.networkAccessBytes = networkAccessBytes;
    return this;
  }

  withAgentStore(agentStore: IAgentStore): this {
    this.agentStore = agentStore;
    return this;
  }

  withTransportFactory(factory: PeerkitRelayTransportFactory): this {
    this.relayTransportFactory = factory;
    return this;
  }

  withAgentsReceivedObserver(fn: (agentIds: AgentId[]) => void): this {
    this.agentsReceivedObserver = fn;
    return this;
  }

  async build(): Promise<PeerkitRelay> {
    const agentStore = this.agentStore ?? new MemoryAgentStore();
    const logger = getLogger(["peerkit", "relay"]).with({
      id: this.id,
    });
    const userAgentsObserver = this.agentsReceivedObserver;
    const wrappedObserver: AgentsReceivedObserver | undefined =
      userAgentsObserver
        ? (_fromNode, agentInfos) =>
            userAgentsObserver(agentInfos.map((info) => info.agentId))
        : undefined;
    const agentsReceivedCallback: AgentsReceivedCallback =
      getAgentsReceivedCallback(logger, agentStore, wrappedObserver);
    const peerConnectedCallback: PeerConnectedCallback = async (
      nodeId,
      transport,
    ) => {
      const agents = agentStore.getAll();
      if (agents.length > 0) {
        try {
          await transport.sendAgents(nodeId, serializeAgentInfoList(agents));
        } catch (error) {
          logger.error("Failed to send agents to recently connected peer {*}", {
            nodeId,
            error,
          });
        }
      }
    };
    const transport = this.relayTransportFactory
      ? await this.relayTransportFactory({
          agentsReceivedCallback,
          peerConnectedCallback,
          networkAccessHandler: this.networkAccessHandler,
          addrs: this.addresses,
          id: this.id,
          networkAccessBytes: this.networkAccessBytes,
        })
      : await createRelay({
          id: this.id,
          addrs: this.addresses,
          networkAccessBytes: this.networkAccessBytes,
          agentsReceivedCallback,
          peerConnectedCallback,
          networkAccessHandler: this.networkAccessHandler,
        });
    return new PeerkitRelay(transport, agentStore);
  }
}

export class PeerkitRelay {
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;

  constructor(transport: ITransport, agentStore: IAgentStore) {
    this.transport = transport;
    this.agentStore = agentStore;
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
