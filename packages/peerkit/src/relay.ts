import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  IAgentStore,
  ITransport,
  NetworkAccessBytes,
  NetworkAccessHandler,
} from "@peerkit/api";
import { createRelay } from "@peerkit/transport-libp2p";
import { serializeAgentInfoList } from "./serialize.js";
import { getLogger, type Logger } from "@logtape/logtape";
import { getAgentsReceivedCallback } from "./common.js";

export type PeerkitRelayCreateOptions = {
  id?: string;
  addrs?: string[];
  networkAccessHandler: NetworkAccessHandler;
  networkAccessBytes?: NetworkAccessBytes;
};

export class PeerkitRelay {
  private readonly logger;
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;

  constructor(logger: Logger, transport: ITransport, agentStore: IAgentStore) {
    this.logger = logger;
    this.transport = transport;
    this.agentStore = agentStore;
  }

  static async create(
    options: PeerkitRelayCreateOptions,
  ): Promise<PeerkitRelay> {
    const agentStore = new MemoryAgentStore();
    const logger = getLogger(["peerkit", "relay"]).with({
      id: options.id,
    });
    const transport = await createRelay({
      id: options.id,
      addrs: options.addrs,
      networkAccessBytes: options.networkAccessBytes,
      agentsReceivedCallback: getAgentsReceivedCallback(logger, agentStore),
      peerConnectedCallback: async (nodeId) => {
        const agents = agentStore.getAll();
        if (agents.length > 0) {
          try {
            await transport.sendAgents(nodeId, serializeAgentInfoList(agents));
          } catch (error) {
            logger.error(
              "Failed to send agents to recently connected peer {*}",
              { nodeId, error },
            );
          }
        }
      },
      networkAccessHandler: options.networkAccessHandler,
    });
    return new PeerkitRelay(logger, transport, agentStore);
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
