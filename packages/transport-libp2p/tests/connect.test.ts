import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  reset,
} from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import type {
  IMessageHandler,
  INetworkAccessHandler,
} from "../src/types/transport.js";
import { encodeFrame } from "../src/frame.js";
import { NetworkAccessHandshake } from "../src/proto/access.js";
import { createTransport, retryFnUntilTimeout } from "./util.js";

beforeEach(async () => {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: getAnsiColorFormatter({
          format({ timestamp, level, category, message, record }) {
            let output = `${timestamp} ${level} ${category}`;
            // If `id` is included in record properties, print it in every
            // log before the message and other properties.
            // This makes it easier in interleaved logs to know which node is
            // emitting the log.
            if (typeof record.properties.id === "string") {
              output = output + ` ${record.properties.id}`;
            }
            output = output + `: ${message}`;
            return output;
          },
        }),
      }),
    },
    loggers: [
      {
        category: "peerkit",
        lowestLevel: "info",
        sinks: ["console"],
      },
    ],
  });
});

afterEach(async () => {
  // Reset logger configuration
  await reset();
});

test("Invalid network access bytes closes connection", async () => {
  const { node, address } = await createTransport(
    "valid",
    (_agentId, _bytes) => false, // Rejects all access attempts.
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
  await node.stop();
});

test("Opening a stream with an unknown protocol fails", async () => {
  const { node, address } = await createTransport("valid");

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
  await expect(connection.newStream("/unknown/protocol")).rejects.toThrow();

  await libp2pNode.stop();
  await node.stop();
});

test("Sending malformed bytes on the access stream closes the connection", async () => {
  const { node, address } = await createTransport("valid", () => true);

  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  await accessStream.close();

  // Connection should be closed after the malformed handshake.
  await retryFnUntilTimeout(async () => connection.status === "closed");

  await libp2pNode.stop();
  await node.stop();
});

test("Opening a message stream without being granted access closes the connection", async () => {
  const { node, address } = await createTransport("valid");

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
  // The protocol is registered so newStream() succeeds at the muxer level.
  // The server detects missing access and closes the connection asynchronously.
  const stream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  await retryFnUntilTimeout(async () => stream.status === "closed");

  await libp2pNode.stop();
  await node.stop();
});

test("Send a message after having been granted access", async () => {
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: INetworkAccessHandler = (_agentId, bytes) =>
    bytes.toString() === VALID_ACCESS_BYTES;
  const receivedMessages: Uint8Array[] = [];
  const messageHandler: IMessageHandler = (_fromAgent, message) =>
    receivedMessages.push(message);

  const { node, address } = await createTransport(
    "node1",
    networkAccessHandler,
    messageHandler,
  );

  const encoder = new TextEncoder();
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
      networkAccessBytes: encoder.encode(VALID_ACCESS_BYTES),
    }),
  );
  await accessStream.close();

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  messageStream.send(encodeFrame(encoder.encode("hello")));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1);
  assert.equal(new TextDecoder().decode(receivedMessages[0]), "hello");

  await libp2pNode.stop();
  await node.stop();
});

test("Large messages are chunked and received correctly", async () => {
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: INetworkAccessHandler = (_agentId, bytes) =>
    bytes.toString() === VALID_ACCESS_BYTES;
  const receivedMessages: Uint8Array[] = [];
  const messageHandler: IMessageHandler = (_fromAgent, message) =>
    receivedMessages.push(message);

  const { node, address } = await createTransport(
    "node1",
    networkAccessHandler,
    messageHandler,
  );

  const encoder = new TextEncoder();
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
      networkAccessBytes: encoder.encode(VALID_ACCESS_BYTES),
    }),
  );
  await accessStream.close();

  const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
  messageStream.send(encodeFrame(new Uint8Array(1024 * 300)));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1, 2000);
  assert.deepEqual(receivedMessages[0], new Uint8Array(1024 * 300));

  await libp2pNode.stop();
  await node.stop();
});
