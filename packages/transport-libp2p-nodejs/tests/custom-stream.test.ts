import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { memory } from "@libp2p/memory";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import type { IStream } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { createNode, uniqueTxAddress } from "./util.js";

const PROTOCOL_A = "/app/custom/v1";
const PROTOCOL_B = "/app/other/v1";

beforeEach(setupTestLogger);
afterEach(reset);

// ─── Access control ──────────────────────────────────────────────────────────

test("Opening a custom stream without being granted access closes the connection", async () => {
  // A raw libp2p peer that skips the peerkit access handshake must have its
  // connection torn down before any custom stream handler is invoked.
  const customStreamCreatedCallback = vi.fn();
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    networkAccessHandler: async (_nodeId, _bytes) => true,
  });
  node1.registerStreamHandler(PROTOCOL_A, customStreamCreatedCallback);

  const node2 = await createLibp2p({
    transports: [memory()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    addresses: { listen: [`/memory/${uniqueTxAddress()}`] },
  });

  const connection = await node2.dial(multiaddr(address1));
  const stream = await connection.newStream(PROTOCOL_A);
  // newStream() succeeds locally, but node1 closes the connection once the
  // access check fails — the custom handler must never be called.
  await vi.waitUntil(() => connection.status !== "open");
  expect(stream.status).toBe("closed");
  expect(customStreamCreatedCallback).not.toHaveBeenCalled();

  await node2.stop();
  await node1.shutDown();
});

// ─── createStream ────────────────────────────────────────────────────────────

test("createStream throws when the target node is not connected", async () => {
  // Passing any unknown NodeId should reject immediately.
  const { node: node1 } = await createNode({ id: "node1" });
  const { node: node2 } = await createNode({ id: "node2" });

  // node1 and node2 have never connected, so node2's ID is unknown to node1.
  await expect(
    node1.createStream(node2.getNodeId(), PROTOCOL_A),
  ).rejects.toThrow();

  await node1.shutDown();
  await node2.shutDown();
});

// ─── Messaging ───────────────────────────────────────────────────────────────

test("Messages flow from the initiator to the handler", async () => {
  // The initiator opens a stream. The handler receives messages sent on it.
  let handlerStream: IStream;
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  handlerStream = await vi.waitUntil(() => handlerStream);

  const received: Uint8Array[] = [];
  handlerStream.addEventListener("message", (data) => received.push(data));

  initiatorStream.send(new Uint8Array([1]));
  initiatorStream.send(new Uint8Array([2]));

  await vi.waitUntil(() => received.length === 2);
  assert.deepEqual(received[0], new Uint8Array([1]));
  assert.deepEqual(received[1], new Uint8Array([2]));

  await node2.shutDown();
  await node1.shutDown();
});

test("Messages flow from the handler back to the initiator", async () => {
  // Streams are bidirectional, the handler can send back to the initiator.
  let handlerStream: IStream;
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  handlerStream = await vi.waitUntil(() => handlerStream);

  const received: Uint8Array[] = [];
  initiatorStream.addEventListener("message", (data) => received.push(data));

  handlerStream.send(new Uint8Array([10]));
  handlerStream.send(new Uint8Array([20]));

  await vi.waitUntil(() => received.length === 2);
  assert.deepEqual(received[0], new Uint8Array([10]));
  assert.deepEqual(received[1], new Uint8Array([20]));

  await node2.shutDown();
  await node1.shutDown();
});

// ─── Event listeners ─────────────────────────────────────────────────────────

test("removeEventListener stops the listener from receiving further messages", async () => {
  // After removeEventListener, the removed listener must not fire even if new
  // messages arrive. Other listeners on the same stream must still fire.
  let handlerStream: IStream;
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  handlerStream = await vi.waitUntil(() => handlerStream);

  // Register two listeners; confirm the first fires for the initial message.
  const removedCount: Uint8Array[] = [];
  const keptCount: Uint8Array[] = [];
  const removableListener = (data: Uint8Array) => removedCount.push(data);
  initiatorStream.addEventListener("message", removableListener);
  initiatorStream.addEventListener("message", (data) => keptCount.push(data));

  handlerStream.send(new Uint8Array([1]));
  await vi.waitUntil(() => removedCount.length === 1 && keptCount.length === 1);

  // Remove the first listener; the second message must only reach the kept one.
  initiatorStream.removeEventListener("message", removableListener);
  handlerStream.send(new Uint8Array([2]));
  await vi.waitUntil(() => keptCount.length === 2);

  expect(removedCount.length).toBe(1);

  await node2.shutDown();
  await node1.shutDown();
});

test("remoteClose event fires on the handler side when the initiator closes", async () => {
  // Closing the initiator's write end must emit remoteClose on the handler.
  let handlerStream: IStream;
  const remoteCloseFired = vi.fn();

  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
    stream.addEventListener("remoteClose", remoteCloseFired);
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  await vi.waitUntil(() => handlerStream);

  await initiatorStream.close();
  await vi.waitUntil(() => remoteCloseFired.mock.calls.length > 0);
  expect(remoteCloseFired).toHaveBeenCalledOnce();

  await node2.shutDown();
  await node1.shutDown();
});

test("remoteClose event fires on the initiator side when the handler closes", async () => {
  // Closing the handler's write end must emit remoteClose on the initiator.
  let handlerStream: IStream;
  const remoteCloseFired = vi.fn();

  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );
  initiatorStream.addEventListener("remoteClose", remoteCloseFired);

  handlerStream = await vi.waitUntil(() => handlerStream);

  await handlerStream.close();
  await vi.waitUntil(() => remoteCloseFired.mock.calls.length > 0);
  expect(remoteCloseFired).toHaveBeenCalledOnce();

  await node2.shutDown();
  await node1.shutDown();
});

// ─── isOpen / send after close ───────────────────────────────────────────────

test("isOpen() returns true while open and false after both sides close", async () => {
  // isOpen() must reflect the live state of the stream.
  let handlerStream: IStream;
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
    // Close our end when the initiator closes theirs.
    stream.addEventListener("remoteClose", () => void stream.close());
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  handlerStream = await vi.waitUntil(() => handlerStream);
  expect(initiatorStream.isOpen()).toBe(true);
  expect(handlerStream.isOpen()).toBe(true);

  await initiatorStream.close();
  await vi.waitUntil(
    () => !initiatorStream.isOpen() && !handlerStream.isOpen(),
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("send() throws after the stream is closed", async () => {
  // Calling send() on a closed stream must throw synchronously on both sides.
  let handlerStream: IStream;
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStream = stream;
    stream.addEventListener("remoteClose", () => void stream.close());
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);
  const initiatorStream = await node2.createStream(
    node1.getNodeId(),
    PROTOCOL_A,
  );

  handlerStream = await vi.waitUntil(() => handlerStream);

  await initiatorStream.close();
  await vi.waitUntil(
    () => !initiatorStream.isOpen() && !handlerStream.isOpen(),
  );

  expect(() => initiatorStream.send(new Uint8Array([0]))).toThrow();
  expect(() => handlerStream.send(new Uint8Array([0]))).toThrow();

  await node2.shutDown();
  await node1.shutDown();
});

// ─── Multiple streams / protocols ────────────────────────────────────────────

test("Multiple concurrent streams on the same protocol are handled independently", async () => {
  // The handler is called once per stream; messages on each stream must not
  // leak across to the other.
  const handlerStreams: IStream[] = [];
  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerStreams.push(stream);
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);

  const initiator1 = await node2.createStream(node1.getNodeId(), PROTOCOL_A);
  const initiator2 = await node2.createStream(node1.getNodeId(), PROTOCOL_A);

  // Both streams must each get their own handler invocation.
  await vi.waitUntil(() => handlerStreams.length === 2);

  const received0: Uint8Array[] = [];
  const received1: Uint8Array[] = [];
  handlerStreams[0]!.addEventListener("message", (data) =>
    received0.push(data),
  );
  handlerStreams[1]!.addEventListener("message", (data) =>
    received1.push(data),
  );

  initiator1.send(new Uint8Array([10]));
  initiator2.send(new Uint8Array([20]));

  await vi.waitUntil(() => received0.length === 1 && received1.length === 1);
  assert.deepEqual(received0[0], new Uint8Array([10]));
  assert.deepEqual(received1[0], new Uint8Array([20]));

  await node2.shutDown();
  await node1.shutDown();
});

test("Two protocols are dispatched to their respective handlers only", async () => {
  // Registering two protocol handlers on the same node must not cross-fire:
  // a stream on PROTOCOL_A must not invoke the PROTOCOL_B handler and vice versa.
  const handlerA = vi.fn();
  const handlerB = vi.fn();
  let streamA: IStream;
  let streamB: IStream;

  const { node: node1, address: address1 } = await createNode({ id: "node1" });
  node1.registerStreamHandler(PROTOCOL_A, (_fromAgent, stream) => {
    handlerA();
    streamA = stream;
  });
  node1.registerStreamHandler(PROTOCOL_B, (_fromAgent, stream) => {
    handlerB();
    streamB = stream;
  });

  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address1);

  // Open a stream on PROTOCOL_A — only handlerA must fire.
  await node2.createStream(node1.getNodeId(), PROTOCOL_A);
  await vi.waitUntil(() => streamA !== undefined);
  expect(handlerA).toHaveBeenCalledOnce();
  expect(handlerB).not.toHaveBeenCalled();

  // Open a stream on PROTOCOL_B — only handlerB must fire, handlerA stays at one.
  await node2.createStream(node1.getNodeId(), PROTOCOL_B);
  await vi.waitUntil(() => streamB !== undefined);
  expect(handlerB).toHaveBeenCalledOnce();
  expect(handlerA).toHaveBeenCalledOnce();

  await node2.shutDown();
  await node1.shutDown();
});
