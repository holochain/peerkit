import type { AgentId, AgentInfoSigned, IAgentStore } from "@peerkit/api";
import { MemoryAgentStore } from "@peerkit/agent-store";
import { PeerkitNodeBuilder, type PeerkitNode } from "@peerkit/peerkit";
import { createTextMessageHandler, sendTextMessage } from "./messaging.js";

export interface NodeEventCallbacks {
  onPeerConnected(alias: string, fromAgent: AgentId): void;
  onPeerDisconnected(alias: string): void;
  onAgentsReceived(agentIds: AgentId[]): void;
  onMessageReceived(alias: string, text: string): void;
  onRelayConnected(address: string): void;
}

export interface NodeSession {
  node: PeerkitNode;
  myAgentId: AgentId;
  sendText(alias: string, text: string): Promise<void>;
  listPeers(): Array<{
    alias: string;
    agentId: AgentId;
    connected: boolean;
    connectionType: "direct" | "relayed" | null;
  }>;
  shutdown(): Promise<void>;
}

// AgentStore subclass that fires a callback whenever agents are stored,
// enabling alias assignment for peers discovered via relay broadcast.
class ObservableAgentStore extends MemoryAgentStore {
  constructor(private readonly onStored: (agents: AgentInfoSigned[]) => void) {
    super();
  }

  store(agents: AgentInfoSigned[]): void {
    super.store(agents);
    this.onStored(agents);
  }
}

export async function startNode(options: {
  bootstrapRelays: string[];
  callbacks: NodeEventCallbacks;
}): Promise<NodeSession> {
  let nextAlias = 1;
  const aliasToAgent = new Map<string, AgentId>();
  const agentToAlias = new Map<AgentId, string>();
  const connectedAgents = new Set<AgentId>();

  const agentStore: IAgentStore = new ObservableAgentStore((agents) => {
    for (const agent of agents) {
      assignAlias(agent.agentId);
    }
  });

  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: createTextMessageHandler((fromAgent, text) => {
      // assignAlias here covers a timing race: peerConnectedCallback is
      // fire-and-forget, so the first message on a new stream can arrive
      // before peerConnectedObserver has run and assigned the alias.
      assignAlias(fromAgent);
      const alias = agentToAlias.get(fromAgent);
      if (alias !== undefined) {
        options.callbacks.onMessageReceived(alias, text);
      } else {
        throw new Error(
          `Received message from an agent without alias. This should never happen. alias = ${alias}`,
        );
      }
    }),
  })
    .withAgentStore(agentStore)
    .withBootstrapRelays(options.bootstrapRelays)
    .withAgentsReceivedObserver((agentIds) => {
      // Aliases are already assigned in ObservableAgentStore.store().
      // Skip own agent ID before surfacing the list to the caller.
      const peerIds = agentIds.filter((id) => id !== myAgentId);
      if (peerIds.length > 0) {
        options.callbacks.onAgentsReceived(peerIds);
      }
    })
    .withPeerConnectedObserver((fromAgent) => {
      // Assign alias eagerly — the peer may have dialed us directly.
      assignAlias(fromAgent);
      connectedAgents.add(fromAgent);
      const alias = agentToAlias.get(fromAgent);
      if (alias !== undefined) {
        options.callbacks.onPeerConnected(alias, fromAgent);
      }
    })
    .withPeerDisconnectedObserver((fromAgent) => {
      connectedAgents.delete(fromAgent);
      const alias = agentToAlias.get(fromAgent);
      if (alias !== undefined) {
        options.callbacks.onPeerDisconnected(alias);
      }
    })
    .withRelayConnectedObserver((address) => {
      options.callbacks.onRelayConnected(address);
    })
    .build();

  // assignAlias is declared here so myAgentId can be const. Function
  // declarations are hoisted, so the callbacks above can reference it safely,
  // They are only ever called after build() returns.
  const myAgentId = node.keyPair.agentId();

  function assignAlias(agentId: AgentId): void {
    if (agentId === myAgentId) return;
    if (agentToAlias.has(agentId)) return;
    const alias = String(nextAlias++);
    aliasToAgent.set(alias, agentId);
    agentToAlias.set(agentId, alias);
  }

  return {
    node,
    myAgentId,

    async sendText(alias: string, text: string): Promise<void> {
      const agentId = aliasToAgent.get(alias);
      if (agentId === undefined) {
        throw new Error(`Unknown alias: ${alias}`);
      }
      if (!connectedAgents.has(agentId)) {
        const info = agentStore.get(agentId);
        const address = info?.addresses[0];
        if (!address) {
          throw new Error(`No address known for alias ${alias}`);
        }
        await node.transport.connect(address);
        // transport.connect() resolves after the access handshake, so
        // sendTextMessage() is safe immediately. connectedAgents is updated
        // asynchronously by peerConnectedObserver.
        connectedAgents.add(agentId);
      }
      await sendTextMessage(node, agentId, text);
    },

    listPeers() {
      return Array.from(aliasToAgent.entries())
        .filter(([, agentId]) => agentId !== myAgentId)
        .map(([alias, agentId]) => {
          const connected = connectedAgents.has(agentId);
          const connectionType = connected
            ? node.isDirectConnection(agentId)
              ? "direct"
              : "relayed"
            : null;
          return { alias, agentId, connected, connectionType };
        });
    },

    async shutdown(): Promise<void> {
      await node.shutDown();
    },
  };
}
