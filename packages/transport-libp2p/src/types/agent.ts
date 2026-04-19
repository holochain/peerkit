import type { Multiaddr } from "@multiformats/multiaddr";

/**
 * Identifier for an agent
 */
export type AgentId = Uint8Array;

/**
 * Address to dial a peer
 */
export interface IAgentInfo {
  id: AgentId;
  addr: Multiaddr;
}

export interface RelayConfig {
  canRelay: boolean;
}
