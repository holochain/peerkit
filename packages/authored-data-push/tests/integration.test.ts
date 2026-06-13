import { reset } from "@logtape/logtape";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTestNode } from "./util.js";

beforeEach(setupTestLogger);
afterEach(reset);

test("Authored data push integration test", async () => {
  // Verifies that AuthoredDataPush wires up with a real PeerkitNode
  // and that authoring a blob immediately propagates it to a connected peer.
  const a = await createTestNode({ id: "node-a" });
  const b = await createTestNode({ id: "node-b" });

  // Connect first: push is fire-and-forget at author time, so the peer must be
  // connected before the blob is authored for it to receive the push.
  await a.node.transport.connect(b.nodeAddress);

  const enc = (s: string) => new TextEncoder().encode(s);
  const hash = a.store.store(enc("hello from A"), a.node.ownAgentId);

  // B should receive and store A's blob under A's AgentId.
  await vi.waitUntil(
    () => b.store.get(hash, a.node.ownAgentId) !== undefined,
    5_000,
  );
  expect(b.store.get(hash, a.node.ownAgentId)!.blob).toEqual(
    enc("hello from A"),
  );

  await a.shutDown();
  await b.shutDown();
});
