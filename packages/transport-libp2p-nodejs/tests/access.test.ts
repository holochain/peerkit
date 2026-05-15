import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { webSockets } from "@libp2p/websockets";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { type NetworkAccessHandler } from "@peerkit/api";
import { createLibp2p } from "libp2p";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CURRENT_ACCESS_PROTOCOL } from "../src/index.js";
import { createNode, setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

// Reset logger configuration
afterEach(reset);

test("Remote node closes connection when host sends invalid network access bytes", async () => {
  const { node, address } = await createNode({
    id: "valid",
    networkAccessHandler: async (_fromPeer, _bytes) => false, // Rejects all access attempts.
  });

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new TextEncoder().encode("invalid"));
  await accessStream.close();

  await vi.waitUntil(() => connection.status === "closed");

  await libp2pNode.stop();
  await node.shutDown();
});

test("Access handshake initiator closes connection when responder is denied", async () => {
  // Responder grants the initiator, but initiator will deny the responder.
  const { node: responder, address: responderAddress } = await createNode({
    id: "responder",
    networkAccessHandler: async (_fromPeer, _bytes) => true, // Grants initiator
  });

  // Initiator denies all incoming access — so after the outbound handshake response arrives,
  // it will deny the responder and close the connection.
  const { node: initiator } = await createNode({
    id: "initiator",
    networkAccessHandler: async (_fromPeer, _bytes) => false, // Denies responder
    bootstrapRelays: [responderAddress],
  });

  // After bootstrap attempt, the initiator should have closed the connection.
  // The responder's peer ID should not be reachable from initiator.
  await expect(
    initiator.sendAgents(responder.getNodeId(), new Uint8Array([0])),
  ).rejects.toThrow();

  await initiator.shutDown();
  await responder.shutDown();
});

test("Outbound access handshake times out when responder sends no response", async () => {
  // Libp2p node that opens the access stream but never sends a response back.
  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] },
  });
  await libp2pNode.handle(CURRENT_ACCESS_PROTOCOL, async (stream) => {
    // Receive the initiator's handshake but never respond — causes timeout.
    stream.addEventListener("message", () => {}, { once: true });
  });

  const silentAddress = libp2pNode.getMultiaddrs()[0]!.toString();

  // Node with a very short timeout so the test doesn't take 10 s.
  // create() resolves — relay failures are logged but not fatal.
  const { node } = await createNode({
    id: "initiator",
    networkAccessHandler: async (_fromPeer, _bytes) => true,
    bootstrapRelays: [silentAddress],
    handshakeTimeoutMs: 50,
  });

  // The silent node's peer ID was never granted access — sendAgents should throw.
  await expect(
    node.sendAgents(libp2pNode.peerId.toString(), new Uint8Array([0])),
  ).rejects.toThrow();

  await node.shutDown();
  await libp2pNode.stop();
});

test("Remote node closes connection when host sends invalid ACK byte", async () => {
  const { node, address } = await createNode({ id: "valid" }); // Grants access to all

  // Create a node that passes correct network access bytes but sends invalid ACK byte.
  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  const receiveNabFromRemote = new Promise((resolve) => {
    accessStream.addEventListener(
      "message",
      (_nabResponse) => {
        accessStream.send(new Uint8Array([0])); // Invalid ACK byte
        resolve(undefined);
      },
      { once: true },
    );
  });
  accessStream.send(new TextEncoder().encode("valid"));
  await receiveNabFromRemote;

  await vi.waitUntil(() => connection.status === "closed");

  await libp2pNode.stop();
  await node.shutDown();
});

test("Valid network access bytes grant connection to other node", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = new TextEncoder().encode("pass");
  const networkAccessHandler: NetworkAccessHandler = async (
    _fromNode,
    bytes,
  ) => {
    // bytes is a Buffer in Nodejs
    return isDeepStrictEqual(new Uint8Array(bytes), VALID_ACCESS_BYTES);
  };

  const peerConnectedCallback1 = vi.fn().mockResolvedValue(undefined);
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
    peerConnectedCallback: peerConnectedCallback1,
  });

  const peerConnectedCallback2 = vi.fn().mockResolvedValue(undefined);
  const { node: node2 } = await createNode({
    id: "node2",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
    peerConnectedCallback: peerConnectedCallback2,
  });

  await node2.connect(address1);

  await vi.waitFor(() => expect(peerConnectedCallback1).toHaveBeenCalled());
  await vi.waitFor(() => expect(peerConnectedCallback2).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 1000));

  await node1.shutDown();
  await node2.shutDown();
});

test("Invalid network access bytes deny connection to initiating node", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = new TextEncoder().encode("pass");
  const networkAccessHandler: NetworkAccessHandler = async (
    _fromNode,
    bytes,
  ) => {
    // bytes is a Buffer in Nodejs
    return isDeepStrictEqual(new Uint8Array(bytes), VALID_ACCESS_BYTES);
  };

  const peerConnectedCallback1 = vi.fn();
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
    peerConnectedCallback: peerConnectedCallback1,
  });

  const peerConnectedCallback2 = vi.fn();
  const { node: node2 } = await createNode({
    id: "node2",
    networkAccessHandler,
    networkAccessBytes: new Uint8Array([1]), // invalid access bytes
    peerConnectedCallback: peerConnectedCallback2,
  });

  await expect(node2.connect(address1)).rejects.toThrow();
  expect(peerConnectedCallback1).to.not.toHaveBeenCalled();
  expect(peerConnectedCallback2).to.not.toHaveBeenCalled();

  await node1.shutDown();
  await node2.shutDown();
});

test("Invalid network access bytes deny connection to remote node", async () => {
  // Define an access handler
  const VALID_ACCESS_BYTES = new TextEncoder().encode("pass");
  const networkAccessHandler: NetworkAccessHandler = async (
    _fromNode,
    bytes,
  ) => {
    // bytes is a Buffer in Nodejs
    return isDeepStrictEqual(new Uint8Array(bytes), VALID_ACCESS_BYTES);
  };

  const peerConnectedCallback1 = vi.fn();
  const { node: node1, address: address1 } = await createNode({
    id: "node1",
    networkAccessHandler,
    networkAccessBytes: new Uint8Array([1]), // invalid access bytes
    peerConnectedCallback: peerConnectedCallback1,
  });

  const peerConnectedCallback2 = vi.fn();
  const { node: node2 } = await createNode({
    id: "node2",
    networkAccessHandler,
    networkAccessBytes: VALID_ACCESS_BYTES,
    peerConnectedCallback: peerConnectedCallback2,
  });

  await expect(node2.connect(address1)).rejects.toThrow();
  expect(peerConnectedCallback1).to.not.toHaveBeenCalled();
  expect(peerConnectedCallback2).to.not.toHaveBeenCalled();

  await node1.shutDown();
  await node2.shutDown();
});

test("Opening a stream with an unknown protocol fails", async () => {
  const { node, address } = await createNode({ id: "valid" });

  // Create a node and try to open a stream with an unknown protocol.
  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0/ws"],
    },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  await expect(connection.newStream("/unknown/protocol")).rejects.toThrow();

  await libp2pNode.stop();
  await node.shutDown();
});

test("Network access handler is not repeatedly called for previously rejected peer", async () => {
  const networkAccessHandler = vi.fn().mockReturnValue(false); // Rejects all access
  const { node, address } = await createNode({
    id: "valid",
    networkAccessHandler,
  });

  // Create a node and pass invalid network access bytes to the connection attempt.
  // Connection should not succeed.
  const libp2pNode = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] },
  });
  const connection = await libp2pNode.dial(multiaddr(address));
  const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream.send(new TextEncoder().encode("invalid"));
  await accessStream.close();

  await vi.waitUntil(() => connection.status === "closed");

  expect(networkAccessHandler).toHaveBeenCalledTimes(1);

  // Connect again to the same node
  const connection2 = await libp2pNode.dial(multiaddr(address));
  const accessStream2 = await connection2.newStream(CURRENT_ACCESS_PROTOCOL);
  accessStream2.send(new TextEncoder().encode("invalid"));
  await accessStream2.close();

  await vi.waitUntil(() => connection2.status === "closed");

  // Callback should not have been called again
  expect(networkAccessHandler).toHaveBeenCalledTimes(1);

  await libp2pNode.stop();
  await node.shutDown();
});
