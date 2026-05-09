import type { AgentId, AgentInfo, IAgentStore } from "@peerkit/api";

export class MemoryAgentStore implements IAgentStore {
  private readonly agents = new Map<AgentId, AgentInfo>();
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(pruneIntervalMs = 60_000) {
    this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
    // Don't let this maintenance timer alone keep a Node.js process alive.
    (this.pruneTimer as { unref?: () => void }).unref?.();
  }

  getAll(): AgentInfo[] {
    const now = Date.now();
    const result: AgentInfo[] = [];
    for (const info of this.agents.values()) {
      if (info.expiresAt > now) {
        result.push(info);
      }
    }
    return result;
  }

  get(agentId: AgentId): AgentInfo | undefined {
    const info = this.agents.get(agentId);
    if (!info || info.expiresAt <= Date.now()) return undefined;
    return info;
  }

  store(agents: AgentInfo[]): void {
    const now = Date.now();
    for (const agent of agents) {
      if (agent.expiresAt > now) {
        this.agents.set(agent.agentId, agent);
      }
    }
  }

  prune(): void {
    const now = Date.now();
    for (const [agentId, info] of this.agents) {
      if (info.expiresAt <= now) {
        this.agents.delete(agentId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
  }
}
