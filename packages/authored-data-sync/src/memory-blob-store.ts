import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentId, Hash } from "@peerkit/api";
import type {
  Blob,
  IAuthoredDataSyncStore,
  IStoredBlob,
} from "@peerkit/api/authored-data-sync";

function constructKey(hash: Hash, author: AgentId) {
  return `${author},${bytesToHex(hash)}`;
}

export class MemoryBlobStore implements IAuthoredDataSyncStore {
  private readonly entries = new Map<
    string, // composite key of [agent,hash]
    { hash: Hash; blob: Blob; author: AgentId; authoredAt: number }
  >();

  put(hash: Hash, blob: Blob, author: AgentId, authoredAt: number): void {
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

  get(hash: Hash, author: AgentId): IStoredBlob | undefined {
    const key = constructKey(hash, author);
    return this.entries.get(key);
  }

  getLastKnownByAuthor(author: AgentId): IStoredBlob | undefined {
    let latest: IStoredBlob | undefined;
    for (const entry of this.entries.values()) {
      if (entry.author !== author) continue;
      if (latest === undefined || entry.authoredAt > latest.authoredAt) {
        latest = {
          hash: entry.hash,
          blob: entry.blob,
          authoredAt: entry.authoredAt,
        };
      }
    }
    return latest;
  }

  getByAuthorSince(author: AgentId, since: number): IStoredBlob[] {
    return this.collect(
      (entry) => entry.author === author && entry.authoredAt >= since,
    );
  }

  getByAuthorBefore(author: AgentId, before: number): IStoredBlob[] {
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
  ): IStoredBlob[] {
    const results: IStoredBlob[] = [];
    for (const entry of this.entries.values()) {
      if (predicate(entry)) {
        results.push({
          hash: entry.hash,
          blob: entry.blob,
          authoredAt: entry.authoredAt,
        });
      }
    }
    // Ordered ascending by authoredAt, as the query contract guarantees.
    return results.sort((a, b) => a.authoredAt - b.authoredAt);
  }
}
