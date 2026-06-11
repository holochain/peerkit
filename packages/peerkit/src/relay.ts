import { getLogger } from "@logtape/logtape";
import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentId,
  AgentsReceivedCallback,
  IAgentStore,
  ITransport,
  NetworkAccessBytes,
  NetworkAccessHandler,
  NodeId,
  PeerConnectedCallback,
  PeerDisconnectedCallback,
  RelayListenAddress,
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
 *   .withAddresses(["0.0.0.0:4001"])
 *   .build();
 * ```
 */
export class PeerkitRelayBuilder {
  networkAccessHandler: NetworkAccessHandler;
  id?: string;
  addresses?: RelayListenAddress[];
  publicIp?: string;
  networkAccessBytes?: NetworkAccessBytes;
  agentStore?: IAgentStore;
  relayTransportFactory?: PeerkitRelayTransportFactory;
  agentsReceivedObserver?: (agentIds: AgentId[]) => void;
  peerConnectedObserver?: (nodeId: NodeId) => void;
  peerDisconnectedObserver?: (nodeId: NodeId) => void;

  constructor(networkAccessHandler: NetworkAccessHandler) {
    this.networkAccessHandler = networkAccessHandler;
  }

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withAddresses(addresses: RelayListenAddress[]): this {
    this.addresses = addresses;
    return this;
  }

  withPublicIp(ip: string): this {
    this.publicIp = ip;
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

  withPeerConnectedObserver(fn: (nodeId: NodeId) => void): this {
    this.peerConnectedObserver = fn;
    return this;
  }

  withPeerDisconnectedObserver(fn: (nodeId: NodeId) => void): this {
    this.peerDisconnectedObserver = fn;
    return this;
  }

  async build(): Promise<PeerkitRelay> {
    const agentStore = this.agentStore ?? new MemoryAgentStore();
    const logger = getLogger(["peerkit", "relay"]).with({
      id: this.id,
    });
    const userAgentsObserver = this.agentsReceivedObserver;
    const connectedPeers = new Set<NodeId>();
    // Late-bound: the transport is constructed after these callbacks, and the
    // agents-received observer only fires once the transport is running.
    // eslint-disable-next-line prefer-const -- reassigned after the transport is built
    let relayTransport: ITransport | undefined;
    const broadcastObserver: AgentsReceivedObserver = (
      fromNode,
      agentInfos,
    ) => {
      // Forward the freshly published info to every other connected peer so a
      // peer that joined before this node learns about it without reconnecting.
      if (relayTransport) {
        const payload = serializeAgentInfoList(agentInfos);
        for (const peer of connectedPeers) {
          if (peer === fromNode) continue;
          relayTransport.sendAgents(peer, payload).catch((error) => {
            logger.error("Failed to forward agents to connected peer {*}", {
              peer,
              error,
            });
          });
        }
      }
      userAgentsObserver?.(agentInfos.map((info) => info.agentId));
    };
    const agentsReceivedCallback: AgentsReceivedCallback =
      getAgentsReceivedCallback(agentStore, broadcastObserver);
    const peerConnectedObserver = this.peerConnectedObserver;
    const peerConnectedCallback: PeerConnectedCallback = async (
      nodeId,
      transport,
    ) => {
      connectedPeers.add(nodeId);
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
      peerConnectedObserver?.(nodeId);
    };
    const peerDisconnectedObserver = this.peerDisconnectedObserver;
    const peerDisconnectedCallback: PeerDisconnectedCallback = async (
      nodeId,
    ) => {
      connectedPeers.delete(nodeId);
      const owned = `/p2p/${nodeId}`;
      for (const info of agentStore.getAll()) {
        if (info.addresses.some((address) => address.includes(owned))) {
          agentStore.delete(info.agentId);
        }
      }
      peerDisconnectedObserver?.(nodeId);
    };
    const transport = this.relayTransportFactory
      ? await this.relayTransportFactory({
          agentsReceivedCallback,
          peerConnectedCallback,
          peerDisconnectedCallback,
          networkAccessHandler: this.networkAccessHandler,
          addrs: this.addresses,
          publicIp: this.publicIp,
          id: this.id,
          networkAccessBytes: this.networkAccessBytes,
        })
      : await createRelay({
          id: this.id,
          addrs: this.addresses,
          publicIp: this.publicIp,
          networkAccessBytes: this.networkAccessBytes,
          agentsReceivedCallback,
          peerConnectedCallback,
          peerDisconnectedCallback,
          networkAccessHandler: this.networkAccessHandler,
        });
    relayTransport = transport;
    return new PeerkitRelay(transport, agentStore, connectedPeers);
  }
}

export class PeerkitRelay {
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;
  readonly connectedPeers: Set<NodeId>;

  constructor(
    transport: ITransport,
    agentStore: IAgentStore,
    connectedPeers: Set<NodeId>,
  ) {
    this.transport = transport;
    this.agentStore = agentStore;
    this.connectedPeers = connectedPeers;
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
