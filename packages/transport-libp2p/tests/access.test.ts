import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CURRENT_ACCESS_PROTOCOL } from "../src/index.js";
import { NetworkAccessHandshake } from "../src/proto/access.js";
import { createNode, retryFnUntilTimeout, setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

afterEach(async () => {
  // Reset logger configuration
  await reset();
});

test("Remote node closes connection when host sends invalid network access bytes", async () => {
  const { node, address } = await createNode(
    "valid",
    undefined,
    (_agentId, _bytes) => Promise.resolve(false), // Rejects all access attempts.
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

test("Host node closes connection when remote node returns invalid network access bytes", async () => {
  const { node: _hostNode } = await createNode(
    "hostNode",
    undefined,
    (_agentId, _bytes) => Promise.resolve(false), // Rejects all access attempts.
  );

  // Create remote node that will send invalid network access bytes.
  const { node: _remoteNode } = await createNode(
    "remoteNode",
    undefined,
    (_agentId, _bytes) => Promise.resolve(true), // Allows all access attempts.
  );

  // To be completed when agents can be dialed by agent ID and handshake goes both ways.

  // await retryFnUntilTimeout(async () => connection.status === "closed");

  await _remoteNode.stop();
  await _hostNode.stop();
});

test("Opening a stream with an unknown protocol fails", async () => {
  const { node, address } = await createNode("valid");

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
  const { node, address } = await createNode("valid", undefined, () =>
    Promise.resolve(true),
  );

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

test("Network access handler is not repeatedly called for previously rejected agent", async () => {
  const networkAccessHandler = vi.fn().mockReturnValue(false); // Rejects all access
  const { node, address } = await createNode(
    "valid",
    undefined,
    networkAccessHandler,
  );

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  const agentId = new Uint8Array(32);
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(
    NetworkAccessHandshake.encode({
      agentId,
      networkAccessBytes: new TextEncoder().encode("invalid"),
    }),
  );
  await accessStream.close();
  console.log("once");

  await retryFnUntilTimeout(async () => connection.status === "closed");

  expect(networkAccessHandler).toHaveBeenCalledTimes(1);

  // Connect again to the same node
  const connection2 = await libp2pNode.dial(multiaddr(address));
  const accessStream2 = await connection2.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream2.send(
    NetworkAccessHandshake.encode({
      agentId,
      networkAccessBytes: new TextEncoder().encode("invalid"),
    }),
  );
  await accessStream2.close();

  await retryFnUntilTimeout(async () => connection2.status === "closed");

  // Callback should not have been called again
  expect(networkAccessHandler).toHaveBeenCalledTimes(1);

  await libp2pNode.stop();
  await node.stop();
});
