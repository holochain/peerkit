import { reset } from "@logtape/logtape";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AgentId, Hash } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AuthoredDataSync,
  FullReplicationStrategy,
  MemoryBlobStore,
} from "../src/index.js";
import { createMockPeer, makeStreamPair, MockNode } from "./mock-node.js";

const AUTHORED_DATA_SYNC_PROTOCOL = "/peerkit/authored-data-sync/v1";
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(setupTestLogger);
afterEach(reset);

test("A pulls B's authored blob in a single pull round", async () => {
  // A pulls with B. The protocol pulls B's authored data that A is missing,
  // so one pullFromAllPeers() on A is sufficient for A to receive B's blob.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  a.node.addPeer(b.node);

  const hash = b.dataSync.store(enc("hello from B"));

  await a.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hash, b.node.ownAgentId)!.blob).toEqual(
    enc("hello from B"),
  );
});

test("Pull responses return blobs since recent timestamp", async () => {
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    // 10 s epoch so all blobs stay in the recent segment.
    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      5_000,
      10_000,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      5_000,
      10_000,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    vi.setSystemTime(1_000);
    syncB.store(enc("r1"));
    vi.setSystemTime(2_000);
    syncB.store(enc("r2")); // will be the recentSince timestamp

    vi.setSystemTime(2_500);
    // A receives all blobs
    await syncA.pullFromAllPeers();
    expect(storeA.getByAuthorSince("agent-b", 0)).toHaveLength(2);

    const acceptSpy = vi.spyOn(storeA, "accept");
    // A should only receive the most recent blob again, since that's the
    // last authoredAt timestamp.
    await syncA.pullFromAllPeers();

    expect(acceptSpy).to.toHaveBeenCalledOnce();
    expect(acceptSpy.mock.calls[0][2]).toEqual(2_000);
    expect(storeA.getByAuthorSince("agent-b", 0)).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("Blobs from before and after the epoch boundary are pulled", async () => {
  // Use a 1-second epoch so the boundary falls between the two stored blobs.
  // Blobs stored at t = 500 are historical; blobs at t = 1500 are recent relative
  // to the epoch boundary at t = 1000. Both must reach A after one pull round.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    vi.setSystemTime(500); // below the epoch boundary
    const hashHist = syncB.store(enc("historical blob"));

    vi.setSystemTime(1_500); // above the epoch boundary
    const hashRecent = syncB.store(enc("recent blob"));

    vi.setSystemTime(1_800); // epochStart = Math.floor(1800 / 1000) * 1000 = 1000
    await syncA.pullFromAllPeers();

    expect(syncA.get(hashHist, nodeB.ownAgentId)!.blob).toEqual(
      enc("historical blob"),
    );
    expect(syncA.get(hashRecent, nodeB.ownAgentId)!.blob).toEqual(
      enc("recent blob"),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("Only the recent segment is transferred when historical is already in sync", async () => {
  // Both nodes share historical blobs when recent blobs are already in sync.
  // The historical XOR summaries match, so only the recent segment is sent.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    vi.setSystemTime(500);
    syncB.store(enc("historical blob"));
    // A already holds this historical blob from an earlier sync.
    storeA.accept(enc("historical blob"), "agent-b", 500);

    vi.setSystemTime(1_500);
    const hashRecent = syncB.store(enc("recent blob")); // only B has this

    vi.setSystemTime(1_800);
    const acceptSpy = vi.spyOn(storeA, "accept");
    await syncA.pullFromAllPeers();

    // A held only the historical blob, so its recent last-known timestamp clamps
    // to epochStart and exactly one blob transfers — the recent one.
    expect(acceptSpy).toHaveBeenCalledTimes(1);
    expect(syncA.get(hashRecent, nodeB.ownAgentId)).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

test("Responder closes stream gracefully when it receives no bytes", async () => {
  // The initiator opens a stream but closes it immediately without sending
  // a request. The responder must log a warning and close cleanly without
  // throwing or leaving a dangling promise.
  const b = createMockPeer("agent-b");
  const handler = b.node.handlers.get(AUTHORED_DATA_SYNC_PROTOCOL);
  expect(handler).toBeDefined();

  const [senderEnd, receiverEnd] = makeStreamPair();
  // Start B's handler; it suspends waiting for a request message.
  handler!("agent-a", receiverEnd);

  // Close the sender side with no data → B's BufferedStream returns null.
  await senderEnd.close();

  // Yield to let the handler finish reacting to the close.
  await Promise.resolve();
});

test("Responder closes stream gracefully when it receives a malformed request", async () => {
  // The initiator sends bytes that cannot be decoded as a PullRequest.
  // The responder must log a warning and close cleanly.
  const b = createMockPeer("agent-b");
  const handler = b.node.handlers.get(AUTHORED_DATA_SYNC_PROTOCOL);
  expect(handler).toBeDefined();

  const [senderEnd, receiverEnd] = makeStreamPair();
  handler!("agent-a", receiverEnd);

  // Send garbage that cannot be decoded as a PullMessage.
  senderEnd.send(new Uint8Array([0xff, 0xfe, 0x00]));
  await senderEnd.close();

  await Promise.resolve();
});

test("Responder only sends blobs it authored, not blobs attributed to others", async () => {
  // B's store contains two blobs: one authored by B (via dataSync.store) and one
  // injected directly with a third-party author. The protocol only forwards blobs
  // authored by the responding node, so A must not receive the third-party blob.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  a.node.addPeer(b.node);

  const blobB = enc("blob from B");
  const hashB = b.dataSync.store(blobB); // attributed to "agent-b"

  // B received a blob attributed to a third agent. accept stores it without
  // registering it as B's own authored data (no onAuthored fires).
  const blobC = enc("blob supposedly from C");
  const agentIdC = "agent-c";
  const hashC = b.store.accept(blobC, agentIdC, Date.now())!;

  await a.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hashB, b.node.ownAgentId)!.blob).toEqual(blobB); // B's own blob is received
  expect(a.dataSync.get(hashC, agentIdC)).toBeUndefined(); // third-party blob is not forwarded
});

test("Three fully-connected nodes reach full sync after one pull round each", async () => {
  // Each node pulls with all connected peers. One round per node is sufficient
  // because every pair is directly connected.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  const c = createMockPeer("agent-c");
  a.node.addPeer(b.node);
  a.node.addPeer(c.node);
  b.node.addPeer(c.node);

  const hashA = a.dataSync.store(enc("data from A"));
  const hashB = b.dataSync.store(enc("data from B"));
  const hashC = c.dataSync.store(enc("data from C"));

  await a.dataSync.pullFromAllPeers();
  await b.dataSync.pullFromAllPeers();
  await c.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hashB, b.node.ownAgentId)).toBeDefined();
  expect(a.dataSync.get(hashC, c.node.ownAgentId)).toBeDefined();
  expect(b.dataSync.get(hashA, a.node.ownAgentId)).toBeDefined();
  expect(b.dataSync.get(hashC, c.node.ownAgentId)).toBeDefined();
  expect(c.dataSync.get(hashA, a.node.ownAgentId)).toBeDefined();
  expect(c.dataSync.get(hashB, b.node.ownAgentId)).toBeDefined();
});

test("An interrupted pull session recovers on the next round", async () => {
  // pullWithPeer() swallows stream-open errors and returns early. The next round
  // detects the mismatch via XOR summaries and transfers the missing blobs.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  a.node.addPeer(b.node);

  const hashA = a.dataSync.store(enc("hello from A"));
  const hashB = b.dataSync.store(enc("hello from B"));

  // First round: stream creation fails on A's side; nothing is transferred.
  vi.spyOn(a.node, "createStream").mockRejectedValueOnce(
    new Error("simulated interruption"),
  );
  await a.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hashB, b.node.ownAgentId)).toBeUndefined();
  expect(b.dataSync.get(hashA, a.node.ownAgentId)).toBeUndefined();

  // Second round: the rejection is consumed; normal pull resumes.
  await a.dataSync.pullFromAllPeers();
  await b.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hashB, b.node.ownAgentId)).toBeDefined();
  expect(b.dataSync.get(hashA, a.node.ownAgentId)).toBeDefined();
});

test("start() pulls on the configured interval, stop() halts it", async () => {
  // The pull timer fires automatically without any explicit
  // pullFromAllPeers() call.
  // After stop(), advancing the clock further must not trigger new pull rounds.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const INTERVAL = 50;
    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      INTERVAL,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      INTERVAL,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    const hashA = syncA.store(enc("hello from A"));
    const hashB = syncB.store(enc("hello from B"));

    syncA.start();
    syncB.start();

    // Advance the clock by two intervals so both timers fire at least once each.
    // advanceTimersByTimeAsync awaits the async pull rounds that the timers trigger.
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(syncA.get(hashB, nodeB.ownAgentId)).toBeDefined();
    expect(syncB.get(hashA, nodeA.ownAgentId)).toBeDefined();

    syncA.stop();
    syncB.stop();

    // Store a new blob that neither side has yet.
    const newHash = syncB.store(enc("post-stop from B"));

    // Advance the clock well past another interval. With both timers stopped, no
    // pull fires and A never picks up the new blob.
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(syncA.get(newHash, nodeB.ownAgentId)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("Responder uses initiator's epoch boundary when clocks differ", async () => {
  // Pre-synced scenario: both nodes already hold a blob stored at t = 500.
  // A's clock: t = 1500 → epochStart=1000; blob is historical (500 < 1000).
  // B's clock: t = 900  → epochStart=0;    blob would be recent  (500 >= 0).
  //
  // Without the fix, B would compute epochStart=0, classify the blob as recent,
  // and the historical XOR (now empty) would mismatch A's summary of the blob —
  // triggering a spurious retransfer. With the fix, B uses A's epochStart = 1000,
  // the blob stays historical on both sides, and the summaries agree.
  //
  // The spy's fallback value (900) is the regression guard: if the fix were removed
  // and B called Date.now(), it would receive 900, compute the wrong epochStart,
  // and acceptSpy would be called — failing the assertion.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const EPOCH = 1_000;
    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      5_000,
      EPOCH,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      5_000,
      EPOCH,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    // Store the blob in both nodes at t = 500 (historical relative to epoch 1000).
    vi.setSystemTime(500);
    const blob = enc("pre-synced blob");
    syncB.store(blob);
    // A already holds this blob from an earlier sync.
    storeA.accept(blob, "agent-b", 500);

    // First call returns A's clock (t = 1500 → epochStart = 1000).
    // Subsequent calls return B's lagging clock (t = 900 → epochStart = 0 if used).
    vi.spyOn(Date, "now").mockReturnValueOnce(1_500).mockReturnValue(900);

    const acceptSpy = vi.spyOn(storeA, "accept");
    await syncA.pullFromAllPeers();

    // Both sides used epochStart = 1000; summaries match; no blobs transferred.
    expect(acceptSpy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("Two nodes sync first, then a third node joins and converges", async () => {
  // C joins after A and B have already exchanged blobs. C must pull the existing
  // blobs from A and B, and A and B must pull C's new blob in their next round.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  a.node.addPeer(b.node);

  const hashA = a.dataSync.store(enc("data from A"));
  const hashB = b.dataSync.store(enc("data from B"));

  await a.dataSync.pullFromAllPeers();
  await b.dataSync.pullFromAllPeers();

  // C joins late and connects to both existing nodes.
  const c = createMockPeer("agent-c");
  a.node.addPeer(c.node);
  b.node.addPeer(c.node);
  const hashC = c.dataSync.store(enc("data from C"));

  // C pulls from A and B; A and B each pull C's new blob in their next round.
  await c.dataSync.pullFromAllPeers();
  await a.dataSync.pullFromAllPeers();
  await b.dataSync.pullFromAllPeers();

  expect(a.dataSync.get(hashB, b.node.ownAgentId)).toBeDefined();
  expect(a.dataSync.get(hashC, c.node.ownAgentId)).toBeDefined();
  expect(b.dataSync.get(hashA, a.node.ownAgentId)).toBeDefined();
  expect(b.dataSync.get(hashC, c.node.ownAgentId)).toBeDefined();
  expect(c.dataSync.get(hashA, a.node.ownAgentId)).toBeDefined();
  expect(c.dataSync.get(hashB, b.node.ownAgentId)).toBeDefined();
});

test("pull loop exits after pullTimeoutMs with no blob activity", async () => {
  // B holds the stream open but sends nothing, simulating a slow or
  // misbehaving responder. Promise.race fires the timeout via setTimeout,
  // which resolves to null and breaks the loop without any blobs transferred.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const TIMEOUT = 50;
    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      60_000,
      undefined,
      TIMEOUT,
    );
    syncA.init(nodeA);

    // B's handler holds the stream open without sending anything.
    nodeB.registerStreamHandler(AUTHORED_DATA_SYNC_PROTOCOL, () => {});

    const acceptSpy = vi.spyOn(storeA, "accept");
    const pullPromise = syncA.pullFromAllPeers();

    // Fire the setTimeout inside Promise.race; advanceTimersByTimeAsync also
    // drains the async continuations so pullWithPeer completes fully.
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);

    await pullPromise;
    expect(acceptSpy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("Hash summary considers data distribution policy", async () => {
  vi.useFakeTimers();
  try {
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    // A hash-based policy that excludes one specific blob
    const willNotStoreBlob = enc("blocked");
    const willNotStoreHash = blake2s(willNotStoreBlob);
    const policy = {
      willStore: (_peerId: AgentId, hash: Hash) =>
        bytesToHex(hash) !== bytesToHex(willNotStoreHash),
    };

    const storeA = new MemoryBlobStore(policy);
    const storeB = new MemoryBlobStore(policy);

    // 10 s epoch
    const syncA = new AuthoredDataSync(storeA, policy, 5_000, 10_000);
    const syncB = new AuthoredDataSync(storeB, policy, 5_000, 10_000);
    syncA.init(nodeA);
    syncB.init(nodeB);

    // B authors a storable historical blob within the epoch
    vi.setSystemTime(1_000);
    const storableHash = syncB.store(enc("storable"));
    // B authors the blob A will not store. Authoring bypasses willStore, so B
    // holds its own blob even though the gossip policy excludes it.
    vi.setSystemTime(2_000);
    syncB.store(willNotStoreBlob);

    const acceptSpy = vi.spyOn(storeA, "accept");

    vi.setSystemTime(15_000);
    await syncA.pullFromAllPeers();

    expect(syncA.get(storableHash, nodeB.ownAgentId)).toBeDefined();
    // Hash summary filtered the blob that A will not store
    expect(syncA.get(willNotStoreHash, nodeB.ownAgentId)).toBeUndefined();
    // 1 blob put into the store
    expect(acceptSpy).toHaveBeenCalledTimes(1);

    acceptSpy.mockReset();

    // Calling pull again should result in matching hash summaries
    // and not to transfer any blob.
    vi.setSystemTime(20_000);
    await syncA.pullFromAllPeers();

    expect(acceptSpy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("Recent blobs considers data distribution policy", async () => {
  vi.useFakeTimers();
  try {
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    // A hash-based policy that excludes one specific blob
    const willNotStoreBlob = enc("blocked");
    const willNotStoreHash = blake2s(willNotStoreBlob);
    const policy = {
      willStore: (_peerId: AgentId, hash: Hash) =>
        bytesToHex(hash) !== bytesToHex(willNotStoreHash),
    };

    const storeA = new MemoryBlobStore(policy);
    const storeB = new MemoryBlobStore(policy);

    // 10 s epoch so both blobs are recent
    const syncA = new AuthoredDataSync(storeA, policy, 5_000, 10_000);
    const syncB = new AuthoredDataSync(storeB, policy, 5_000, 10_000);
    syncA.init(nodeA);
    syncB.init(nodeB);

    // B authors a storable recent blob (authoredAt 1000) that A is missing.
    vi.setSystemTime(1_000);
    const storableHash = syncB.store(enc("storable"));
    // B authors the blob A will not store. Authoring bypasses willStore, so B
    // holds its own blob even though the gossip policy excludes it.
    vi.setSystemTime(2_000);
    syncB.store(willNotStoreBlob);

    vi.setSystemTime(3_000);
    await syncA.pullFromAllPeers();

    expect(syncA.get(storableHash, nodeB.ownAgentId)).toBeDefined();
    // recent pull filtered the blob that A will not store
    expect(syncA.get(willNotStoreHash, nodeB.ownAgentId)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("nextAuthoredAt stays non-decreasing when the wall clock moves backward", async () => {
  // A backward wall-clock jump (NTP correction / manual reset) must not author a
  // blob below an existing authoredAt, or a peer past that last-known timestamp would
  // never request it.
  vi.useFakeTimers();
  try {
    const store = new MemoryBlobStore();
    const node = new MockNode("agent-a");
    const sync = new AuthoredDataSync(
      store,
      new FullReplicationStrategy(),
      5_000,
    );
    sync.init(node);

    vi.setSystemTime(1_000);
    sync.store(enc("first")); // authoredAt = 1000

    vi.setSystemTime(500); // wall clock regresses
    sync.store(enc("second")); // authoredAt clamps up to 1000, not 500

    const all = store.getByAuthorSince("agent-a", 0);
    expect(all).toHaveLength(2);
    for (const b of all) expect(b.authoredAt).toBeGreaterThanOrEqual(1_000);
  } finally {
    vi.useRealTimers();
  }
});

test("authoring clock resumes above the max authoredAt held", () => {
  // A store populated by a previous run already holds own data at authoredAt =
  // 5000. The store's authoring clock must resume above that mark even if the
  // wall clock now reads far below it.
  vi.useFakeTimers();
  try {
    const store = new MemoryBlobStore();
    const node = new MockNode("agent-a");
    // Simulate persisted data from a previous run: accept seeds the store
    // without warming the in-memory authoring clock.
    store.accept(enc("old"), "agent-a", 5_000);

    vi.setSystemTime(100); // wall clock far below the held mark
    const sync = new AuthoredDataSync(
      store,
      new FullReplicationStrategy(),
      5_000,
    );
    sync.init(node); // the store derives lastAuthoredAt = 5000 lazily on store()

    const hash = sync.store(enc("new")); // authoredAt must be >= 5000, not 100
    const stored = store
      .getByAuthorSince("agent-a", 0)
      .find((b) => bytesToHex(b.hash) === bytesToHex(hash));
    expect(stored?.authoredAt).toBe(5_000);
  } finally {
    vi.useRealTimers();
  }
});

test("Storing blobs exceeding the max blob size throws", () => {
  const maxBlobSize = 10;
  const store = new MemoryBlobStore(new FullReplicationStrategy(), maxBlobSize);
  const node = new MockNode("agent-a");

  const sync = new AuthoredDataSync(
    store,
    new FullReplicationStrategy(),
    5_000,
  );
  sync.init(node);

  expect(() => sync.store(new Uint8Array(maxBlobSize + 1))).toThrow(
    /Blob to be stored too large/,
  );
});

test("Received blobs exceeding the max blob size are dropped", async () => {
  // A's store doesn't set a max blob size, so it can store larger blobs.
  const storeA = new MemoryBlobStore();
  const maxBlobSize = 10;
  const storeB = new MemoryBlobStore(
    new FullReplicationStrategy(),
    maxBlobSize,
  );
  const nodeA = new MockNode("agent-a");
  const nodeB = new MockNode("agent-b");

  const syncA = new AuthoredDataSync(
    storeA,
    new FullReplicationStrategy(),
    5_000,
  );
  syncA.init(nodeA);

  const syncB = new AuthoredDataSync(
    storeB,
    new FullReplicationStrategy(),
    5_000,
  );
  syncB.init(nodeB);

  // A stores a large blob
  const hash = syncA.store(new Uint8Array(maxBlobSize + 1));

  nodeB.addPeer(nodeA);
  await syncB.pullFromAllPeers();

  expect(syncB.get(hash, nodeA.ownAgentId)).toBeUndefined();
});

test("Received blobs which do not pass willStore are dropped", async () => {
  const nodeA = new MockNode("agent-a");
  const nodeB = new MockNode("agent-b");

  const storeA = new MemoryBlobStore();
  const syncA = new AuthoredDataSync(
    storeA,
    new FullReplicationStrategy(),
    5_000,
  );
  syncA.init(nodeA);

  // Create a blob that A will store but B won't
  const blob = new Uint8Array(1);
  const hash = blake2s(blob);
  const bPolicy = {
    willStore: (_peerId: AgentId, blobHash: Hash) =>
      bytesToHex(blobHash) !== bytesToHex(hash),
  };
  const storeB = new MemoryBlobStore(bPolicy);
  const syncB = new AuthoredDataSync(storeB, bPolicy, 5_000);
  syncB.init(nodeB);

  // A stores blob B won't store
  syncA.store(blob);

  nodeB.addPeer(nodeA);
  await syncB.pullFromAllPeers();

  expect(storeB.getLastKnownByAuthor(nodeA.ownAgentId)).toBeUndefined();
});

test("Empty recent holding pulls the entire recent segment", async () => {
  // A holds none of B's data, so its last-known timestamp clamps to epochStart and the
  // whole recent segment transfers in one round.
  vi.useFakeTimers();
  try {
    const storeA = new MemoryBlobStore();
    const storeB = new MemoryBlobStore();
    const nodeA = new MockNode("agent-a");
    const nodeB = new MockNode("agent-b");
    nodeA.addPeer(nodeB);

    const syncA = new AuthoredDataSync(
      storeA,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    const syncB = new AuthoredDataSync(
      storeB,
      new FullReplicationStrategy(),
      5_000,
      1_000,
    );
    syncA.init(nodeA);
    syncB.init(nodeB);

    vi.setSystemTime(1_200);
    const h1 = syncB.store(enc("r1"));
    vi.setSystemTime(1_400);
    const h2 = syncB.store(enc("r2"));

    vi.setSystemTime(1_500); // epochStart = 1000
    await syncA.pullFromAllPeers();

    expect(syncA.get(h1, nodeB.ownAgentId)).toBeDefined();
    expect(syncA.get(h2, nodeB.ownAgentId)).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});
