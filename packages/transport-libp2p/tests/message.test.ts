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
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import type { MessageHandler, NetworkAccessHandler } from "@peerkit/interface";
import { createNode, retryFnUntilTimeout, setupTestLogger } from "./util.js";
import { isDeepStrictEqual } from "node:util";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Opening a message stream without being granted access closes the connection", async () => {
  const { node, address } = await createNode({ id: "valid" });

  // Create a node and try to open a stream with an unknown protocol.
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  // The protocol is registered, so newStream() succeeds.
  // The other node detects missing access and closes the connection asynchronously.
  const stream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  await retryFnUntilTimeout(async () => stream.status === "closed");

  await libp2pNode.stop();
  await node.shutDown();
});

test("Send a message after having been granted access", async () => {
  const receivedMessages: Uint8Array[] = [];
  // Define a message handler that stores received message for later assertion
  const messageHandler: MessageHandler = async (_fromAgent, message) => {
    receivedMessages.push(message);
  };
  // Create a node that will receive the message
  const { node: node1, address } = await createNode({
    id: "node1",
    messageHandler,
  });

  // Create a node that will send the message
  const { node: node2 } = await createNode({
    id: "node2",
  });
  await node2.connect(address);

  await node2.send(node1.getNodeId(), new TextEncoder().encode("hello"));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1);
  assert(receivedMessages[0]);
  assert.equal("hello", new TextDecoder().decode(receivedMessages[0]));

  await node2.shutDown();
  await node1.shutDown();
});

test("Send a message both ways on the same stream", async () => {
  const messagesReceived1: Uint8Array[] = [];
  // Define a message handler that stores received message for later assertion
  const messageHandler1: MessageHandler = async (_fromAgent, message) => {
    messagesReceived1.push(message);
  };
  // Create a node that will receive the message
  const { node: node1, address } = await createNode({
    id: "node1",
    messageHandler: messageHandler1,
  });

  // Create another node
  const messagesReceived2: Uint8Array[] = [];
  // Define a message handler that stores received message for later assertion
  const messageHandler2: MessageHandler = async (_fromAgent, message) => {
    messagesReceived2.push(message);
  };
  const { node: node2 } = await createNode({
    id: "node2",
    messageHandler: messageHandler2,
  });
  await node2.connect(address);

  // Send and receive message from node 2 to node 1
  await node2.send(node1.getNodeId(), new TextEncoder().encode("hello"));

  await retryFnUntilTimeout(async () => messagesReceived1.length === 1);
  assert(messagesReceived1[0]);
  assert.equal("hello", new TextDecoder().decode(messagesReceived1[0]));

  // The other way, send from node 1 to node 2
  await node1.send(node2.getNodeId(), new TextEncoder().encode("bye"));

  await retryFnUntilTimeout(async () => messagesReceived2.length === 1);
  assert(messagesReceived2[0]);
  assert.equal("bye", new TextDecoder().decode(messagesReceived2[0]));

  await node2.shutDown();
  await node1.shutDown();
});

test("Large messages are chunked and received correctly", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = new TextEncoder().encode("pass");
  const networkAccessHandler: NetworkAccessHandler = async (_agentId, bytes) =>
    isDeepStrictEqual(new Uint8Array(bytes), VALID_ACCESS_BYTES);
  // Define a message handler that stores received message for later assertion
  const receivedMessages: Uint8Array[] = [];
  const messageHandler: MessageHandler = async (_fromAgent, message) => {
    receivedMessages.push(message);
  };
  // Create a node that will receive the message
  const { node, address } = await createNode({
    id: "node1",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
    messageHandler,
  });

  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(VALID_ACCESS_BYTES);
  await accessStream.close();

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  // Send message that exceeds yamux message limit of 256 KiB.
  messageStream.send(encodeFrame(new Uint8Array(1024 * 300)));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1, 2000);
  assert.deepEqual(receivedMessages[0], new Uint8Array(1024 * 300));

  await libp2pNode.stop();
  await node.shutDown();
});
