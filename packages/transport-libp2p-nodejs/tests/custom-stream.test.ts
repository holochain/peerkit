import { reset } from "@logtape/logtape";
import { IStream } from "@peerkit/api";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { createNode, setupTestLogger } from "./util.js";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { yamux } from "@chainsafe/libp2p-yamux";
import { noise } from "@chainsafe/libp2p-noise";
import { multiaddr } from "@multiformats/multiaddr";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Opening a custom stream without being granted access closes the connection", async () => {
  const CUSTOM_PROTOCOL = "/app/custom/v1";
  const customStreamCreatedCallback = vi.fn();
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    networkAccessHandler: async (_nodeId, _bytes) => true,
    customStreamCreatedCallbacks: {
      [CUSTOM_PROTOCOL]: customStreamCreatedCallback,
    },
  });

  const node2 = await createLibp2p({
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
  });

  const connection = await node2.dial(multiaddr(address1));
  const stream = await connection.newStream(CUSTOM_PROTOCOL);
  // newStream() succeeds locally but node1 closes the connection once the access check fails
  await vi.waitUntil(() => connection.status !== "open");
  expect(stream.status === "closed");
  expect(customStreamCreatedCallback).to.not.toHaveBeenCalled();

  await node2.stop();
  await node1.shutDown();
});

test("Open a custom stream on an existing connection", async () => {
  // Create a node with a custom protocol handler.
  const messagesReceivedFromNode2: Uint8Array[] = [];
  let customStream1: IStream;
  const CUSTOM_PROTOCOL = "/app/custom/v1";
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    customStreamCreatedCallbacks: {
      [CUSTOM_PROTOCOL]: async (stream) => {
        customStream1 = stream;
      },
    },
  });

  // Create a second node
  const { node: node2 } = await createNode({ id: "node2" });

  // Node 2 connects to node 1
  await node2.connect(address1);
  // and opens a custom stream with the same protocol that node 1
  // registered a handler for.
  const customStream2 = await node2.createStream(
    node1.getNodeId(),
    CUSTOM_PROTOCOL,
  );

  customStream1 = await vi.waitUntil(() => customStream1);
  customStream1.addEventListener("message", (message) => {
    messagesReceivedFromNode2.push(message);
  });

  // Send a message on the custom stream
  const expectedMessage = new Uint8Array([1]);
  customStream2.send(expectedMessage);

  // Expect the message from node 2 to be received by node 1.
  await vi.waitUntil(
    () =>
      messagesReceivedFromNode2.length === 1 && messagesReceivedFromNode2[0],
  );
  assert.deepEqual(messagesReceivedFromNode2[0], expectedMessage);

  // Now send a message the other way around, node 1 to node 2.
  const messagesReceivedFromNode1: Uint8Array[] = [];
  const expectedMessage2 = new Uint8Array([2]);
  const messageListener = (message: Uint8Array) => {
    messagesReceivedFromNode1.push(message);
  };
  customStream2.addEventListener("message", messageListener);
  customStream1.send(expectedMessage2);

  // Expect the message from node 1 to be received by node 2.
  await vi.waitUntil(
    () =>
      messagesReceivedFromNode1.length === 1 && messagesReceivedFromNode1[0],
  );
  assert.deepEqual(messagesReceivedFromNode1[0], expectedMessage2);

  // Remove event listener and check it's no longer firing.
  customStream2.removeEventListener("message", messageListener);
  // Add a different listener to receive the message
  const newMessagesReceivedByNode1: Uint8Array[] = [];
  customStream2.addEventListener("message", (message) =>
    newMessagesReceivedByNode1.push(message),
  );
  // Send a message the other way around, node 1 to node 2.
  customStream1.send(new Uint8Array([3]));
  await vi.waitFor(() => expect(newMessagesReceivedByNode1.length).toBe(1));
  expect(messagesReceivedFromNode1.length).toBe(1); // still only the first message

  // Close stream and check it's closed.
  customStream1.addEventListener("remoteClose", async () => {
    await customStream1.close();
  });
  await customStream2.close();
  await vi.waitUntil(() => !customStream1.isOpen());
  expect(() => customStream2.send(new Uint8Array([0]))).toThrow();
  expect(() => customStream1.send(new Uint8Array([0]))).toThrow();

  await node2.shutDown();
  await node1.shutDown();
});
