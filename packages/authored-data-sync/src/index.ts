/**
 * @packageDocumentation
 *
 * Authored-data sync for Peerkit.
 *
 * This package synchronizes content-addressed blobs across peers using a
 * pull-based protocol on `/peerkit/authored-data-sync/v1`. Each blob is
 * attributed to an `AgentId` and persisted in a store that's described
 * by an `IAuthoredDataSyncStore`.
 *
 * ## Core concepts
 *
 * **Blobs** are opaque binary values identified by their hash. Storing
 * the same bytes twice is idempotent. The hash is the canonical identity.
 *
 * **Epoch** partitions time into a fixed-width window (default: one calendar
 * day). During each pull round a node's blobs are classified as *recent*
 * (current epoch) or *historical* (before current epoch). This enables more
 * resourceful comparison of hashes, with historical data likely remaining
 * stably in sync, while recent data frequently changes but is cheaper to
 * compare because of limited volume.
 *
 * **XOR summaries** reduce a set of 32-byte hashes to a single 32-byte
 * fingerprint by XOR-ing them together. Matching summaries mean the sets are
 * identical and no transfer is needed for that segment. They back the
 * *historical* segment only.
 *
 * **`authoredAt` timestamp** backs the *recent* segment. Each blob carries an
 * author-assigned `authoredAt` timestamp (monotonic per author).
 * Because every peer serves only its own authored data, a node's
 * holdings of an author's recent data form a gap-free prefix in `authoredAt`
 * order. The initiator can request "everything strictly after my latest
 * `authoredAt`" and the responder replies with just that delta instead of
 * re-sending the whole segment on any mismatch. A same-`authoredAt` sibling the
 * initiator has not yet seen is skipped by the recent delta, but not lost: once
 * the epoch advances it becomes historical and the XOR reconciliation delivers
 * it.
 *
 * ## Pull protocol
 *
 * `AuthoredDataSync` periodically opens a pull stream to each connected peer.
 * The initiator (A) pulls the responder's (B) authored data. Two-way sync
 * emerges naturally when both nodes pull from each other at the same
 * cadence.
 *
 * ```
 * A → B  request  { requesterAgentId: A, recentSince, historicalSummary }
 * B → A  blobs    { segment: "recent",     entries: [...] }  (authoredAt >= recentSince)
 * B → A  blobs    { segment: "historical", entries: [...] }  (if summaries differ)
 * B closes stream
 * ```
 *
 * `recentSince` is one past A's latest `authoredAt` among B's recent blobs it
 * already holds (or `epochStart` if none), so B never redundantly re-sends the
 * boundary blob. B replies with recent blobs whose `authoredAt >= recentSince`.
 * `historicalSummary` is A's XOR summary of B's historical authored blobs. B uses
 * it to determine whether to resend the historical segment.
 *
 * All messages are CBOR-encoded `PullMessage` values. Framing is provided by
 * the underlying `IStream` abstraction. The protocol identifier
 * `/peerkit/authored-data-sync/v1` is the sole version signal, no versioning header
 * appears in the payload.
 */
export { AuthoredDataSync } from "./authored-data-sync.js";
export { FullReplicationPolicy as FullReplicationStrategy } from "./distribution.js";
export { MemoryBlobStore } from "./memory-blob-store.js";
export type {
  IAuthoredDataSyncStore,
  IStoredBlob,
  Blob,
} from "./types/store.js";
