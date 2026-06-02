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
 * These addresses are mainly handled internally by the transport.
 */
export type NodeAddress = string;

/**
 * Peerkit-native address for a relay node
 *
 * Every transport implementation parses it according to its own convention.
 * These addresses are mainly handled internally by the transport.
 */
export type RelayDialAddress = string;

/**
 * A relay's listening address of format `host:port`
 *
 * The address the relay is supposed to listen at locally. It is parsed
 * by the transport to construct the address in the format required by the
 * transport.
 *
 * # Examples
 *
 * `123.45.67.89:9000`
 */
export type RelayListenAddress = string;
