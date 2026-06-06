import { expect, test } from "vitest";
import { MemoryBlobStore } from "../src/memory-blob-store.js";

const hash = (byte: number): Uint8Array => new Uint8Array([byte]);
const blob = (text: string): Uint8Array => new TextEncoder().encode(text);

test("Identical blobs can be gotten for multiple agents", () => {
  const store = new MemoryBlobStore();
  const blobby = blob("hello");
  const hashy = hash(1);
  const agentA = "agent-a";
  const agentB = "agent-b";
  store.put(hashy, blobby, agentA, 1);
  store.put(hashy, blobby, agentB, 1);
  const blobsA = store.getByAuthorBefore(agentA, 2);
  const blobsB = store.getByAuthorBefore(agentB, 2);
  expect(blobsA).toStrictEqual([{ hash: hashy, blob: blobby, authoredAt: 1 }]);
  expect(blobsB).toStrictEqual([{ hash: hashy, blob: blobby, authoredAt: 1 }]);
});

test("Duplicate put does not overwrite the stored blob", () => {
  // hash → content is immutable. A second put with the same
  // hash must be a silent no-op rather than an overwrite.
  const store = new MemoryBlobStore();
  store.put(hash(2), blob("first"), "agent-a", 1);
  store.put(hash(2), blob("second"), "agent-a", 2);
  expect(store.getLastKnownByAuthor("agent-a")).toStrictEqual({
    hash: hash(2),
    blob: blob("first"),
    authoredAt: 1,
  });
});

test("put stores the author-assigned authoredAt as-is", () => {
  // The store must never re-stamp the timestamp locally — the author's
  // authoredAt is what the recent last-known timestamp relies on.
  const store = new MemoryBlobStore();
  store.put(hash(3), blob("data"), "agent-a", 12345);
  expect(store.getLastKnownByAuthor("agent-a")?.authoredAt).toBe(12345);
});

test("getLastKnownByAuthor returns undefined for an unknown author", () => {
  const store = new MemoryBlobStore();
  expect(store.getLastKnownByAuthor("nobody")).toBeUndefined();
});

test("getLastKnownByAuthor returns the max-authoredAt blob for the author", () => {
  // Insert out of order; the result must be the latest by authoredAt, scoped
  // to the requested author only.
  const store = new MemoryBlobStore();
  store.put(hash(4), blob("middle"), "agent-a", 20);
  store.put(hash(5), blob("latest"), "agent-a", 30);
  store.put(hash(6), blob("earliest"), "agent-a", 10);
  store.put(hash(7), blob("other author"), "agent-b", 99);

  const latest = store.getLastKnownByAuthor("agent-a");
  expect(latest?.blob).toEqual(blob("latest"));
  expect(latest?.authoredAt).toBe(30);
});

test("getByAuthorSince returns only the author's blobs with authoredAt >= since, ascending", () => {
  // The epochStart boundary must land in the Since (>=) half, not Before (<).
  const store = new MemoryBlobStore();
  store.put(hash(8), blob("below"), "agent-a", 5);
  store.put(hash(9), blob("at-boundary"), "agent-a", 10);
  store.put(hash(10), blob("above"), "agent-a", 15);
  store.put(hash(11), blob("other"), "agent-b", 12);

  const results = store.getByAuthorSince("agent-a", 10);
  // Boundary (10) is included; 5 is excluded; ascending order preserved.
  expect(results.map((r) => r.blob)).toEqual([
    blob("at-boundary"),
    blob("above"),
  ]);
});

test("getByAuthorBefore returns only the author's blobs with authoredAt < before, ascending", () => {
  // The epochStart boundary must be excluded from the Before (<) half.
  const store = new MemoryBlobStore();
  store.put(hash(12), blob("earliest"), "agent-a", 5);
  store.put(hash(13), blob("middle"), "agent-a", 8);
  store.put(hash(14), blob("at-boundary"), "agent-a", 10);
  store.put(hash(15), blob("other"), "agent-b", 3);

  const results = store.getByAuthorBefore("agent-a", 10);
  // Boundary (10) is excluded; results are ascending by authoredAt.
  expect(results.map((r) => r.blob)).toEqual([
    blob("earliest"),
    blob("middle"),
  ]);
});

test("Since and Before partition an author's blobs at the boundary without gap or overlap", () => {
  // Together the two half-open ranges cover all of an author's data exactly
  // once: the boundary value lands in Since, never Before.
  const store = new MemoryBlobStore();
  store.put(hash(16), blob("a"), "agent-a", 1);
  store.put(hash(17), blob("b"), "agent-a", 10);
  store.put(hash(18), blob("c"), "agent-a", 20);

  const before = store.getByAuthorBefore("agent-a", 10).map((r) => r.blob);
  const since = store.getByAuthorSince("agent-a", 10).map((r) => r.blob);
  expect(before).toEqual([blob("a")]);
  expect(since).toEqual([blob("b"), blob("c")]);
});
