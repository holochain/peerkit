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
import {
  MessageHandler,
  NetworkAccessHandler,
} from "../src/types/transport.js";
import { createNode, retryFnUntilTimeout, setupTestLogger } from "./util.js";

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
  // The protocol is registered so newStream() succeeds.
  // The server detects missing access and closes the connection asynchronously.
  const stream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  await retryFnUntilTimeout(async () => stream.status === "closed");

  await libp2pNode.stop();
  await node.shutDown();
});

test("Send a message after having been granted access", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: NetworkAccessHandler = (_agentId, bytes) =>
    Promise.resolve(bytes.toString() === VALID_ACCESS_BYTES);
  const receivedMessages: Uint8Array[] = [];
  // Define a message handler that stores received message for later assertion
  const messageHandler: MessageHandler = (_fromAgent, message) => {
    receivedMessages.push(message);
    return Promise.resolve();
  };
  // Create a node that will receive the message
  const { node, address } = await createNode({
    id: "node1",
    networkAccessHandler,
    messageHandler,
  });

  // Create a node that will receive the message
  const encoder = new TextEncoder();
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  // Connect to the first node, perform access handshake and send message
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(encoder.encode(VALID_ACCESS_BYTES));
  await accessStream.close();

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  messageStream.send(encodeFrame(encoder.encode("hello")));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1);
  assert.equal(new TextDecoder().decode(receivedMessages[0]), "hello");

  await libp2pNode.stop();
  await node.shutDown();
});

test("Large messages are chunked and received correctly", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: NetworkAccessHandler = (_agentId, bytes) =>
    Promise.resolve(bytes.toString() === VALID_ACCESS_BYTES);
  // Define a message handler that stores received message for later assertion
  const receivedMessages: Uint8Array[] = [];
  const messageHandler: MessageHandler = (_fromAgent, message) => {
    receivedMessages.push(message);
    return Promise.resolve();
  };
  // Create anode that will receive the message
  const { node, address } = await createNode({
    id: "node1",
    networkAccessHandler,
    messageHandler,
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

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  // Send message that exceeds yamux message limit of 256 KiB.
  messageStream.send(encodeFrame(new Uint8Array(1024 * 300)));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1, 2000);
  assert.deepEqual(receivedMessages[0], new Uint8Array(1024 * 300));

  await libp2pNode.stop();
  await node.shutDown();
});
