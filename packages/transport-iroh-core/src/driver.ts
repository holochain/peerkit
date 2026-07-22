import type { NodeId, NodeAddress } from "@peerkit/api";

/**
 * The set of iroh primitives the peerkit transport is built on, with the native
 * binding hidden behind it. Each platform (Node, mobile, browser) supplies its
 * own implementation, so the transport itself never talks to iroh directly.
 */
export interface IrohDriver {
  /** This node's own identifier. */
  getNodeId(): NodeId;

  /** This node's dialable address, to hand out so others can reach it. */
  getNodeAddress(): NodeAddress;

  /** Dial a peer by its address and return the open connection. */
  connect(address: NodeAddress): Promise<IrohConnection>;

  /**
   * Wait for the next peer to dial us. Rejects once the driver is closed, so a
   * loop that keeps calling this ends cleanly on shutdown.
   */
  accept(): Promise<IrohConnection>;

  /** Shut the node down and drop every connection. */
  close(): Promise<void>;
}

/** A live connection to one peer, able to carry many streams at once. */
export interface IrohConnection {
  /** The peer on the other end. */
  remoteNodeId(): NodeId;

  /** True once traffic runs over a direct path, false while it is still relayed. */
  isDirect(): boolean;

  /** Open a new stream to the peer. */
  openStream(): Promise<IrohStream>;

  /** Wait for the peer to open the next stream. */
  acceptStream(): Promise<IrohStream>;

  /** Close the whole connection, not just a single stream. */
  close(): void;
}

/** A two-way byte stream inside a connection. */
export interface IrohStream {
  /** Send bytes to the peer. */
  write(data: Uint8Array): Promise<void>;

  /** Signal we are done sending; the peer then sees the end of the stream. */
  finishWrite(): Promise<void>;

  /** Read the next chunk, or null once the peer has finished sending. */
  read(): Promise<Uint8Array | null>;

  /** Read everything the peer sends until it finishes, up to `sizeLimit` bytes. */
  readToEnd(sizeLimit: number): Promise<Uint8Array>;

  /** Tell the peer to stop sending. */
  stopRead(): Promise<void>;
}
