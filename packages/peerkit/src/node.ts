import { MemoryAgentStore } from "@peerkit/agent-store";
import type {
  AgentInfo,
  AgentInfoSigned,
  IAgentStore,
  IKeyPair,
  ITransport,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  RelayAddress,
} from "@peerkit/api";
import { createNode } from "@peerkit/transport-libp2p";
import { AgentKeyPair } from "./agent.js";
import {
  deserializeAgentInfoList,
  serializeAgentInfoCanonical,
  serializeAgentInfoList,
} from "./serialize.js";
import { getLogger, type Logger } from "@logtape/logtape";

export type PeerkitCreateOptions = {
  id?: string;
  networkAccessHandler: NetworkAccessHandler;
  messageHandler: MessageHandler;
  bootstrapRelays: RelayAddress[];
  networkAccessBytes?: NetworkAccessBytes;
};

export class PeerkitNode {
  private readonly logger: Logger;
  readonly transport: ITransport;
  readonly agentStore: IAgentStore;
  readonly keyPair: IKeyPair;

  private constructor(
    logger: Logger,
    keyPair: IKeyPair,
    transport: ITransport,
    agentStore: IAgentStore,
  ) {
    this.keyPair = keyPair;
    this.transport = transport;
    this.agentStore = agentStore;
    this.logger = logger;
  }

  static async create(options: PeerkitCreateOptions): Promise<PeerkitNode> {
    const keyPair = new AgentKeyPair();
    const agentStore = new MemoryAgentStore();
    const logger = getLogger(["peerkit", "node"]).with({
      id: options.id,
      agentId: keyPair.agentId(),
    });
    const transport = await createNode({
      id: options.id,
      bootstrapRelays: options.bootstrapRelays,
      networkAccessBytes: options.networkAccessBytes,
      agentsReceivedCallback: async (_, bytes) => {
        agentStore.store(deserializeAgentInfoList(bytes));
      },
      peerConnectedCallback: (_nodeId) => {},
      connectedToRelayCallback: async (relayAddress, relayNodeId) => {
        const agentId = keyPair.agentId();
        const existing = agentStore.get(agentId);
        const addresses = [...(existing?.addresses ?? []), relayAddress];
        const expiresAt = Date.now() + 60_000;
        const agentInfo: AgentInfo = {
          agentId,
          addresses,
          expiresAt,
        };
        const agentInfoSigned: AgentInfoSigned = {
          signature: keyPair.sign(serializeAgentInfoCanonical(agentInfo)),
          ...agentInfo,
        };
        const agentInfos = [agentInfoSigned];
        // Store own agent info in agent store.
        agentStore.store(agentInfos);

        // Send own agent info to relay.
        const agentInfoBytes = serializeAgentInfoList(agentInfos);
        try {
          await transport.sendAgents(relayNodeId, agentInfoBytes);
        } catch (error) {
          logger.error("Failed to send agents to relay {*}", {
            relayAddress,
            relayNodeId,
            error,
          });
        }
      },
      networkAccessHandler: options.networkAccessHandler,
      messageHandler: options.messageHandler,
    });
    return new PeerkitNode(logger, keyPair, transport, agentStore);
  }

  async shutDown(): Promise<void> {
    await this.transport.shutDown();
  }
}
