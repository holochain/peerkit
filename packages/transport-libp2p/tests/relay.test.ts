import { reset } from "@logtape/logtape";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
} from "../src/index.js";
import { createRelay, retryFnUntilTimeout, setupTestLogger } from "./util.js";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { multiaddr } from "@multiformats/multiaddr";
import { NetworkAccessHandshake } from "../src/proto/access.js";

beforeEach(setupTestLogger);

afterEach(async () => {
  await reset();
});

test("Invalid network access bytes closes connection to relay", async () => {
  const { relay, address } = await createRelay(
    "relay",
    undefined,
    (_fromAgent, _bytes) => false, // Rejects all access
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
  await relay.stop();
});

test("Relay rejects message protocol streams", async () => {
  const { relay, address } = await createRelay(
    "relay",
    undefined,
    (_fromAgent, _bytes) => true, // Allow all access
  );

  // Create a node, connect to relay, perform access handshake and check that opening a message stream fails.
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

  await expect(
    connection.newStream(CURRENT_MESSAGE_PROTOCOL),
  ).rejects.toThrow();

  await libp2pNode.stop();
  await relay.stop();
});
