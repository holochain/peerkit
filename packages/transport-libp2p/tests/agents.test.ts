import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, test } from "vitest";
import { encodeFrame } from "../src/frame.js";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_AGENTS_PROTOCOL,
} from "../src/index.js";
import { NetworkAccessHandshake } from "../src/proto/access.js";
import { INetworkAccessHandler } from "../src/types/transport.js";
import { createNode, retryFnUntilTimeout, setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

afterEach(async () => {
  // Reset logger configuration
  await reset();
});

test("Opening an agents stream without being granted access closes the connection", async () => {
  const { node, address } = await createNode("node1");

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
  await node.stop();
});

test("Agents channel round-trip after access handshake", async () => {
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: INetworkAccessHandler = (_agentId, bytes) =>
    Promise.resolve(bytes.toString() === VALID_ACCESS_BYTES);
  const receivedAgents: Array<{ fromAgent: Uint8Array; bytes: Uint8Array }> =
    [];
  const agentsReceivedCallback = async (
    fromAgent: Uint8Array,
    bytes: Uint8Array,
  ) => {
    receivedAgents.push({ fromAgent, bytes });
  };
  const { node, address } = await createNode(
    "node1",
    agentsReceivedCallback,
    networkAccessHandler,
  );

  const encoder = new TextEncoder();
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const agentId = new Uint8Array(32).fill(1);
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(
    NetworkAccessHandshake.encode({
      agentId,
      networkAccessBytes: encoder.encode(VALID_ACCESS_BYTES),
    }),
  );
  await accessStream.close();

  const agentsStream = await connection.newStream(CURRENT_AGENTS_PROTOCOL);
  agentsStream.send(encodeFrame(encoder.encode("agent-info")));
  await agentsStream.close();

  await retryFnUntilTimeout(async () => receivedAgents.length === 1);
  assert.deepEqual(receivedAgents[0]!.fromAgent, agentId);
  assert.equal(
    new TextDecoder().decode(receivedAgents[0]!.bytes),
    "agent-info",
  );

  await libp2pNode.stop();
  await node.stop();
});
