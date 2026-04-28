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
