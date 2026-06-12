import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentId, Hash, IDataDistributionPolicy } from "@peerkit/api";
import type {
  Blob,
  IAuthoredDataSyncStore,
  StoredBlob,
} from "@peerkit/api/authored-data-sync";
import { FullReplicationPolicy } from "./distribution.js";

const DEFAULT_MAX_BLOB_SIZE = 1024 * 1024 * 20; // 20 MiB

function constructKey(hash: Hash, author: AgentId) {
  return `${author},${bytesToHex(hash)}`;
}

export class MemoryBlobStore implements IAuthoredDataSyncStore {
  private readonly entries = new Map<
    string, // composite key of [agent,hash]
    { hash: Hash; blob: Blob; author: AgentId; authoredAt: number }
  >();
  private readonly policy: IDataDistributionPolicy;
  private readonly maxBlobSize: number;
  private readonly authoredSubscribers = new Set<(entry: StoredBlob) => void>();
  // Per-author authoring clock: max authoredAt this store has assigned for each
  // author. Seeded lazily from held data so it survives restarts.
  private readonly lastAuthoredAt = new Map<AgentId, number>();

  constructor(
    policy: IDataDistributionPolicy = new FullReplicationPolicy(),
    maxBlobSize: number = DEFAULT_MAX_BLOB_SIZE,
  ) {
    this.policy = policy;
    this.maxBlobSize = maxBlobSize;
  }

  store(blob: Blob, author: AgentId): Hash {
    if (blob.byteLength > this.maxBlobSize) {
      throw new Error(
        `Blob to be stored too large: ${blob.byteLength} > ${this.maxBlobSize}`,
      );
    }
    const hash = this.hash(blob);
    const authoredAt = this.nextAuthoredAt(author);
    this.put(hash, blob, author, authoredAt);
    for (const subscriber of this.authoredSubscribers) {
      subscriber({ hash, blob, author, authoredAt });
    }
    return hash;
  }

  accept(blob: Blob, author: AgentId, authoredAt: number): Hash | null {
    if (blob.byteLength > this.maxBlobSize) {
      return null;
    }
    const hash = this.hash(blob);
    if (!this.policy.willStore(author, hash)) {
      return null;
    }
    // Store the author's authoredAt as-is; never re-stamp locally.
    this.put(hash, blob, author, authoredAt);
    return hash;
  }

  onAuthored(listener: (entry: StoredBlob) => void): () => void {
    this.authoredSubscribers.add(listener);
    return () => this.authoredSubscribers.delete(listener);
  }

  private hash(blob: Blob): Hash {
    return blake2s(blob);
  }

  /**
   * The next authoring timestamp for `author`: the wall clock, clamped up to
   * the last one assigned so own blobs never land below a timestamp a peer has
   * already advanced past.
   */
  private nextAuthoredAt(author: AgentId): number {
    const previous =
      this.lastAuthoredAt.get(author) ??
      this.getLastKnownByAuthor(author)?.authoredAt ??
      0;
    const authoredAt = Math.max(Date.now(), previous);
    this.lastAuthoredAt.set(author, authoredAt);
    return authoredAt;
  }

  private put(
    hash: Hash,
    blob: Blob,
    author: AgentId,
    authoredAt: number,
  ): void {
    const key = constructKey(hash, author);
    // Dedup by hash: hash → content is immutable, so a repeat put of the same
    // hash is a no-op. The author's authoredAt is stored as-is, never
    // re-stamped locally.
    if (!this.entries.has(key)) {
      // Store a copy of the hash and blob, to prevent modification
      // of stored values.
      this.entries.set(key, {
        hash: hash.slice(),
        blob: blob.slice(),
        author,
        authoredAt,
      });
    }
  }

  get(hash: Hash, author: AgentId): StoredBlob | undefined {
    const key = constructKey(hash, author);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      hash: entry.hash.slice(),
      blob: entry.blob.slice(),
      author: entry.author,
      authoredAt: entry.authoredAt,
    };
  }

  getLastKnownByAuthor(author: AgentId): StoredBlob | undefined {
    let latest: StoredBlob | undefined;
    for (const entry of this.entries.values()) {
      if (entry.author !== author) continue;
      if (latest === undefined || entry.authoredAt > latest.authoredAt) {
        latest = {
          hash: entry.hash,
          blob: entry.blob,
          author: entry.author,
          authoredAt: entry.authoredAt,
        };
      }
    }
    return latest;
  }

  getByAuthorSince(author: AgentId, since: number): StoredBlob[] {
    return this.collect(
      (entry) => entry.author === author && entry.authoredAt >= since,
    );
  }

  getByAuthorBefore(author: AgentId, before: number): StoredBlob[] {
    return this.collect(
      (entry) => entry.author === author && entry.authoredAt < before,
    );
  }

  private collect(
    predicate: (entry: {
      hash: Hash;
      blob: Blob;
      author: AgentId;
      authoredAt: number;
    }) => boolean,
  ): StoredBlob[] {
    const results: StoredBlob[] = [];
    for (const entry of this.entries.values()) {
      if (predicate(entry)) {
        results.push(entry);
      }
    }
    // Ordered ascending by authoredAt, as the query contract guarantees.
    return results.sort((a, b) => a.authoredAt - b.authoredAt);
  }
}
