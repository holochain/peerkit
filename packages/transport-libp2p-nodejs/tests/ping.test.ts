import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { memory } from "@libp2p/memory";
import { ping, type Ping } from "@libp2p/ping";
import { reset } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import { setupTestLogger } from "@peerkit/test-utils";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createRelay } from "./util.js";

beforeEach(setupTestLogger);

afterEach(reset);

/**
 * Spin up a bare libp2p dialer with the ping service registered. Stands in
 * for an external monitor that probes the relay over `/ipfs/ping/1.0.0`.
 */
async function createPinger(): Promise<Libp2p<{ ping: Ping }>> {
  return createLibp2p({
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { ping: ping() },
  });
}

test("Relay with enablePing answers ping and yields a non-negative RTT", async () => {
  // Build a relay that opts into the ping protocol.
  const { relay, address } = await createRelay({
    id: "relay",
    enablePing: true,
  });

  const pinger = await createPinger();

  // The pinger dials the relay's ping protocol directly — note it never
  // performs the /peerkit/access/v1 handshake, mirroring an external monitor
  // that holds no NetworkAccessBytes.
  const rtt = await pinger.services.ping.ping(multiaddr(address));

  // ping resolves to the measured round-trip time in milliseconds.
  expect(rtt).toBeGreaterThanOrEqual(0);

  await pinger.stop();
  await relay.shutDown();
});

test("Relay without enablePing does not register the ping protocol", async () => {
  // Default relay: ping is opt-in, so it must be off.
  const { relay, address } = await createRelay({ id: "relay" });

  const pinger = await createPinger();

  // Dialing the unregistered ping protocol must fail: the relay never
  // negotiates `/ipfs/ping/1.0.0`.
  await expect(pinger.services.ping.ping(multiaddr(address))).rejects.toThrow();

  await pinger.stop();
  await relay.shutDown();
});
