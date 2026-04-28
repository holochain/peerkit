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
import {
  createNode,
  makeAgentId,
  retryFnUntilTimeout,
  setupTestLogger,
} from "./util.js";

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

test("Two nodes can exchange agent infos", async () => {
  const receivedByResponder: Uint8Array[] = [];
  const receivedByInitiator: Uint8Array[] = [];

  // Responder node: grants all access, collects incoming agent bytes
  const { node: responder, address: responderAddress } = await createNode(
    "responder",
    async (_fromAgent, bytes) => {
      receivedByResponder.push(bytes);
    },
    (_agentId, _bytes) => Promise.resolve(true),
  );

  // Initiator node: grants all access, connects to responder as a bootstrap relay
  const { node: initiator } = await createNode(
    "initiator",
    async (_fromAgent, bytes) => {
      receivedByInitiator.push(bytes);
    },
    (_agentId, _bytes) => Promise.resolve(true),
    undefined,
    [responderAddress],
  );

  // After bootstrap, both sides should know each other — verify via sendAgents
  const responderAgentId = makeAgentId("responder");
  const initiatorAgentId = makeAgentId("initiator");

  await initiator.sendAgents(
    responderAgentId,
    new TextEncoder().encode("agents-from-initiator"),
  );
  await responder.sendAgents(
    initiatorAgentId,
    new TextEncoder().encode("agents-from-responder"),
  );

  await retryFnUntilTimeout(async () => receivedByResponder.length === 1);
  await retryFnUntilTimeout(async () => receivedByInitiator.length === 1);

  assert.equal(
    new TextDecoder().decode(receivedByResponder[0]),
    "agents-from-initiator",
  );
  assert.equal(
    new TextDecoder().decode(receivedByInitiator[0]),
    "agents-from-responder",
  );

  await initiator.stop();
  await responder.stop();
});
