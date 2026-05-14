import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PeerkitNode } from "../../src/node.js";
import { PeerkitRelay } from "../../src/relay.js";
import getPort, { portNumbers } from "get-port";
import type { RelayAddress } from "@peerkit/api";
import { setupTestLogger } from "./util.js";
import { reset } from "@logtape/logtape";

beforeEach(setupTestLogger);

afterEach(reset);

test("Relay sends known agents to connecting peer", async () => {
  // Create the relay
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayAddress: RelayAddress = `/ip4/0.0.0.0/tcp/${relayPort}`;
  const relay = await PeerkitRelay.create({
    id: "relay",
    addrs: [relayAddress],
    networkAccessHandler: async () => true,
  });

  // Create node 1 with the relay address. Access handler allows everyone.
  const node1 = await PeerkitNode.create({
    id: "node1",
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
    bootstrapRelays: [relayAddress],
  });

  // Wait for node 1 to connect to relay and add its own address to
  // its agent store.
  const node1AgentInfoSigned = await vi.waitUntil(
    () => node1.agentStore.get(node1.keyPair.agentId()),
    {
      timeout: 5_000,
    },
  );
  // Wait for the relay to have received node 1's agent info.
  await vi.waitFor(
    () =>
      expect(relay.agentStore.getAll()).toStrictEqual([node1AgentInfoSigned]),
    { timeout: 5_000 },
  );

  // Create node 2
  const node2 = await PeerkitNode.create({
    id: "node2",
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
    bootstrapRelays: [relayAddress],
  });

  // Wait for node 2 to add its own agent info to its agent store.
  const node2AgentInfoSigned = await vi.waitUntil(
    () => node2.agentStore.get(node2.keyPair.agentId()),
    {
      timeout: 5_000,
    },
  );

  // Wait for the relay to have both nodes' agent infos.
  await vi.waitFor(() => expect(relay.agentStore.getAll().length).toBe(2), {
    timeout: 5_000,
  });
  expect(relay.agentStore.getAll()).toContainEqual(node1AgentInfoSigned);
  expect(relay.agentStore.getAll()).toContainEqual(node2AgentInfoSigned);

  // By now the relay should have sent node 1's agent info to node 2.
  await vi.waitFor(() =>
    expect(node2.agentStore.get(node1.keyPair.agentId())).toBeTruthy(),
  );

  await node2.shutDown();
  await node1.shutDown();
  await relay.shutDown();
});
