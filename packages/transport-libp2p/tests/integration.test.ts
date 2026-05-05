import { reset } from "@logtape/logtape";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { TransportLibp2p } from "../src/index.js";
import { createRelay, setupTestLogger } from "./util.js";
import { NodeId } from "@peerkit/interface";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Bootstrap with relay and 2 nodes and send message over relayed connection", async () => {
  // Create a test agent store for the relay
  const relayAgentStore: Uint8Array[] = [];
  // Create the relay with a callback that pushes to the agent store when agent
  // infos have been received.
  const peersConnectedToRelay: NodeId[] = [];
  const { relay, address: relayPublicAddress } = await createRelay({
    id: "relay",
    networkAccessHandler: async (_agentId, _bytes) => true,
    agentsReceivedCallback: async (_fromNode, agentInfos) => {
      relayAgentStore.push(agentInfos);
    },
    peerConnectedCallback: (nodeId) => {
      peersConnectedToRelay.push(nodeId);
    },
  });

  // Create node 1 that will connect first to the relay and send it its
  // agent info.
  let relayNodeId = "";
  let relayAddress1 = "";
  const peersConnectedToNode1: NodeId[] = [];
  const node1 = await TransportLibp2p.createNode({
    id: "node1",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: (address, nodeId) => {
      relayAddress1 = address;
      relayNodeId = nodeId;
    },
    agentsReceivedCallback: async (_fromNode, _agentInfos) => {
      throw new Error("Node 1 shouldn't be sent agents");
    },
    peerConnectedCallback: (nodeId) => {
      peersConnectedToNode1.push(nodeId);
    },
    addrs: ["/p2p-circuit"], // Only bind to relay transport
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 1's connection to the relay to be ready before node 2 dials through it.
  await vi.waitUntil(
    () =>
      !!relayAddress1 && !!relayNodeId && peersConnectedToRelay.length === 1,
    { timeout: 2_000 },
  );

  // Node 1 sends agent infos, including its own, to relay.
  const node1RelayedAddress = `${relayAddress1}/p2p/${node1.getNodeId()}`;
  await node1.sendAgents(
    relayNodeId,
    new TextEncoder().encode(node1RelayedAddress),
  );
  // Await agent infos to arrive in relay's agent store.
  await vi.waitFor(() => expect(relayAgentStore.length).toBe(1));

  // Create a second node that will also connect to the relay, receive
  // agent infos from it and then connect to node 1 through the relay.
  const node2AgentStore: Uint8Array[] = [];
  const peersConnectedToNode2: NodeId[] = [];
  const messagesReceivedByNode2: Uint8Array[] = [];
  let relayAddress2 = "";
  const node2 = await TransportLibp2p.createNode({
    id: "node2",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: (address, _nodeId) => {
      relayAddress2 = address;
    },
    agentsReceivedCallback: async (fromNode, agentInfos) => {
      assert.equal(fromNode, relay.getNodeId());
      node2AgentStore.push(agentInfos);
    },
    peerConnectedCallback: (nodeId) => {
      assert.equal(nodeId, node1.getNodeId());
      peersConnectedToNode2.push(nodeId);
    },
    messageHandler: async (fromNode, message) => {
      assert.equal(fromNode, node1.getNodeId());
      messagesReceivedByNode2.push(message);
    },
    addrs: ["/p2p-circuit"], // Only bind to relay transport
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 2's connection to relay to complete.
  // Node 1 is still connected to relay, so wait for 2 connected peers.
  await vi.waitUntil(
    () => !!relayAddress2 && peersConnectedToRelay.length === 2,
    { timeout: 5_000 },
  );

  // Relay sends agent infos from agent store to node 2.
  assert(relayAgentStore[0]);
  await relay.sendAgents(node2.getNodeId(), relayAgentStore[0]);

  await vi.waitFor(() => expect(node2AgentStore.length).toBe(1));

  // Node 2 connects to node 1 over the relay.
  const node1Address = new TextDecoder().decode(node2AgentStore[0]);
  // No peers should be connected to node 1.
  assert.deepEqual(peersConnectedToNode1, []);
  // No peers should be connected to node 2.
  assert.deepEqual(peersConnectedToNode2, []);
  await node2.connect(node1Address);

  // Await the peerConnectedCallback to have fired for both nodes.
  await vi.waitUntil(
    () =>
      peersConnectedToNode1.length === 1 && peersConnectedToNode2.length === 1,
  );

  // Node 1 sends a message to node 2 over the relay.
  // Node 1 learned node 2's ID from the peersConnectedCallback.
  await node1.send(
    peersConnectedToNode1[0],
    new TextEncoder().encode("hello-from-node1"),
  );

  await vi.waitFor(() => expect(messagesReceivedByNode2.length).toBe(1));
  assert(messagesReceivedByNode2[0]);
  assert.equal(
    new TextDecoder().decode(messagesReceivedByNode2[0]),
    "hello-from-node1",
  );

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});

test("Bootstrap with relay and 2 nodes and send message over direct connection", async () => {
  // Create a test agent store for the relay
  const relayAgentStore: Uint8Array[] = [];
  // Create the relay with a callback that pushes to the agent store when agent
  // infos have been received.
  const peersConnectedToRelay: NodeId[] = [];
  const { relay, address: relayPublicAddress } = await createRelay({
    id: "relay",
    networkAccessHandler: async (_agentId, _bytes) => true,
    agentsReceivedCallback: async (_fromNode, agentInfos) => {
      relayAgentStore.push(agentInfos);
    },
    peerConnectedCallback: (nodeId) => {
      peersConnectedToRelay.push(nodeId);
    },
  });

  // Create node 1 that will connect first to the relay and send it its
  // agent info.
  let relayNodeId = "";
  let relayAddress1 = "";
  const peersConnectedToNode1: NodeId[] = [];
  const node1 = await TransportLibp2p.createNode({
    id: "node1",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: (address, nodeId) => {
      relayAddress1 = address;
      relayNodeId = nodeId;
    },
    agentsReceivedCallback: async (_fromNode, _agentInfos) => {
      throw new Error("Node 1 shouldn't be sent agents");
    },
    peerConnectedCallback: (nodeId) => {
      peersConnectedToNode1.push(nodeId);
    },
    addrs: ["/ip4/0.0.0.0/tcp/0", "/p2p-circuit"],
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 1's connection to the relay to be ready before node 2 dials through it.
  await vi.waitUntil(
    () =>
      !!relayAddress1 && !!relayNodeId && peersConnectedToRelay.length === 1,
    { timeout: 5_000 },
  );

  // Node 1 sends agent infos, including its own, to relay.
  const node1RelayedAddress = `${relayAddress1}/p2p/${node1.getNodeId()}`;
  await node1.sendAgents(
    relayNodeId,
    new TextEncoder().encode(node1RelayedAddress),
  );
  // Await agent infos to arrive in relay's agent store.
  await vi.waitFor(() => expect(relayAgentStore.length).toBe(1));

  // Create a second node that will also connect to the relay, receive
  // agent infos from it and then connect to node 1 through the relay.
  const node2AgentStore: Uint8Array[] = [];
  const messagesReceivedByNode2: Uint8Array[] = [];
  let relayAddress2 = "";
  const peersConnectedToNode2: NodeId[] = [];
  const node2 = await TransportLibp2p.createNode({
    id: "node2",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: (address, _nodeId) => {
      relayAddress2 = address;
    },
    agentsReceivedCallback: async (fromNode, agentInfos) => {
      assert.equal(fromNode, relay.getNodeId());
      node2AgentStore.push(agentInfos);
    },
    peerConnectedCallback: (nodeId) => {
      assert.equal(nodeId, node1.getNodeId());
      peersConnectedToNode2.push(nodeId);
    },
    messageHandler: async (fromNode, message) => {
      assert.equal(fromNode, node1.getNodeId());
      messagesReceivedByNode2.push(message);
    },
    // dns protocol is a workaround when testing locally.
    // When on a relayed connection, the node attempts to establish a direct
    // connection to the other node and scans for dialable addresses.
    // Therefore a TCP address is required in addition to the p2p-circuit relay
    // protocol. If, however, a TCP address is provided with 0.0.0.0, it will be
    // filtered out. The same applies to loopback addresses like 127.0.0.1.
    addrs: ["/dns/localhost/tcp/0", "/p2p-circuit"],
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 2's connection to relay to complete.
  // Node 1 is still connected to relay, so wait for 2 connected peers.
  await vi.waitUntil(
    () => !!relayAddress2 && peersConnectedToRelay.length === 2,
    { timeout: 5_000 },
  );

  // Relay sends agent infos from agent store to node 2.
  assert(relayAgentStore[0]);
  await relay.sendAgents(node2.getNodeId(), relayAgentStore[0]);

  await vi.waitFor(() => expect(node2AgentStore.length).toBe(1));

  // Node 2 connects to node 1 over the relay.
  const node1Address = new TextDecoder().decode(node2AgentStore[0]);
  // No peers should be connected to node 1.
  assert.deepEqual(peersConnectedToNode1, []);
  // No peers should be connected to node 2.
  assert.deepEqual(peersConnectedToNode2, []);
  await node2.connect(node1Address);

  // Await the peerConnectedCallback to have fired for both nodes.
  await vi.waitUntil(
    () =>
      peersConnectedToNode1.length === 1 && peersConnectedToNode2.length === 1,
  );

  // Wait for the connection upgrade to a direct connection.
  await vi.waitUntil(
    () =>
      node1.isDirectConnection(node2.getNodeId()) &&
      node2.isDirectConnection(node1.getNodeId()),
    { timeout: 10_000 },
  );

  // Node 1 sends a message to node 2 over the direct connection.
  // Node 1 learned node 2's ID from the peersConnectedCallback.
  await node1.send(
    peersConnectedToNode1[0],
    new TextEncoder().encode("hello-from-node1"),
  );

  await vi.waitFor(() => expect(messagesReceivedByNode2.length).toBe(1));
  assert(messagesReceivedByNode2[0]);
  assert.equal(
    new TextDecoder().decode(messagesReceivedByNode2[0]),
    "hello-from-node1",
  );

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});
