import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CURRENT_ACCESS_PROTOCOL } from "../src/index.js";
import { NetworkAccessHandshake } from "../src/proto/access.js";
import {
  createNode,
  makeAgentId,
  retryFnUntilTimeout,
  setupTestLogger,
} from "./util.js";

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

test("Access handshake initiator closes connection when responder is denied", async () => {
  // Responder grants the initiator, but initiator will deny the responder.
  const { node: responder, address: responderAddress } = await createNode(
    "responder",
    undefined,
    (_agentId, _bytes) => Promise.resolve(true), // Grants initiator
  );

  // Initiator denies all incoming access — so after the outbound handshake response arrives,
  // it will deny the responder and close the connection.
  const { node: initiator } = await createNode(
    "initiator",
    undefined,
    (_agentId, _bytes) => Promise.resolve(false), // Denies responder
    undefined,
    [responderAddress],
  );

  // After bootstrap attempt, the initiator should have closed the connection.
  // The responder's agentId should not be reachable from initiator.
  const responderAgentId = makeAgentId("responder");
  await expect(
    initiator.sendAgents(responderAgentId, new Uint8Array([1])),
  ).rejects.toThrow();

  await initiator.stop();
  await responder.stop();
});

test("Outbound access handshake times out when responder sends no response", async () => {
  // Libp2p node that opens the access stream but never sends a response back.
  const libp2pNode = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
  });
  await libp2pNode.handle(CURRENT_ACCESS_PROTOCOL, async (stream) => {
    // Receive the initiator's handshake but never respond — causes timeout.
    stream.addEventListener("message", () => {}, { once: true });
  });

  const silentAddress = libp2pNode.getMultiaddrs()[0]!.toString();

  // Node with a very short timeout so the test doesn't take 10 s.
  // create() resolves — relay failures are logged but not fatal.
  const { node } = await createNode(
    "initiator",
    undefined,
    (_agentId, _bytes) => Promise.resolve(true),
    undefined,
    [silentAddress],
    50, // handshakeTimeoutMs
  );

  // The relay's agentId was never registered — sendAgents should throw.
  await expect(
    node.sendAgents(makeAgentId("relay"), new Uint8Array([1])),
  ).rejects.toThrow();

  await node.stop();
  await libp2pNode.stop();
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
