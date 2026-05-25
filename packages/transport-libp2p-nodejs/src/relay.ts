import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import type { ITransport, RelayAddress } from "@peerkit/api";
import {
  TransportLibp2p,
  type RelayOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";
import { isIP } from "node:net";

/**
 * Default libp2p listen addresses for a peerkit relay.
 */
export const defaultRelayListenAddrs: RelayAddress[] = [
  "/ip4/0.0.0.0/tcp/0/ws",
  "/ip6/::/tcp/0/ws",
];

/**
 * Default listen address for a peerkit relay, suitable for local development.
 * Binds to all interfaces on port 9000.
 *
 * Use this as the default in local-development tools.
 * Do not use in production.
 */
export const localDevRelayListenAddr: RelayAddress = "/ip4/0.0.0.0/tcp/9000/ws";

/**
 * Build the public announce address for a relay sitting behind NAT.
 * Peers use this address to dial the relay. The relay itself still binds
 * to `listenAddr`.
 *
 * @param listenAddr  The relay's local listen address.
 * @param publicIp    The relay's externally-reachable IP address.
 */
export function buildRelayAnnounceAddr(
  listenAddr: string,
  publicIp: string,
): RelayAddress {
  const version = isIP(publicIp);
  if (version === 0) {
    throw new Error(
      `buildRelayAnnounceAddr: "${publicIp}" is not a valid IP address`,
    );
  }
  const prefix = version === 6 ? "/ip6" : "/ip4";
  const port = /\/tcp\/(\d+)/.exec(listenAddr)?.[1] ?? "9000";
  if (port === "0") {
    throw new Error(
      `buildRelayAnnounceAddr: listenAddr "${listenAddr}" uses port 0, which is not dialable`,
    );
  }
  return `${prefix}/${publicIp}/tcp/${port}/ws`;
}

/**
 * Node-specific options accepted by {@link createRelay}, on top of the
 * platform-agnostic {@link RelayOptions}.
 */
export interface CreateRelayOptions extends RelayOptions {
  /**
   * Listening addresses
   *
   * Defaults to {@link defaultRelayListenAddrs}
   */
  addrs?: string[];
  /**
   * Opt into the libp2p ping protocol (`/ipfs/ping/1.0.0`). Defaults to
   * `false`.
   *
   * Ping is a transport-level liveness/RTT probe: a dialer sends a
   * payload, the relay echoes it, and the dialer measures round-trip time.
   * Useful for external monitoring of relay liveness, latency measurement
   * before selecting a bootstrap relay, and keeping NAT/firewall mappings warm.
   *
   * Ping runs as a libp2p service handler, independent of the
   * `/peerkit/access/v1` gate: it is **not** blocked for peers that have not
   * completed the network-access handshake, so external monitors can health-
   * check the relay without holding `NetworkAccessBytes`.
   */
  enablePing?: boolean;
}

/**
 * Build a Node.js peerkit relay transport
 *
 * Configures libp2p with WebSocket + circuit-relay-v2 server + noise + yamux
 * + identify.
 *
 * Handles access and agents protocols. Does not register the message
 * protocol. The relay-v2 server is configured with `applyDefaultLimit: false`
 * so the relay can serve as a permanent data-channel fallback.
 */
export async function createRelay(
  options: CreateRelayOptions,
): Promise<ITransport> {
  const libp2pNode = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Circuit relay server enables relay functionality.
    // applyDefaultLimit: false removes the 2-min / 128 KiB per-connection
    // caps so the relay can serve as a permanent data-channel fallback.
    // ping is opt-in (off by default) for external liveness/RTT health checks.
    services: {
      relay: circuitRelayServer({
        reservations: { applyDefaultLimit: false },
      }),
      identify: identify(),
      ...(options.enablePing ? { ping: ping() } : {}),
    },
    addresses: {
      listen: options?.addrs ?? defaultRelayListenAddrs,
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  return transport;
}
