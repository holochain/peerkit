import { reset } from "@logtape/logtape";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
  createNode as createTransportNode,
} from "../src/index.js";
import { createNode, createRelay, setupTestLogger } from "./util.js";
import { NodeId } from "@peerkit/api";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { multiaddr } from "@multiformats/multiaddr";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("peerDisconnectedCallback fires when connected peer disconnects", async () => {
  // node2 will be notified when node1 disconnects from it.
  const disconnectedNodeIds: string[] = [];
  const connectedNodeIds: string[] = [];

  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  const { node: node2 } = await createNode({
    id: "node2",
    peerConnectedCallback: async (nodeId) => {
      connectedNodeIds.push(nodeId);
    },
    peerDisconnectedCallback: async (nodeId) => {
      disconnectedNodeIds.push(nodeId);
    },
  });

  await node2.connect(address1);

  // Wait for the access handshake to complete so peerConnectedCallback has fired.
  await vi.waitFor(() => expect(connectedNodeIds).toHaveLength(1), {
    timeout: 5_000,
  });

  // node1 closes the connection; node2 should receive the disconnect event.
  await node1.disconnect(node2.getNodeId());

  await vi.waitFor(() => expect(disconnectedNodeIds).toHaveLength(1), {
    timeout: 5_000,
  });
  assert.equal(disconnectedNodeIds[0], node1.getNodeId());

  await node1.shutDown();
  await node2.shutDown();
});

test("peerDisconnectedCallback fires when peer shuts down abruptly", async () => {
  // Peer shuts down without calling disconnect().
  const disconnectedNodeIds: string[] = [];
  const connectedNodeIds: string[] = [];

  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  const { node: node2 } = await createNode({
    id: "node2",
    peerConnectedCallback: async (nodeId) => {
      connectedNodeIds.push(nodeId);
    },
    peerDisconnectedCallback: async (nodeId) => {
      disconnectedNodeIds.push(nodeId);
    },
  });

  await node2.connect(address1);

  // Wait for the access handshake to complete so the mapping is established.
  await vi.waitFor(() => expect(connectedNodeIds).toHaveLength(1), {
    timeout: 5_000,
  });

  // node1 shuts down entirely without calling disconnect() first.
  await node1.shutDown();

  // node2 must still receive the peer:disconnect event even though node1 never
  // sent a graceful close.
  await vi.waitFor(() => expect(disconnectedNodeIds).toHaveLength(1), {
    timeout: 5_000,
  });
  assert.equal(disconnectedNodeIds[0], node1.getNodeId());

  await node2.shutDown();
});

test("Connection can be closed", { timeout: 10_000 }, async () => {
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    messageHandler: async () => {},
  });

  const node2 = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
  });

  const connection = await node2.dial(multiaddr(address1));
  // Perform access handshake first. Access is always granted, but the
  // handshake must be performed.
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new Uint8Array([0]));
  await accessStream.close();

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  messageStream.send(new Uint8Array([1]));
  await messageStream.close();

  // Node 1 disconnects from node 2.
  await node1.disconnect(node2.peerId.toString());

  // Wait for connection to be closed on the other end.
  // node1 closes with ECONNRESET from node2's perspective, which libp2p marks
  // as 'aborted' rather than 'closed' => check for any non-open status.
  await vi.waitUntil(() => connection.status !== "open");
});

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
    peerConnectedCallback: async (nodeId, _transport) => {
      peersConnectedToRelay.push(nodeId);
    },
  });

  // Create node 1 that will connect first to the relay and send it its
  // agent info.
  let relayNodeId = "";
  let node1RelayedAddress = "";
  const peersConnectedToNode1: NodeId[] = [];
  const node1 = await createTransportNode({
    id: "node1",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: async (address, nodeId, _transport) => {
      node1RelayedAddress = address;
      relayNodeId = nodeId;
    },
    agentsReceivedCallback: async (_fromNode, _agentInfos) => {
      throw new Error("Node 1 shouldn't be sent agents");
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      peersConnectedToNode1.push(nodeId);
    },
    messageHandler: async (_message) => {},
    addrs: ["/p2p-circuit"], // Only bind to relay transport
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 1's connection to the relay to be ready before node 2 dials through it.
  await vi.waitUntil(
    () =>
      !!node1RelayedAddress &&
      !!relayNodeId &&
      peersConnectedToRelay.length === 1,
    { timeout: 2_000 },
  );

  // Node 1 sends its own agent info to relay.
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
  let node2RelayedAddress = "";
  const node2 = await createTransportNode({
    id: "node2",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: async (address, _relayNodeId, _transport) => {
      node2RelayedAddress = address;
    },
    agentsReceivedCallback: async (fromNode, agentInfos) => {
      assert.equal(fromNode, relay.getNodeId());
      node2AgentStore.push(agentInfos);
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      assert.equal(nodeId, node1.getNodeId());
      peersConnectedToNode2.push(nodeId);
    },
    messageHandler: async (fromNode, message, _transport) => {
      assert.equal(fromNode, node1.getNodeId());
      messagesReceivedByNode2.push(message);
    },
    addrs: ["/p2p-circuit"], // Only bind to relay transport
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 2's connection to relay to complete.
  // Node 1 is still connected to relay, so wait for 2 connected peers.
  await vi.waitUntil(
    () => !!node2RelayedAddress && peersConnectedToRelay.length === 2,
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

test("relay and 2 nodes and send message over direct connection", async () => {
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
    peerConnectedCallback: async (nodeId, _transport) => {
      peersConnectedToRelay.push(nodeId);
    },
  });

  // Create node 1 that will connect first to the relay and send it its
  // agent info.
  let relayNodeId = "";
  let node1RelayedAddress = "";
  const peersConnectedToNode1: NodeId[] = [];
  const node1 = await createTransportNode({
    id: "node1",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: async (address, nodeId, _transport) => {
      node1RelayedAddress = address;
      relayNodeId = nodeId;
    },
    agentsReceivedCallback: async (_fromNode, _agentInfos) => {
      throw new Error("Node 1 shouldn't be sent agents");
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      peersConnectedToNode1.push(nodeId);
    },
    messageHandler: async (_message) => {},
    addrs: ["/ip4/0.0.0.0/tcp/0", "/p2p-circuit"],
    bootstrapRelays: [relayPublicAddress],
  });

  // Wait for node 1's connection to the relay to be ready before node 2 dials through it.
  await vi.waitUntil(
    () =>
      !!node1RelayedAddress &&
      !!relayNodeId &&
      peersConnectedToRelay.length === 1,
    { timeout: 5_000 },
  );

  // Node 1 sends its own agent info to relay.
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
  let node2RelayedAddress = "";
  const peersConnectedToNode2: NodeId[] = [];
  const node2 = await createTransportNode({
    id: "node2",
    networkAccessHandler: async (_agentId, _bytes) => true,
    connectedToRelayCallback: async (address, _nodeId, _transport) => {
      node2RelayedAddress = address;
    },
    agentsReceivedCallback: async (fromNode, agentInfos) => {
      assert.equal(fromNode, relay.getNodeId());
      node2AgentStore.push(agentInfos);
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      assert.equal(nodeId, node1.getNodeId());
      peersConnectedToNode2.push(nodeId);
    },
    messageHandler: async (fromNode, message, _transport) => {
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
    () => !!node2RelayedAddress && peersConnectedToRelay.length === 2,
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

test("isConnected returns false before connect, true while connected, false after disconnect", async () => {
  // node1 listens; node2 connects to it and verifies the live connection state.
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  const { node: node2 } = await createNode({ id: "node2" });

  // No connection has been made yet — both directions must report false.
  expect(node1.isConnected(node2.getNodeId())).toBe(false);
  expect(node2.isConnected(node1.getNodeId())).toBe(false);

  await node2.connect(address1);

  // connect() resolves after the access handshake, so the connection is live on node2.
  expect(node2.isConnected(node1.getNodeId())).toBe(true);
  // node1 accepts the connection asynchronously — wait for the accept to land.
  await vi.waitFor(
    () => expect(node1.isConnected(node2.getNodeId())).toBe(true),
    {
      timeout: 5_000,
    },
  );

  await node2.disconnect(node1.getNodeId());

  // After disconnect, both sides must report false.
  await vi.waitFor(
    () => expect(node1.isConnected(node2.getNodeId())).toBe(false),
    {
      timeout: 5_000,
    },
  );
  expect(node2.isConnected(node1.getNodeId())).toBe(false);

  await node1.shutDown();
  await node2.shutDown();
});

test("getConnectedPeers returns connected peer NodeIds and is empty after disconnect", async () => {
  // node2 connects to node1; after connect both must see each other in their peer lists.
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  const { node: node2 } = await createNode({ id: "node2" });

  // No connections yet — both peer lists must be empty.
  expect(node1.getConnectedPeers()).toHaveLength(0);
  expect(node2.getConnectedPeers()).toHaveLength(0);

  await node2.connect(address1);

  // node2 sees node1 immediately after connect().
  expect(node2.getConnectedPeers()).toContain(node1.getNodeId());
  // node1's list is updated asynchronously when the connection is accepted.
  await vi.waitFor(
    () => expect(node1.getConnectedPeers()).toContain(node2.getNodeId()),
    { timeout: 5_000 },
  );

  await node2.disconnect(node1.getNodeId());

  // After disconnect, both peer lists must be empty.
  await vi.waitFor(() => expect(node1.getConnectedPeers()).toHaveLength(0), {
    timeout: 5_000,
  });
  expect(node2.getConnectedPeers()).toHaveLength(0);

  await node1.shutDown();
  await node2.shutDown();
});
