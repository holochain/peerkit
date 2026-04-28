import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_AGENTS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import { NetworkAccessHandshake } from "../src/proto/access.js";
import {
  createNode,
  createRelay,
  makeAgentId,
  retryFnUntilTimeout,
  setupTestLogger,
} from "./util.js";

beforeEach(setupTestLogger);

afterEach(async () => {
  await reset();
});

test("Invalid network access bytes closes connection to relay", async () => {
  const { relay, address } = await createRelay(
    "relay",
    undefined,
    (_fromAgent, _bytes) => Promise.resolve(false), // Rejects all access
  );

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(
    NetworkAccessHandshake.encode({
      agentId: new Uint8Array(32),
      networkAccessBytes: new TextEncoder().encode("invalid"),
    }),
  );
  await accessStream.close();

  await retryFnUntilTimeout(async () => connection.status === "closed");

  await libp2pNode.stop();
  await relay.stop();
});

test("Opening an agents stream without being granted access closes the connection", async () => {
  const { relay, address } = await createRelay("relay");

  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const stream = await connection.newStream(CURRENT_AGENTS_PROTOCOL);

  await retryFnUntilTimeout(async () => stream.status === "closed");

  await libp2pNode.stop();
  await relay.stop();
});

test("Relay rejects message protocol streams", async () => {
  const { relay, address } = await createRelay(
    "relay",
    undefined,
    (_fromAgent, _bytes) => Promise.resolve(true), // Allow all access
  );

  // Create a node, connect to relay, perform access handshake and check that opening a message stream fails.
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(
    NetworkAccessHandshake.encode({
      agentId: new Uint8Array(32),
      networkAccessBytes: new TextEncoder().encode("invalid"),
    }),
  );
  await accessStream.close();

  await expect(
    connection.newStream(CURRENT_MESSAGE_PROTOCOL),
  ).rejects.toThrow();

  await libp2pNode.stop();
  await relay.stop();
});

test("Relay knows node's agent infos after agent exchange", async () => {
  const agentInfoReceivedByRelay: Uint8Array[] = [];
  const nodeAgentId = makeAgentId("node1");

  // Relay collects incoming agent bytes and sends them back to the node
  const { relay, address: relayAddress } = await createRelay(
    "relay",
    async (fromAgent, bytes) => {
      agentInfoReceivedByRelay.push(bytes);
      // Echo agent info back to the sender
      await relay.sendAgents(fromAgent, bytes);
    },
    (_agentId, _bytes) => Promise.resolve(true),
  );

  const agentInfoReceivedByNode: Uint8Array[] = [];
  const { node } = await createNode(
    "node1",
    async (_fromAgent, bytes) => {
      agentInfoReceivedByNode.push(bytes);
    },
    (_agentId, _bytes) => Promise.resolve(true),
    undefined,
    [relayAddress],
  );

  // Send agent info from node to relay
  await node.sendAgents(
    makeAgentId("relay"),
    new TextEncoder().encode("node1-agent-info"),
  );

  // Relay receives it and echoes back; node receives the echo
  await retryFnUntilTimeout(async () => agentInfoReceivedByRelay.length === 1);
  await retryFnUntilTimeout(async () => agentInfoReceivedByNode.length === 1);

  assert.equal(
    new TextDecoder().decode(agentInfoReceivedByRelay[0]),
    "node1-agent-info",
  );
  assert.equal(
    new TextDecoder().decode(agentInfoReceivedByNode[0]),
    "node1-agent-info",
  );

  // Relay can reach the node by agentId (two-way handshake populated relay agent-peer-mapping)
  await relay.sendAgents(
    nodeAgentId,
    new TextEncoder().encode("relay-initiated"),
  );
  await retryFnUntilTimeout(async () => agentInfoReceivedByNode.length === 2);
  assert.equal(
    new TextDecoder().decode(agentInfoReceivedByNode[1]),
    "relay-initiated",
  );

  await node.stop();
  await relay.stop();
});
