import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import type {
  ITransport,
  RelayDialAddress,
  RelayListenAddress,
} from "@peerkit/api";
import {
  TransportLibp2p,
  type RelayOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";
import { isIP } from "node:net";
import { hostPortToMultiaddr } from "./address.js";

/**
 * Default listen addresses for a peerkit relay.
 *
 * Binds to all IPv4 and IPv6 interfaces on an OS-assigned ephemeral port.
 * Suitable for tests and development environments where any free port works.
 */
export const defaultRelayListenAddrs: RelayListenAddress[] = [
  "0.0.0.0:0",
  "[::]:0",
];

/**
 * Default listen address for a peerkit relay, suitable for local development.
 * Binds to all IPv4 interfaces on port 9000.
 *
 * Use this as the default in local-development tools.
 * Do not use in production.
 */
export const localDevRelayListenAddr: RelayListenAddress = "0.0.0.0:9000";

/**
 * Build the public announce address for a relay sitting behind NAT.
 * Peers use this address to dial the relay. The relay itself still binds
 * to `listenAddr`.
 *
 * @param listenAddr  The relay's local listen address in `"host:port"` format.
 * @param publicIp    The relay's externally-reachable IP address.
 */
export function buildRelayAnnounceAddr(
  listenAddr: RelayListenAddress,
  publicIp: string,
): RelayDialAddress {
  const url = new URL(`ws://${listenAddr}`);
  const port = url.port;
  if (!port || port === "0") {
    throw new Error(
      `buildRelayAnnounceAddr: "${listenAddr}" uses port 0 or has no port, which is not dialable`,
    );
  }
  const version = isIP(publicIp);
  if (version === 0) {
    throw new Error(
      `buildRelayAnnounceAddr: "${publicIp}" is not a valid IP address`,
    );
  }
  const prefix = version === 6 ? "/ip6" : "/ip4";
  return `${prefix}/${publicIp}/tcp/${port}/ws`;
}

/**
 * Node-specific options accepted by {@link createRelay}, on top of the
 * platform-agnostic {@link RelayOptions}.
 */
export interface CreateRelayOptions extends RelayOptions {
  /**
   * Listening addresses in `"host:port"` format (e.g. `"0.0.0.0:4001"`).
   *
   * IPv6 addresses must use bracket notation: `"[::]:4001"`.
   *
   * Defaults to {@link defaultRelayListenAddrs}.
   */
  addrs?: RelayListenAddress[];
  /**
   * Public IP to announce when the relay is behind NAT.
   *
   * The transport computes `/ip4/<ip>/tcp/<port>/ws` (or `/ip6/…`) for each
   * listen address and configures libp2p to advertise it. Peers dial the
   * public address; the relay still binds locally to `addrs`.
   */
  publicIp?: string;
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
  const addrs = options?.addrs ?? defaultRelayListenAddrs;
  const listenMultiaddrs = addrs.map(hostPortToMultiaddr);

  // If a public IP has been configured, the relay should use it to announce
  // its dialable addresses.
  const announce: string[] = [];
  if (options.publicIp) {
    for (const addr of addrs) {
      announce.push(buildRelayAnnounceAddr(addr, options.publicIp));
    }
  }

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
      listen: listenMultiaddrs,
      ...(announce.length > 0 ? { announce } : {}),
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  return transport;
}
