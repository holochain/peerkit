import { reset } from "@logtape/logtape";
import type { AgentId } from "@peerkit/api";
import { setupTestLogger, makeStreamPair } from "@peerkit/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { encodePushMessage } from "../src/push.js";
import { createMockPeer, type MockPeer } from "./mock-node.js";

const AUTHORED_DATA_PUSH_PROTOCOL = "/peerkit/authored-data-push/v1";
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(setupTestLogger);
afterEach(reset);

/**
 * Deliver a hand-crafted push message straight to a receiver's stream handler,
 * so receiver-side validation can be tested without going through an author's
 * authoring path. Returns once the receiver has processed it.
 */
async function deliverPush(
  receiver: MockPeer,
  fromAgent: AgentId,
  entries: Array<{ blob: Uint8Array; authoredAt: number }>,
): Promise<void> {
  const handler = receiver.node.handlers.get(AUTHORED_DATA_PUSH_PROTOCOL)!;
  const [mine, theirs] = makeStreamPair();
  // The handler reads from `theirs`; we write from `mine`.
  handler(fromAgent, theirs);
  mine.send(encodePushMessage({ entries }));
  await mine.close();
  // The handler stores in microtasks after the close resolves its read; a
  // macrotask tick drains them.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Authoring pushes the blob to a connected peer", async () => {
  // A authors a blob; the push module immediately streams it to its connected
  // peer B, which stores it under A's AgentId with the original authoredAt.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  a.node.addPeer(b.node);

  const hash = a.store.store(enc("hello from A"), "agent-a");

  // waitUntil polls until the predicate is truthy — the async push lands first.
  await vi.waitUntil(() => b.store.get(hash, "agent-a") !== undefined);
  const stored = b.store.get(hash, "agent-a")!;
  expect(stored.blob).toEqual(enc("hello from A"));
  // The author-assigned authoredAt is preserved as-is on the receiver.
  expect(stored.authoredAt).toEqual(a.store.get(hash, "agent-a")!.authoredAt);
});

test("pushToAllPeers fans out and a failing peer does not block the others", async () => {
  // A is connected to B (a real push peer) and X (a bare node with no push
  // handler, so opening a stream to it throws). The push to X fails, but B
  // still receives the blob.
  const a = createMockPeer("agent-a");
  const b = createMockPeer("agent-b");
  const x = createMockPeer("agent-x");
  // Remove X's handler so createStream to it rejects.
  x.node.handlers.delete(AUTHORED_DATA_PUSH_PROTOCOL);
  a.node.addPeer(b.node);
  a.node.addPeer(x.node);

  const hash = a.store.store(enc("fan out"), "agent-a");

  await vi.waitUntil(() => b.store.get(hash, "agent-a") !== undefined);
  expect(b.store.get(hash, "agent-a")!.blob).toEqual(enc("fan out"));
});

test("Receiver rejects a blob that exceeds the max blob size", async () => {
  // B's store accepts at most 4 bytes; a 5-byte blob is rejected.
  const b = createMockPeer("agent-b", { maxBlobSize: 4 });

  await deliverPush(b, "agent-a", [{ blob: enc("12345"), authoredAt: 1 }]);

  expect(b.store.getLastKnownByAuthor("agent-a")).toBeUndefined();
});

test("Receiver skips a blob the distribution policy declines to store", async () => {
  // B's policy refuses everything, so a well-formed push is not stored.
  const b = createMockPeer("agent-b", { policy: { willStore: () => false } });

  await deliverPush(b, "agent-a", [{ blob: enc("not for me"), authoredAt: 1 }]);

  expect(b.store.getLastKnownByAuthor("agent-a")).toBeUndefined();
});

test("Receiver gives up when the author opens a stream but never sends or closes", async () => {
  // A stalled author must not hold the receive handler open forever: after
  // pushTimeoutMs of silence the receiver closes the stream and stores nothing.
  vi.useFakeTimers();
  try {
    const b = createMockPeer("agent-b", { pushTimeoutMs: 50 });
    const handler = b.node.handlers.get(AUTHORED_DATA_PUSH_PROTOCOL)!;

    // Start B's receive handler with a stream whose author end never sends and
    // never closes. The handler suspends awaiting the first message.
    const [, receiverEnd] = makeStreamPair();
    handler("agent-a", receiverEnd);

    // Advance past the idle timeout; advanceTimersByTimeAsync also drains the
    // handler's async continuations so it runs to completion.
    await vi.advanceTimersByTimeAsync(51);

    // The receiver gave up: it closed its end and stored nothing.
    expect(receiverEnd.isOpen()).toBe(false);
    expect(b.store.getLastKnownByAuthor("agent-a")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
