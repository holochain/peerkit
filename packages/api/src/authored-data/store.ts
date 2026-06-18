import type { AgentId } from "../agent.js";
import type { Hash } from "../data-sync.js";

/**
 * Opaque data blob distributed by the transport.
 */
export type Blob = Uint8Array;

/**
 * Interface that describes what a stored blob must provide
 */
export type StoredBlob = {
  /**
   * The hash over the blob bytes
   */
  hash: Hash;
  /**
   * The data blob
   */
  blob: Blob;
  /**
   * The author of the blob — always the local node for `onAuthored`.
   */
  author: AgentId;
  /**
   * Author-assigned timestamp, monotonic per author
   */
  authoredAt: number;
};

/**
 * Interface that a data store needs to implement to manage blobs by their
 * hashes.
 *
 * The store is the sole owner of the content-hash algorithm and the monotonic
 * authoring clock. Local authoring goes through {@link store}, blobs
 * received from peers through {@link accept}.
 */
export interface IAuthoredDataSyncStore {
  /**
   * Author a local blob: hash it, assign a monotonic `authoredAt` from the
   * store's clock, persist it under `author`, and notify
   * {@link onAuthored} subscribers.
   *
   * @returns the blob's hash
   * @throws if the blob exceeds the store's maximum blob size
   */
  store(blob: Blob, author: AgentId): Hash;

  /**
   * Persist a blob received from `author` at their `authoredAt`.
   * The store computes the hash and stores if the distribution policy's
   * `willStore` applies.
   *
   * @returns the hash if stored, or `null` if not
   * stored (the policy declined it, or it exceeds the maximum blob size)
   */
  accept(blob: Blob, author: AgentId, authoredAt: number): Hash | null;

  /**
   * Subscribe to locally authored blobs
   *
   * @returns a function that removes the subscription
   */
  onAuthored(listener: (entry: StoredBlob) => void): () => void;

  /**
   * Get a blob by its hash and author.
   *
   * @param hash The blob's hash
   * @param author Author of the blob
   */
  get(hash: Hash, author: AgentId): StoredBlob | undefined;

  /**
   * The author's most recently authored blob this node holds,
   * or `undefined` if none is held.
   */
  getLastKnownByAuthor(author: AgentId): StoredBlob | undefined;

  /**
   * Blobs by `author` with `authoredAt >= since`, ascending by `authoredAt`.
   * (recent delta)
   */
  getByAuthorSince(author: AgentId, since: number): StoredBlob[];

  /**
   * Blobs by `author` with `authoredAt < before`, ascending by `authoredAt`.
   * (historical segment)
   */
  getByAuthorBefore(author: AgentId, before: number): StoredBlob[];
}
