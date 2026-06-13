import { blake2s } from "@noble/hashes/blake2.js";
import type { StoredBlob } from "@peerkit/api/authored-data-sync";
import { expect, test, vi } from "vitest";
import { MemoryBlobStore } from "../src/memory-blob-store.js";

const blob = (text: string) => new TextEncoder().encode(text);

test("Identical blobs can be gotten for multiple agents", () => {
  try {
    vi.useFakeTimers();
    const store = new MemoryBlobStore();
    const blobby = blob("hello");
    const hashy = blake2s(blobby);
    const agentA = "agent-a";
    const agentB = "agent-b";

    vi.setSystemTime(1);
    store.store(blobby, agentA);
    store.store(blobby, agentB);

    const blobsA = store.getByAuthorBefore(agentA, 2);
    const blobsB = store.getByAuthorBefore(agentB, 2);
    expect(blobsA).toStrictEqual([
      { hash: hashy, blob: blobby, author: agentA, authoredAt: 1 },
    ]);
    expect(blobsB).toStrictEqual([
      { hash: hashy, blob: blobby, author: agentB, authoredAt: 1 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("getLastKnownByAuthor returns undefined for an unknown author", () => {
  const store = new MemoryBlobStore();
  expect(store.getLastKnownByAuthor("nobody")).toBeUndefined();
});

test("getLastKnownByAuthor returns the max-authoredAt blob for the author", () => {
  try {
    vi.useFakeTimers();
    const store = new MemoryBlobStore();
    vi.setSystemTime(1);
    store.store(blob("earliest"), "agent-a");
    vi.setSystemTime(2);
    const latestBlob = blob("latest");
    store.store(latestBlob, "agent-a");
    store.store(blob("other author"), "agent-b");

    const latest = store.getLastKnownByAuthor("agent-a");
    expect(latest!.blob).toEqual(latestBlob);
    expect(latest!.authoredAt).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("getByAuthorSince returns only the author's blobs with authoredAt >= since, ascending", () => {
  try {
    vi.useFakeTimers();
    const store = new MemoryBlobStore();
    vi.setSystemTime(5);
    store.store(blob("below"), "agent-a");
    vi.setSystemTime(10);
    store.store(blob("at-boundary"), "agent-a");
    store.store(blob("other"), "agent-b");
    vi.setSystemTime(15);
    store.store(blob("above"), "agent-a");

    const results = store.getByAuthorSince("agent-a", 10);
    // Boundary (10) is included; 5 is excluded; ascending order preserved.
    expect(results.map((r) => r.blob)).toStrictEqual([
      blob("at-boundary"),
      blob("above"),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("getByAuthorBefore returns only the author's blobs with authoredAt < before, ascending", () => {
  try {
    vi.useFakeTimers();
    const store = new MemoryBlobStore();
    vi.setSystemTime(5);
    store.store(blob("earliest"), "agent-a");
    store.store(blob("other"), "agent-b");
    vi.setSystemTime(8);
    store.store(blob("middle"), "agent-a");
    vi.setSystemTime(10);
    store.store(blob("at-boundary"), "agent-a");

    const results = store.getByAuthorBefore("agent-a", 10);
    // Boundary (10) is excluded; results are ascending by authoredAt.
    expect(results.map((r) => r.blob)).toEqual([
      blob("earliest"),
      blob("middle"),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("store() hashes the blob, stamps a wall-clock authoredAt, and fires onAuthored", () => {
  const store = new MemoryBlobStore();
  const authored: StoredBlob[] = [];
  store.onAuthored((entry) => authored.push(entry));

  const blobby = blob("authored");
  const hash = store.store(blobby, "agent-a");

  // The returned hash addresses the stored blob (algorithm stays internal).
  expect(store.get(hash, "agent-a")?.blob).toEqual(blobby);
  expect(authored).toHaveLength(1);
  expect(authored[0]).toMatchObject({ hash, blob: blobby, author: "agent-a" });
});

test("store() clock is non-decreasing per author when the wall clock regresses", () => {
  const store = new MemoryBlobStore();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000);
    store.store(blob("first"), "agent-a");
    vi.setSystemTime(500); // wall clock regresses
    store.store(blob("second"), "agent-a");

    const all = store.getByAuthorSince("agent-a", 0);
    expect(all).toHaveLength(2);
    expect(all.every((b) => b.authoredAt >= 1_000)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("accept() stores a received blob with its authoredAt as-is and does not fire onAuthored", () => {
  const store = new MemoryBlobStore();
  const authored: StoredBlob[] = [];
  store.onAuthored((entry) => authored.push(entry));

  const blobby = blob("received");
  const hash = store.accept(blobby, "agent-b", 42);

  expect(hash).not.toBeNull();
  // The author's authoredAt is preserved, never re-stamped.
  expect(store.get(hash!, "agent-b")?.authoredAt).toBe(42);
  // accept is a receive, not a local authoring, so onAuthored must not fire.
  expect(authored).toHaveLength(0);
});

test("accept() returns null when the distribution policy declines the blob", () => {
  const store = new MemoryBlobStore({ willStore: () => false });
  expect(store.accept(blob("not for me"), "agent-b", 1)).toBeNull();
  expect(store.getLastKnownByAuthor("agent-b")).toBeUndefined();
});

test("accept() returns null when the blob exceeds the max blob size", () => {
  const store = new MemoryBlobStore(undefined, 4);
  expect(store.accept(blob("12345"), "agent-b", 1)).toBeNull();
  expect(store.getLastKnownByAuthor("agent-b")).toBeUndefined();
});

test("onAuthored unsubscribe stops further notifications", () => {
  const store = new MemoryBlobStore();
  const authored: StoredBlob[] = [];
  const unsubscribe = store.onAuthored((entry) => authored.push(entry));

  store.store(blob("one"), "agent-a");
  unsubscribe();
  store.store(blob("two"), "agent-a");

  expect(authored).toHaveLength(1);
});
