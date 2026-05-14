import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PeerkitNode } from "../../src/node.js";
import getPort, { portNumbers } from "get-port";
import { setupTestLogger } from "./util.js";
import { reset } from "@logtape/logtape";
import { signAgentInfo } from "../../src/agent-info.js";

beforeEach(setupTestLogger);

afterEach(reset);

test("Two nodes exchange agents bidirectionally", async () => {
  // Create node 1 on a known port so node 2 can dial it directly.
  const node1Port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1Address = `/ip4/127.0.0.1/tcp/${node1Port}`;
  const node1 = await PeerkitNode.create({
    id: "node1",
    addresses: [node1Address],
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
    bootstrapRelays: [],
  });
  // Pre-populate node 1's agent store with its own signed agent info, so it
  // has something to send when node 2 connects.
  node1.agentStore.store([
    signAgentInfo(
      {
        agentId: node1.keyPair.agentId(),
        addresses: [node1Address],
        expiresAt: Date.now() + 60_000,
      },
      node1.keyPair,
    ),
  ]);

  const node2Port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node2Address = `/ip4/127.0.0.1/tcp/${node2Port}`;
  const node2 = await PeerkitNode.create({
    id: "node2",
    addresses: [node2Address],
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
    bootstrapRelays: [],
  });
  // Pre-populate node 2's agent store so it also has something to send.
  node2.agentStore.store([
    signAgentInfo(
      {
        agentId: node2.keyPair.agentId(),
        addresses: [node2Address],
        expiresAt: Date.now() + 60_000,
      },
      node2.keyPair,
    ),
  ]);

  // Node 2 dials node 1. Both sides fire peerConnectedCallback, so both
  // send their stored agents to the other.
  await node2.transport.connect(node1Address);

  // Node 2 should receive node 1's agent info.
  await vi.waitFor(
    () => expect(node2.agentStore.get(node1.keyPair.agentId())).toBeTruthy(),
    { timeout: 5_000 },
  );
  // Node 1 should receive node 2's agent info.
  await vi.waitFor(
    () => expect(node1.agentStore.get(node2.keyPair.agentId())).toBeTruthy(),
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});
