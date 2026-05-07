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

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;

/**
 * Processing hook for incoming access handshakes.
 *
 * The transport awaits this. Return `false` to deny access, `true` to grant it.
 */
export type NetworkAccessHandler = (
  nodeId: NodeId,
  bytes: NetworkAccessBytes,
) => Promise<boolean>;

/**
 * Processing hook for incoming messages from a message stream.
 *
 * The transport awaits this. Return a rejected promise to surface errors.
 */
export type MessageHandler = (
  fromNode: NodeId,
  message: Uint8Array,
) => Promise<void>;

/**
 * Called when a connection to the relay is complete, including the network
 * access handshake, and the node can be contacted through the relay.
 *
 * Provides the relay's address and node ID for full address construction.
 *
 * Fire-and-forget notification. The transport does not await this.
 */
export type ConnectedToRelayCallback = (
  relayAddress: RelayAddress,
  relayNodeId: NodeId,
) => void;

/**
 * Fire-and-forget notification — the transport does not await this.
 *
 * Called when a connection to a peer is complete, including the network
 * access handshake, and the node can exchange data.
 * Provides the node ID as identification.
 */
export type PeerConnectedCallback = (nodeId: NodeId) => void;

/**
 * Processing hook for incoming agent-info bytes.
 *
 * The transport awaits this. Return a rejected promise to surface errors.
 */
export type AgentsReceivedCallback = (
  fromNode: NodeId,
  bytes: Uint8Array,
) => Promise<void>;

/**
 * Interface that defines the methods a peerkit transport needs to implement
 */
export interface ITransport {
  /**
   * Get the transport-level identifier of this node.
   */
  getNodeId(): NodeId;

  /**
   * Establish a connection to a known peer by its full address.
   *
   * If the connection is routed through a relay, the address must include the
   * relay address.
   *
   * @param nodeAddress The dialable address of the node to connect to
   */
  connect(nodeAddress: NodeAddress): Promise<void>;

  /**
   * Send opaque agent-info bytes to a peer.
   * The peer must be connected and have been granted access.
   *
   * @param nodeId The ID of the target node
   * @param agents The list of agents to send to the node
   */
  sendAgents(nodeId: NodeId, agents: Uint8Array): Promise<void>;

  /**
   * Send an opaque application message to a peer.
   * The peer must be connected and have been granted access.
   *
   * @param nodeId The ID of the target node
   * @param message The message to send to the node
   */
  send(nodeId: NodeId, message: Uint8Array): Promise<void>;

  /**
   * Is the connection to the provided node a direct connection?
   *
   * `false` means the connection is relayed.
   *
   * @param nodeId The node ID of the connection to check
   */
  isDirectConnection(nodeId: NodeId): boolean;

  /**
   * Disconnect from the peer.
   *
   * @param nodeId The node ID to disconnect from
   */
  disconnect(nodeId: NodeId): Promise<void>;

  /**
   * Shut down the transport and all underlying connections.
   */
  shutDown(): Promise<void>;
}
