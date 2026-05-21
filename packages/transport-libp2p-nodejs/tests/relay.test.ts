import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { memory } from "@libp2p/memory";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_AGENTS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import {
  createNode,
  createRelay,
  setupTestLogger,
  uniqueTxAddress,
} from "./util.js";

beforeEach(setupTestLogger);

afterEach(reset);

test("Invalid network access bytes closes connection to relay", async () => {
  const { relay, address } = await createRelay({
    id: "relay",
    networkAccessHandler: async (_fromPeer, _bytes) => false, // Rejects all access
  });

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const libp2pNode = await createLibp2p({
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: [`/memory/${uniqueTxAddress()}`] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new TextEncoder().encode("invalid"));
  await accessStream.close();

  await vi.waitUntil(() => connection.status === "closed");

  await libp2pNode.stop();
  await relay.shutDown();
});

test("Opening an agents stream without being granted access closes the connection", async () => {
  const { relay, address } = await createRelay({ id: "relay" });

  const libp2pNode = await createLibp2p({
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: [`/memory/${uniqueTxAddress()}`] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  assert(connection.status === "open");
  try {
    await connection.newStream(CURRENT_AGENTS_PROTOCOL);
  } catch {
    // On Linux the stream is closed so fast that `newStream` throws.
  }

  await vi.waitUntil(() => connection.status !== "open");

  await libp2pNode.stop();
  await relay.shutDown();
});

test("Relay rejects message protocol streams", async () => {
  const { relay, address } = await createRelay({
    id: "relay",
    networkAccessHandler: async (_fromPeer, _bytes) => true, // Allow all access
  });

  // Create a node, connect to relay, perform access handshake and check that opening a message stream fails.
  const libp2pNode = await createLibp2p({
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: [`/memory/${uniqueTxAddress()}`] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new TextEncoder().encode("invalid"));
  await accessStream.close();

  await expect(
    connection.newStream(CURRENT_MESSAGE_PROTOCOL),
  ).rejects.toThrow();

  await libp2pNode.stop();
  await relay.shutDown();
});

test("Relay knows node's agent infos after agent exchange", async () => {
  const agentInfosReceivedByRelay: Uint8Array[] = [];

  // Relay collects incoming agent bytes and sends them back to the node
  const { relay, address: relayAddress } = await createRelay({
    id: "relay",
    agentsReceivedCallback: async (_fromPeer, bytes) => {
      agentInfosReceivedByRelay.push(bytes);
    },
  });

  const agentInfosReceivedByNode: Uint8Array[] = [];
  const { node } = await createNode({
    id: "node1",
    agentsReceivedCallback: async (_fromPeer, bytes) => {
      agentInfosReceivedByNode.push(bytes);
    },
    peerConnectedCallback: async (_nodeId, _transport) => {},
    networkAccessHandler: async () => true,
    connectedToRelayCallback: async (_address, _nodeId, _transport) => {},
    messageHandler: async (_message) => {},
  });
  await node.connect(relayAddress);

  // Relay sends agent infos to node
  const agentInfosOnRelay = new TextEncoder().encode("relay-initiated");
  await relay.sendAgents(node.getNodeId(), agentInfosOnRelay);

  // Node receives them
  await vi.waitUntil(() => agentInfosReceivedByNode.length === 1);
  assert.deepEqual(agentInfosReceivedByNode[0], agentInfosOnRelay);

  // Send agent infos from node to relay
  const agentInfosOnNode = new TextEncoder().encode("node1-agent-info");
  await node.sendAgents(relay.getNodeId(), agentInfosOnNode);

  // Relay receives them
  await vi.waitUntil(() => agentInfosReceivedByRelay.length === 1);
  assert.deepEqual(agentInfosReceivedByRelay[0], agentInfosOnNode);

  await node.shutDown();
  await relay.shutDown();
});
