import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { memory } from "@libp2p/memory";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { setupTestLogger } from "@peerkit/test-utils";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import { createNode, uniqueTxAddress } from "./util.js";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

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

test("Connection can be closed", { timeout: 10_000 }, async () => {
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    messageHandler: async () => {},
  });

  const node2 = await createLibp2p({
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: [`/memory/${uniqueTxAddress()}`] },
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

  await node2.stop();
  await node1.shutDown();
});

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
