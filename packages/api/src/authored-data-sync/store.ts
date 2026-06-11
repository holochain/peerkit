import type { AgentId } from "../agent.js";
import type { Hash } from "../data-sync.js";

/**
 * Opaque data blob distributed by the transport.
 */
export type Blob = Uint8Array;

/**
 * Interface that describes what a stored blob must provide
 */
export interface IStoredBlob {
  /**
   * The hash over the blob bytes
   */
  hash: Hash;
  /**
   * The data blob
   */
  blob: Blob;
  /**
   * Author-assigned timestamp, monotonic per author
   */
  authoredAt: number;
}

/**
 * Interface that a data store needs to implement to manage blobs by their
 * hashes.
 */
export interface IAuthoredDataSyncStore {
  /**
   * Put a blob by an author into the store. Blob bytes are content-deduped by
   * hash (written only once). Each (author, hash) association is recorded
   * independently, so the same bytes can be authored by multiple agents.
   *
   * @param hash The blob's hash
   * @param blob The blob
   * @param author Author of the blob
   * @param authoredAt Author-assigned timestamp of the blob
   */
  put(hash: Hash, blob: Blob, author: AgentId, authoredAt: number): void;

  /**
   * Get a blob by its hash and author.
   *
   * @param hash The blob's hash
   * @param author Author of the blob
   */
  get(hash: Hash, author: AgentId): IStoredBlob | undefined;

  /**
   * The author's most recently authored blob this node holds (max
   * `authoredAt`), or `undefined` if none is held.
   */
  getLastKnownByAuthor(author: AgentId): IStoredBlob | undefined;

  /**
   * Blobs by `author` with `authoredAt >= since`, ascending by `authoredAt`.
   * (recent delta)
   */
  getByAuthorSince(author: AgentId, since: number): IStoredBlob[];

  /**
   * Blobs by `author` with `authoredAt < before`, ascending by `authoredAt`.
   * (historical segment)
   */
  getByAuthorBefore(author: AgentId, before: number): IStoredBlob[];
}
