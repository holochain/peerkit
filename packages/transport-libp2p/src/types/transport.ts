/**
 * Opaque node identifier string.
 * The transport uses this type across its public surface to identify peers.
 *
 * Mapping to peerkit AgentId is the responsibility of the caller.
 */
export type NodeId = string;

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;

/**
 * Peerkit-native address for a relay node.
 *
 * Every transport implementation parses it according to its own convention.
 */
export type RelayAddress = string;

/**
 * Interface to handle incoming access streams.
 *
 * An access stream uses the {@link CURRENT_ACCESS_PROTOCOL} and expects
 * the Network Access Bytes as the first and only message, to check if
 * a peer has access to the network or not.
 */
export type NetworkAccessHandler = (
  nodeId: NodeId,
  bytes: NetworkAccessBytes,
) => Promise<boolean>;

/**
 * Interface to handle incoming messages from a message stream.
 */
export type MessageHandler = (
  fromNode: NodeId,
  message: Uint8Array,
) => Promise<void>;

/**
 * Called when the circuit relay reservation is established and the node
 * can be contacted through the relay.
 */
export type ConnectedToRelayHandler = () => void;

/**
 * Callback to call when agents have been received from another node.
 */
export type AgentsReceivedCallback = (
  fromNode: NodeId,
  bytes: Uint8Array,
) => Promise<void>;

/**
 * Interface that defines the methods a peerkit transport needs to implement.
 */
export interface ITransport {
  /**
   * Get the transport-level identifier of this node.
   */
  getNodeId(): NodeId;

  /**
   * Establish a connection to a known peer. Throws if the peer is unknown.
   */
  connect(nodeId: NodeId, bytes: NetworkAccessBytes): Promise<void>;

  /**
   * Send opaque agent-info bytes to a peer.
   * The peer must be connected and have been granted access.
   */
  sendAgents(nodeId: NodeId, data: Uint8Array): Promise<void>;

  /**
   * Send an opaque application message to a peer.
   * The peer must be connected and have been granted access.
   */
  send(nodeId: NodeId, data: Uint8Array): Promise<void>;

  /**
   * Shut down the transport and all underlying connections.
   */
  shutDown(): Promise<void>;
}
