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

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;
