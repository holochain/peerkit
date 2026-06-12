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
  CURRENT_AGENTS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
  rewriteHostToPublicIp,
} from "../src/index.js";
import { createNode, createRelay, uniqueTxAddress } from "./util.js";

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

test("rewriteHostToPublicIp: swaps the IPv4 host, keeping certhash and peer id", () => {
  // The relay binds locally but announces its public IP; the live certhash and
  // the rest of the multiaddr must be preserved.
  assert.equal(
    rewriteHostToPublicIp(
      "/ip4/0.0.0.0/udp/9000/webrtc-direct/certhash/uHASH/p2p/12D3Koo",
      "1.2.3.4",
    ),
    "/ip4/1.2.3.4/udp/9000/webrtc-direct/certhash/uHASH/p2p/12D3Koo",
  );
});

test("rewriteHostToPublicIp: swaps the IPv6 host", () => {
  assert.equal(
    rewriteHostToPublicIp(
      "/ip6/::/udp/9000/webrtc-direct/certhash/uHASH",
      "::1",
    ),
    "/ip6/::1/udp/9000/webrtc-direct/certhash/uHASH",
  );
});

test("rewriteHostToPublicIp: rejects cross-family rewrites", () => {
  // Rewriting an IPv6 listener to an IPv4 address can advertise an unreachable
  // UDP port, so callers must filter by address family first.
  assert.throws(
    () =>
      rewriteHostToPublicIp(
        "/ip6/::/udp/9000/webrtc-direct/certhash/uHASH",
        "1.2.3.4",
      ),
    /cannot rewrite/,
  );
});

test("rewriteHostToPublicIp: throws on invalid public IP", () => {
  // Non-IP strings must be rejected immediately.
  assert.throws(
    () =>
      rewriteHostToPublicIp("/ip4/0.0.0.0/udp/9000/webrtc-direct", "not-an-ip"),
    /not a valid IP address/,
  );
});
