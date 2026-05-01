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
import { INetworkAccessHandler } from "../src/types/transport.js";
import { createNode, retryFnUntilTimeout, setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Opening an agents stream without being granted access closes the connection", async () => {
  const { node, address } = await createNode({ id: "node1" });

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
  const networkAccessHandler: INetworkAccessHandler = (_fromPeer, bytes) =>
    Promise.resolve(bytes.toString() === VALID_ACCESS_BYTES);
  const receivedAgents: Array<{ fromPeer: string; bytes: Uint8Array }> = [];
  const agentsReceivedCallback = async (
    fromPeer: string,
    bytes: Uint8Array,
  ) => {
    receivedAgents.push({ fromPeer, bytes });
  };
  const { node, address } = await createNode({
    id: "node1",
    agentsReceivedCallback,
    networkAccessHandler,
  });

  const encoder = new TextEncoder();
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(encoder.encode(VALID_ACCESS_BYTES));
  await accessStream.close();

  const agentsStream = await connection.newStream(CURRENT_AGENTS_PROTOCOL);
  agentsStream.send(encodeFrame(encoder.encode("agent-info")));
  await agentsStream.close();

  await retryFnUntilTimeout(async () => receivedAgents.length === 1);
  assert.equal(receivedAgents[0]!.fromPeer, libp2pNode.peerId.toString());
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
  const { node: responder, address: responderAddress } = await createNode({
    id: "responder",
    agentsReceivedCallback: async (_fromPeer, bytes) => {
      receivedByResponder.push(bytes);
    },
    networkAccessHandler: async (_fromPeer, _bytes) => true,
  });

  // Initiator node: grants all access, connects to responder as a bootstrap relay
  const { node: initiator } = await createNode({
    id: "initiator",
    agentsReceivedCallback: async (_fromPeer, bytes) => {
      receivedByInitiator.push(bytes);
    },
    networkAccessHandler: async (_fromPeer, _bytes) => true,
    bootstrapRelays: [responderAddress],
  });

  // After bootstrap, both sides should know each other — verify via sendAgents
  await initiator.sendAgents(
    responder.getNodeId(),
    new TextEncoder().encode("agents-from-initiator"),
  );
  await responder.sendAgents(
    initiator.getNodeId(),
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
