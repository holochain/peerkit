import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { webSockets } from "@libp2p/websockets";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { CURRENT_AGENTS_PROTOCOL } from "../src/index.js";
import type { NetworkAccessHandler } from "@peerkit/api";
import { createNode, setupTestLogger } from "./util.js";
import { isDeepStrictEqual } from "node:util";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Opening an agents stream without being granted access closes the connection", async () => {
  const { node, address } = await createNode({ id: "node1" });

  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] },
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
  await node.shutDown();
});

test("Agents channel round-trip after access handshake", async () => {
  const VALID_ACCESS_BYTES = new TextEncoder().encode("pass");
  const networkAccessHandler: NetworkAccessHandler = async (_fromPeer, bytes) =>
    isDeepStrictEqual(new Uint8Array(bytes), VALID_ACCESS_BYTES);
  const receivedAgents: Array<{ fromPeer: string; bytes: Uint8Array }> = [];
  const agentsReceivedCallback = async (
    fromPeer: string,
    bytes: Uint8Array,
  ) => {
    receivedAgents.push({ fromPeer, bytes });
  };
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    agentsReceivedCallback,
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
  });

  const { node: node2 } = await createNode({
    id: "node2",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
  });

  await node2.connect(address1);

  await node2.sendAgents(
    node1.getNodeId(),
    new TextEncoder().encode("agent-info"),
  );

  await vi.waitFor(() => expect(receivedAgents.length).toBe(1));
  assert(receivedAgents[0]);
  assert.equal(receivedAgents[0].fromPeer, node2.getNodeId().toString());
  assert.equal(new TextDecoder().decode(receivedAgents[0].bytes), "agent-info");

  await node2.shutDown();
  await node1.shutDown();
});

test("Large agents payload can be received", async () => {
  const receivedAgents: Uint8Array[] = [];
  const agentsReceivedCallback = async (
    _fromPeer: string,
    bytes: Uint8Array,
  ) => {
    receivedAgents.push(bytes);
  };
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    agentsReceivedCallback,
  });

  const { node: node2 } = await createNode({ id: "node2" });

  // Both nodes allow access to all

  await node2.connect(address1);

  // Send a 300 KiB message. Yamux frames support up to 256 KiB by default.
  const largeAgentsMessage = new Uint8Array(1024 * 300).fill(12);
  await node2.sendAgents(node1.getNodeId(), largeAgentsMessage);

  await vi.waitFor(() => expect(receivedAgents.length).toBe(1));
  assert(receivedAgents[0]);
  assert(isDeepStrictEqual(receivedAgents[0], largeAgentsMessage));

  await node2.shutDown();
  await node1.shutDown();
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
  });

  // Initiator node: grants all access, connects to responder
  const { node: initiator } = await createNode({
    id: "initiator",
    agentsReceivedCallback: async (_fromPeer, bytes) => {
      receivedByInitiator.push(bytes);
    },
  });

  await initiator.connect(responderAddress);

  // After bootstrap, both sides should know each other — verify via sendAgents
  await initiator.sendAgents(
    responder.getNodeId(),
    new TextEncoder().encode("agents-from-initiator"),
  );
  await responder.sendAgents(
    initiator.getNodeId(),
    new TextEncoder().encode("agents-from-responder"),
  );

  await vi.waitFor(() => expect(receivedByResponder.length).toBe(1));
  await vi.waitFor(() => expect(receivedByInitiator.length).toBe(1));

  assert.equal(
    new TextDecoder().decode(receivedByResponder[0]),
    "agents-from-initiator",
  );
  assert.equal(
    new TextDecoder().decode(receivedByInitiator[0]),
    "agents-from-responder",
  );

  await initiator.shutDown();
  await responder.shutDown();
});
