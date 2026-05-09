/**
 * Stable cryptographic identifier for an agent (the agent's public key, opaque string).
 */
export type AgentId = string;

/**
 * Shareable descriptor exchanged between peers.
 */
export interface AgentInfo {
  agentId: AgentId;
  addresses: string[];
  /**
   * Unix timestamp (ms) after which this record should be discarded.
   */
  expiresAt: number;
}

/**
 * In-memory store for {@link AgentInfo} records.
 */
export interface IAgentStore {
  /**
   * Returns all non-expired agents.
   */
  getAll(): AgentInfo[];

  /**
   * Returns the non-expired {@link AgentInfo} for the given id, or undefined.
   */
  get(agentId: AgentId): AgentInfo | undefined;

  /**
   * Stores agents, overwriting any existing record with the same agentId.
   */
  store(agents: AgentInfo[]): void;
}
