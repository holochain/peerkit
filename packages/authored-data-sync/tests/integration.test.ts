import { reset } from "@logtape/logtape";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createTestNode, setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);
afterEach(reset);

test("Authored data sync integration test", async () => {
  // Smoke test: verifies that AuthoredDataSync wires up correctly with a real
  // PeerkitNode and exchanges blobs over an actual libp2p transport.
  const a = await createTestNode({ id: "node-a" });
  const b = await createTestNode({ id: "node-b" });

  const enc = (s: string) => new TextEncoder().encode(s);
  const hashA = a.dataSync.store(enc("hello from A"));
  const hashB = b.dataSync.store(enc("hello from B"));

  await a.node.transport.connect(b.nodeAddress);
  await a.dataSync.pullFromAllPeers();
  await b.dataSync.pullFromAllPeers();

  const lastKnownByB = a.store.getLastKnownByAuthor(b.node.ownAgentId);
  expect(lastKnownByB!.hash).toStrictEqual(hashB);
  expect(b.store.getLastKnownByAuthor(a.node.ownAgentId)!.hash).toStrictEqual(
    hashA,
  );

  await a.shutDown();
  await b.shutDown();
});
