import type { NodeAddress } from "./primitives.js";

/**
 * Stable cryptographic identifier for an agent (the agent's public key, opaque string).
 */
export type AgentId = string;

/**
 * Agent key pair for signing.
 */
export interface IKeyPair {
  /**
   * Returns this agent's identifier encoded as a string.
   */
  agentId(): AgentId;

  /**
   * Signs data with the agent's private key.
   */
  sign(data: Uint8Array): Uint8Array;
}

/**
 * Shareable descriptor exchanged between peers.
 */
export interface AgentInfo {
  /**
   * The agent's unique identifier
   */
  agentId: AgentId;
  /**
   * Transport-specific addresses where this agent can be dialed.
   */
  addresses: NodeAddress[];
  /**
   * Unix timestamp (ms) after which this record should be discarded.
   */
  expiresAt: number;
}

/**
 * {@link AgentInfo} signed by the agent.
 */
export interface AgentInfoSigned extends AgentInfo {
  /**
   * Ed25519 signature over the canonical encoding of the remaining properties.
   * Verify using the public key encoded in {@link agentId}.
   */
  signature: Uint8Array;
}

/**
 * Factory that creates an {@link IAgentStore} instance.
 */
export type AgentStoreFactory = () => IAgentStore;

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
