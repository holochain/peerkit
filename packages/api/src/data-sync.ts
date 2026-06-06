import type { AgentId } from "./agent.js";

/**
 * Content-addressable identity of a blob. Caller-supplied hash bytes.
 */
export type Hash = Uint8Array;

/**
 * Pluggable data distribution policy
 */
export interface IDataDistributionPolicy {
  /**
   * Consulted for data sync to decide which blobs to send to which peers.
   * Receives the content hash (sufficient for hash-based routing such as DHT).
   */
  willStore(peerId: AgentId, blobHash: Hash): boolean;
}
