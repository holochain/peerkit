import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { reset } from "@logtape/logtape";
import type {
  ITransport,
  NodeAddress,
  NodeId,
  RelayDialAddress,
  RelayListenAddress,
} from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import getPort, { portNumbers } from "get-port";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { createNode, createRelay, TransportLibp2p } from "../src/index.js";

// These tests exercise peer connections over WebRTC.
// Connections to the relay use WebSockets.

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

interface ReceivedMessage {
  from: NodeId;
  bytes: Uint8Array;
}

interface TestRelay {
  relay: ITransport;
  /** Dialable WebSocket address of the relay. */
  dialAddress: RelayDialAddress;
  /** Agent-info payloads the relay has received, in arrival order. */
  receivedAgents: Uint8Array[];
  /** Node IDs that completed the access handshake with the relay. */
  connectedPeers: NodeId[];
}

/** Start a relay on a free port with the standard tracking callbacks. */
async function startRelay(id = "relay"): Promise<TestRelay> {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const listenAddr: RelayListenAddress = `127.0.0.1:${port}`;
  const receivedAgents: Uint8Array[] = [];
  const connectedPeers: NodeId[] = [];
  const relay = await createRelay({
    id,
    addrs: [listenAddr],
    networkAccessHandler: async (_agentId, _bytes) => true,
    agentsReceivedCallback: async (_fromNode, agentInfos) => {
      receivedAgents.push(agentInfos);
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      connectedPeers.push(nodeId);
    },
  });
  return {
    relay,
    dialAddress: `/ip4/127.0.0.1/tcp/${port}/ws`,
    receivedAgents,
    connectedPeers,
  };
}

interface TestNode {
  node: ITransport;
  /** Node IDs that completed the access handshake with this node. */
  connectedPeers: NodeId[];
  /** Agent-info payloads this node has received, in arrival order. */
  receivedAgents: Uint8Array[];
  /** Messages this node has received, in arrival order. */
  messages: ReceivedMessage[];
  /** Latest dialable address snapshot from addressesChangedCallback. */
  addresses: () => NodeAddress[];
}

/** Start a node with the standard tracking callbacks. */
async function startNode(options: {
  id: string;
  addrs: NodeAddress[];
  bootstrapRelays: RelayDialAddress[];
  dialTimeoutMs?: number;
}): Promise<TestNode> {
  const connectedPeers: NodeId[] = [];
  const receivedAgents: Uint8Array[] = [];
  const messages: ReceivedMessage[] = [];
  let addresses: NodeAddress[] = [];
  const node = await createNode({
    id: options.id,
    addrs: options.addrs,
    bootstrapRelays: options.bootstrapRelays,
    dialTimeoutMs: options.dialTimeoutMs,
    networkAccessHandler: async (_agentId, _bytes) => true,
    addressesChangedCallback: async (newAddresses, _transport) => {
      addresses = newAddresses;
    },
    agentsReceivedCallback: async (_fromNode, agentInfos) => {
      receivedAgents.push(agentInfos);
    },
    peerConnectedCallback: async (nodeId, _transport) => {
      connectedPeers.push(nodeId);
    },
    messageHandler: async (fromNode, message, _transport) => {
      messages.push({ from: fromNode, bytes: message });
    },
  });
  return {
    node,
    connectedPeers,
    receivedAgents,
    messages,
    addresses: () => addresses,
  };
}

test("Bootstrap with relay and 2 nodes and send message over relayed connection", async () => {
  const {
    relay,
    dialAddress,
    receivedAgents: relayAgents,
    connectedPeers: relayPeers,
  } = await startRelay();

  // Node 1 binds only to the relay transport.
  const {
    node: node1,
    addresses: node1Addresses,
    connectedPeers: node1Peers,
    receivedAgents: node1Agents,
  } = await startNode({
    id: "node1",
    addrs: ["/p2p-circuit"],
    bootstrapRelays: [dialAddress],
  });

  // Wait for node 1 to reserve a slot on the relay and publish its address.
  await vi.waitUntil(
    () => node1Addresses().length > 0 && relayPeers.length === 1,
    { timeout: 5_000 },
  );

  // Node 1 sends its own (relayed) address to the relay as agent info.
  await node1.sendAgents(
    relay.getNodeId(),
    new TextEncoder().encode(JSON.stringify(node1Addresses())),
  );
  await vi.waitFor(() => expect(relayAgents.length).toBe(1));

  // Node 2 also binds only to the relay transport.
  const {
    node: node2,
    addresses: node2Addresses,
    connectedPeers: node2Peers,
    receivedAgents: node2Agents,
    messages: node2Messages,
  } = await startNode({
    id: "node2",
    addrs: ["/p2p-circuit"],
    bootstrapRelays: [dialAddress],
  });

  // Node 1 is still connected to the relay, so wait for 2 connected peers.
  await vi.waitUntil(
    () => node2Addresses().length > 0 && relayPeers.length === 2,
    { timeout: 5_000 },
  );

  // Relay forwards node 1's stored agent info to node 2.
  assert(relayAgents[0]);
  await relay.sendAgents(node2.getNodeId(), relayAgents[0]);
  await vi.waitFor(() => expect(node2Agents.length).toBe(1));

  // Node 2 connects to node 1 over the relay.
  const node1AddressList: NodeAddress[] = JSON.parse(
    new TextDecoder().decode(node2Agents[0]),
  );
  // Neither node has any peers yet.
  assert.deepEqual(node1Peers, []);
  assert.deepEqual(node2Peers, []);
  await node2.connect(node1AddressList);

  // Await the peerConnectedCallback to have fired for both nodes.
  await vi.waitUntil(() => node1Peers.length === 1 && node2Peers.length === 1);

  // Node 1 sends a message to node 2 over the relay.
  // Node 1 learned node 2's ID from the peerConnectedCallback.
  await node1.send(node1Peers[0], new TextEncoder().encode("hello-from-node1"));

  await vi.waitFor(() => expect(node2Messages.length).toBe(1));
  assert.equal(node2Messages[0]?.from, node1.getNodeId());
  assert.equal(
    new TextDecoder().decode(node2Messages[0]?.bytes),
    "hello-from-node1",
  );
  // Node 1 should never have been sent agent info.
  expect(node1Agents).toHaveLength(0);

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});

test("Bootstrap with relay and 2 nodes and send message over direct connection", async () => {
  const {
    relay,
    dialAddress,
    receivedAgents: relayAgents,
    connectedPeers: relayPeers,
  } = await startRelay();

  // Node 1 listens on relay + WebRTC, so it advertises a dialable direct
  // address as well as a relayed one.
  const {
    node: node1,
    addresses: node1Addresses,
    connectedPeers: node1Peers,
    receivedAgents: node1Agents,
  } = await startNode({
    id: "node1",
    addrs: ["/p2p-circuit", "/webrtc"],
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () =>
      node1Addresses().some((a) => a.includes("/webrtc")) &&
      relayPeers.length === 1,
    { timeout: 5_000 },
  );

  await node1.sendAgents(
    relay.getNodeId(),
    new TextEncoder().encode(JSON.stringify(node1Addresses())),
  );
  await vi.waitFor(() => expect(relayAgents.length).toBe(1));

  const {
    node: node2,
    addresses: node2Addresses,
    connectedPeers: node2Peers,
    receivedAgents: node2Agents,
    messages: node2Messages,
  } = await startNode({
    id: "node2",
    addrs: ["/p2p-circuit", "/webrtc"],
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () =>
      node2Addresses().some((a) => a.includes("/webrtc")) &&
      relayPeers.length === 2,
    { timeout: 5_000 },
  );

  // Relay forwards node 1's stored agent info to node 2.
  assert(relayAgents[0]);
  await relay.sendAgents(node2.getNodeId(), relayAgents[0]);
  await vi.waitFor(() => expect(node2Agents.length).toBe(1));

  // Node 2 connects to node 1; the WebRTC address yields a direct connection.
  const node1AddressList: NodeAddress[] = JSON.parse(
    new TextDecoder().decode(node2Agents[0]),
  );
  assert.deepEqual(node1Peers, []);
  assert.deepEqual(node2Peers, []);
  await node2.connect(node1AddressList);

  await vi.waitUntil(() => node1Peers.length === 1 && node2Peers.length === 1);

  // Wait for the direct connection to be established on both sides.
  await vi.waitUntil(
    () =>
      node1.isDirectConnection(node2.getNodeId()) &&
      node2.isDirectConnection(node1.getNodeId()),
    { timeout: 10_000 },
  );

  // Node 1 sends a message to node 2 over the direct connection.
  await node1.send(node1Peers[0], new TextEncoder().encode("hello-from-node1"));

  await vi.waitFor(() => expect(node2Messages.length).toBe(1));
  assert.equal(node2Messages[0]?.from, node1.getNodeId());
  assert.equal(
    new TextDecoder().decode(node2Messages[0]?.bytes),
    "hello-from-node1",
  );
  expect(node1Agents).toHaveLength(0);

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});

test("2 nodes fall back to relayed connection when direct connection fails", async () => {
  const { relay, dialAddress, connectedPeers: relayPeers } = await startRelay();

  // Node 1 listens on relay + WebRTC.
  const {
    node: node1,
    addresses: node1Addresses,
    connectedPeers: node1Peers,
  } = await startNode({
    id: "node1",
    addrs: ["/p2p-circuit", "/webrtc"],
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () => node1Addresses().length > 0 && relayPeers.length === 1,
    { timeout: 5_000 },
  );

  // Node 2 deliberately omits the WebRTC transport, so node 1's direct dial
  // fails and the connection must fall back to the relay. It is built by hand
  // because the factory always wires WebRTC in.
  const libp2pNode2 = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), dcutr: dcutr() },
    addresses: {
      listen: ["/p2p-circuit", "/webrtc"],
    },
  });
  // Fake WebRTC address node 1 will try (and fail) to dial directly.
  const fakeWebrtcAddr = `${dialAddress}/p2p/${relay.getNodeId()}/p2p-circuit/webrtc/p2p/${libp2pNode2.peerId}`;

  let node2Addresses: NodeAddress[] = [];
  const node2Peers: NodeId[] = [];
  const node2Messages: ReceivedMessage[] = [];
  const node2 = new TransportLibp2p(libp2pNode2, {
    id: "node2",
    networkAccessHandler: async (_agentId, _bytes) => true,
    addressesChangedCallback: async (addresses, _transport) => {
      node2Addresses = addresses;
    },
    agentsReceivedCallback: async (_fromNode, _agentInfos) => {},
    peerConnectedCallback: async (nodeId, _transport) => {
      assert.equal(nodeId, node1.getNodeId());
      node2Peers.push(nodeId);
    },
    messageHandler: async (fromNode, message, _transport) => {
      assert.equal(fromNode, node1.getNodeId());
      node2Messages.push({ from: fromNode, bytes: message });
    },
  });
  await libp2pNode2.start();
  await node2.connectToRelays([dialAddress]);

  await vi.waitUntil(
    () => node2Addresses.length > 0 && relayPeers.length === 2,
    { timeout: 5_000 },
  );

  // Node 1 dials the fake WebRTC (direct) address first, then node 2's real
  // relayed address.
  await node1.connect([fakeWebrtcAddr, ...node2Addresses]);

  await vi.waitUntil(() => node1Peers.length === 1 && node2Peers.length === 1);

  // The connection is relayed, not direct.
  assert.equal(node1.isDirectConnection(node2.getNodeId()), false);

  // Node 1 sends a message to node 2 over the relayed connection.
  await node1.send(node1Peers[0], new TextEncoder().encode("hello-from-node1"));

  await vi.waitFor(() => expect(node2Messages.length).toBe(1));
  assert.equal(node2Messages[0]?.from, node1.getNodeId());
  assert.equal(
    new TextDecoder().decode(node2Messages[0]?.bytes),
    "hello-from-node1",
  );

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});

test("connect tries multiple direct addresses and connects via a reachable one", async () => {
  // A dead direct address sits ahead of node 1's real addresses; the direct
  // connection must still form via the reachable WebRTC address.
  const { relay, dialAddress, connectedPeers: relayPeers } = await startRelay();

  const {
    node: node1,
    addresses: node1Addresses,
    connectedPeers: node1Peers,
  } = await startNode({
    id: "node1",
    addrs: ["/p2p-circuit", "/webrtc"],
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () => node1Addresses().length > 0 && relayPeers.length === 1,
    { timeout: 5_000 },
  );

  const {
    node: node2,
    addresses: node2Addresses,
    connectedPeers: node2Peers,
    messages: node2Messages,
  } = await startNode({
    id: "node2",
    addrs: ["/p2p-circuit", "/webrtc"],
    bootstrapRelays: [dialAddress],
    dialTimeoutMs: 2_000, // Short dial timeout for the test
  });

  await vi.waitUntil(
    () => node2Addresses().length > 0 && relayPeers.length === 2,
    { timeout: 5_000 },
  );

  // Unreachable direct address (nothing listens on port 1) first.
  const deadDirectAddr = `/ip4/127.0.0.1/tcp/1/ws/p2p/${node1.getNodeId()}`;
  await node2.connect([deadDirectAddr, ...node1Addresses()]);

  // Both sides observe the peer despite the dead entry in the list.
  await vi.waitUntil(() => node1Peers.length === 1 && node2Peers.length === 1, {
    timeout: 5_000,
  });

  // The reachable direct address yields a direct connection, not a relayed one.
  await vi.waitUntil(
    () =>
      node1.isDirectConnection(node2.getNodeId()) &&
      node2.isDirectConnection(node1.getNodeId()),
    { timeout: 10_000 },
  );

  await node1.send(node1Peers[0], new TextEncoder().encode("hello-from-node1"));
  await vi.waitFor(() => expect(node2Messages.length).toBe(1));
  assert.equal(node2Messages[0]?.from, node1.getNodeId());
  assert.equal(
    new TextDecoder().decode(node2Messages[0]?.bytes),
    "hello-from-node1",
  );

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});

test("connect tries multiple relayed addresses and connects via a reachable one", async () => {
  // A dead relay address sits ahead of node 1's real relayed address; the
  // relayed connection must still form via the live relay.
  const { relay, dialAddress, connectedPeers: relayPeers } = await startRelay();

  const {
    node: node1,
    addresses: node1Addresses,
    connectedPeers: node1Peers,
  } = await startNode({
    id: "node1",
    addrs: ["/p2p-circuit"], // No direct connection possible.
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () => node1Addresses().length > 0 && relayPeers.length === 1,
    { timeout: 5_000 },
  );

  const {
    node: node2,
    addresses: node2Addresses,
    connectedPeers: node2Peers,
    messages: node2Messages,
  } = await startNode({
    id: "node2",
    addrs: ["/p2p-circuit"],
    bootstrapRelays: [dialAddress],
  });

  await vi.waitUntil(
    () => node2Addresses().length > 0 && relayPeers.length === 2,
    { timeout: 5_000 },
  );

  // Relayed address routed through a relay that isn't running. Its peer id
  // differs from the live relay, so libp2p can't reuse the live connection.
  const deadRelayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const deadRelayedAddr = `/ip4/127.0.0.1/tcp/${deadRelayPort}/ws/p2p/QmDeadReLay/p2p-circuit/p2p/${node1.getNodeId()}`;

  // Dead relayed address first, node 1's real relayed address second.
  await node2.connect([deadRelayedAddr, ...node1Addresses()]);

  await vi.waitUntil(() => node1Peers.length === 1 && node2Peers.length === 1, {
    timeout: 5_000,
  });
  // The connection is relayed.
  assert.equal(node2.isDirectConnection(node1.getNodeId()), false);

  await node1.send(node1Peers[0], new TextEncoder().encode("hello-from-node1"));
  await vi.waitFor(() => expect(node2Messages.length).toBe(1));
  assert.equal(node2Messages[0]?.from, node1.getNodeId());
  assert.equal(
    new TextDecoder().decode(node2Messages[0]?.bytes),
    "hello-from-node1",
  );

  await node1.shutDown();
  await node2.shutDown();
  await relay.shutDown();
});
