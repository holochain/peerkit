/**
 * Opaque node identifier string.
 *
 * The transport uses this type across its public surface to identify peers.
 *
 * Mapping to peerkit AgentId is the responsibility of the caller.
 */
export type NodeId = string;

/**
 * Opaque node address string
 *
 * Every transport implementation parses it according to its own convention,
 * to connect to other nodes.
 */
export type NodeAddress = string;

/**
 * Peerkit-native address for a relay node
 *
 * Every transport implementation parses it according to its own convention.
 */
export type RelayAddress = string;
