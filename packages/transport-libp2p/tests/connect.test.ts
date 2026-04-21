import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  reset,
} from "@logtape/logtape";
import { Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, assert, beforeEach, expect, test } from "vitest";
import { CURRENT_MESSAGE_PROTOCOL } from "../src/index.js";
import {
  IMessageHandler,
  INetworkAccessHandler,
} from "../src/types/transport.js";
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

test("A node can connect to a bootstrap node and identify its own listening address", async () => {
  const { node: bootstrapNode, address: bootstrapNodeAddress } =
    await createTransport("bootstrap", () => true);

  // Create a node and connect to the bootstrap node.
  const { node } = await createTransport("node");
  const newAddressPromise = new Promise<Multiaddr[]>((resolve, reject) => {
    node.setNewAddressesHandler((addrs) => resolve(addrs));
    setTimeout(reject, 1000);
  });
  await node.connect(multiaddr(bootstrapNodeAddress), new Uint8Array(1));

  // Wait for the new listening addresses to have been identified.
  const newAddresses = await newAddressPromise;
  assert(newAddresses.length);

  await node.stop();
  await bootstrapNode.stop();
});

test("Invalid network access bytes closes connection", async () => {
  const { node: validNode, address: validNodeAddress } = await createTransport(
    "valid",
    () => false, // Network access handler rejects all attempts.
  );

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const { node: invalidNode } = await createTransport("invalid");
  await expect(
    invalidNode.connect(
      multiaddr(validNodeAddress),
      new TextEncoder().encode("invalid"),
    ),
  ).rejects.toThrow();

  await invalidNode.stop();
  await validNode.stop();
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
  await expect(
    connection.newStream(CURRENT_MESSAGE_PROTOCOL),
  ).rejects.toThrow();

  await libp2pNode.stop();
  await node.stop();
});

test("Send a message after having been granted access", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = "pass";
  const networkAccessHandler: INetworkAccessHandler = (bytes) =>
    bytes.toString() === VALID_ACCESS_BYTES;
  // Define a message handler that stores received message for later assertion
  const receivedMessages: Uint8Array[] = [];
  const messageHandler: IMessageHandler = (message) =>
    receivedMessages.push(message);
  // Create a node that will receive the message
  const { node: node1, address: address1 } = await createTransport(
    "node1",
    networkAccessHandler,
    messageHandler,
  );

  // Node 2 connects to node 1 and sends a message.
  const encoder = new TextEncoder();
  const { node: node2 } = await createTransport("node2");
  const connection = await node2.connect(
    multiaddr(address1),
    encoder.encode(VALID_ACCESS_BYTES),
  );
  connection.send(encoder.encode("hello"));

  await retryFnUntilTimeout(async () => receivedMessages.length === 1);
  assert.equal(receivedMessages[0].toString(), "hello");

  await node2.stop();
  await node1.stop();
});
