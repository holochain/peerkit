import { reset } from "@logtape/logtape";
import type { RelayAddress } from "@peerkit/api";
import getPort, { portNumbers } from "get-port";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildOwnAgentInfo } from "../../src/agent-info.js";
import { AgentKeyPair } from "../../src/agent.js";
import { PeerkitNodeBuilder } from "../../src/node.js";
import { PeerkitRelayBuilder } from "../../src/relay.js";
import { setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

afterEach(reset);

test("Relay sends known agents to connecting peer", async () => {
  // Create the relay
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayAddress: RelayAddress = `/ip4/0.0.0.0/tcp/${relayPort}/ws`;
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayAddress])
    .build();

  // Create node 1 with the relay address. Access handler allows everyone.
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withBootstrapRelays([relayAddress])
    .build();

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
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withBootstrapRelays([relayAddress])
    .build();

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

test("Node connects to another node using address learned from relay", async () => {
  // Create the relay
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayAddress: RelayAddress = `/ip4/0.0.0.0/tcp/${relayPort}/ws`;
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayAddress])
    .build();

  // Create node 1 and wait until it has registered its own agent info via the
  // relay.
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withBootstrapRelays([relayAddress])
    .build();
  await vi.waitUntil(() => node1.agentStore.get(node1.keyPair.agentId()), {
    timeout: 5_000,
  });

  // Add a third agent info to node 1's store, one that the relay will never
  // forward. When node 2 later connects directly to node 1, receiving this
  // info proves node 1 sent its full store, not just its own entry.
  const thirdKeyPair = new AgentKeyPair();
  const thirdAgentInfo = buildOwnAgentInfo(
    thirdKeyPair,
    [],
    Date.now() + 60_000,
  );
  node1.agentStore.store([thirdAgentInfo]);

  // Create node 2
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withBootstrapRelays([relayAddress])
    .build();
  // Wait for node 2 to register its own agent info, to send to node 1 later.
  const node2AgentInfo = await vi.waitUntil(
    () => node2.agentStore.get(node2.keyPair.agentId()),
    {
      timeout: 5_000,
    },
  );
  // Wait until the relay has forwarded node 1's agent info to node 2.
  const node1AgentInfo = await vi.waitUntil(
    () => node2.agentStore.get(node1.keyPair.agentId()),
    { timeout: 5_000 },
  );

  // Node 2 connects to node 1 using the agent info the relay provided.
  const node1CircuitAddress = node1AgentInfo.addresses[0];
  expect(node1CircuitAddress).toBeDefined();
  await node2.transport.connect(node1CircuitAddress!);

  // Node 2 must receive the third agent info, the one only node 1 holds.
  // This confirms node 1 sent its full store.
  await vi.waitFor(
    () => expect(node2.agentStore.getAll()).toContainEqual(thirdAgentInfo),
    { timeout: 5_000 },
  );

  // Node 1 must receive node 2's agent info too. Node 1 has 2 existing
  // agent infos, so it will be the 3rd.
  await vi.waitFor(
    () => expect(node1.agentStore.getAll()).toContainEqual(node2AgentInfo),
    {
      timeout: 5_000,
    },
  );

  await node2.shutDown();
  await node1.shutDown();
  await relay.shutDown();
});
