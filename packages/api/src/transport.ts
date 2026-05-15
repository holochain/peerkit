import type { NodeId, NodeAddress, RelayAddress } from "./primitives.js";
export type { NodeId, NodeAddress, RelayAddress };

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
 * Fire-and-forget notification. The transport does not await this, but logs
 * errors.
 */
export type ConnectedToRelayCallback = (
  relayAddress: RelayAddress,
  relayNodeId: NodeId,
) => Promise<void>;

/**
 *
 * Called when a connection to a peer is complete, including the network
 * access handshake, and the node can exchange data.
 *
 * Provides the node ID as identification.
 *
 * Fire-and-forget notification. The transport does not await this, but logs
 * errors.
 */
export type PeerConnectedCallback = (nodeId: NodeId) => Promise<void>;

/**
 * Processing hook for incoming agent-info bytes.
 *
 * The transport awaits this. Return a rejected promise to surface errors.
 */
export type AgentsReceivedCallback = (
  fromNode: NodeId,
  bytes: Uint8Array,
) => Promise<void>;

export interface PeerkitStreamEvents {
  /**
   * Data was received from the remote end of the message stream
   */
  message: (message: Uint8Array) => void;

  /**
   * The remote has closed their end of the stream.
   */
  remoteClose: (event: Event) => void;

  /**
   * The underlying resource is closed - no further events will be emitted and
   * the stream cannot be used to send or receive any more data.
   */
  close: (error?: Error) => void;
}

/**
 * A bi-directional byte stream that allows for sending an receiving any kind
 * of data.
 */
export interface IStream {
  /**
   * Send data over the stream.
   */
  send(data: Uint8Array): void;

  /**
   * Register an event listener for the stream.
   */
  addEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void;

  /**
   * Remove an event listener from the stream.
   */
  removeEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void;

  /**
   * Is this stream open?
   */
  isOpen(): boolean;

  /**
   * Close the stream.
   */
  close(): Promise<void>;
}

/**
 * A callback for when a stream described by a custom protocol was created
 * by a peer.
 */
export type CustomStreamCreatedCallback = (stream: IStream) => void;

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
   * Create a new bi-directional byte stream on an open connection.
   *
   * Allows for reusing an open connection for exchaning any kind of data,
   * e.g. audio or video data.
   *
   * @param nodeId The node ID of the connection to create a stream for
   * @param protocol The name and version of the stream protocol
   */
  createStream(nodeId: NodeId, protocol: string): Promise<IStream>;

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
