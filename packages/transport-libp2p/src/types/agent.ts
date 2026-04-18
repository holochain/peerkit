/**
 * Identifier for an agent
 */
export type AgentId = Uint8Array;

export interface RelayConfig {
  canRelay: boolean;
}

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;
