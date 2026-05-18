import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { isIP } from "node:net";
import {
  TransportLibp2p,
  type NodeOptions,
  type RelayOptions,
} from "@peerkit/transport-libp2p-core";
import type { RelayAddress } from "@peerkit/api";

/**
 * Default libp2p listen addresses for a peerkit node.
 *
 * `/p2p-circuit` enables inbound relayed connections. TCP enables direct
 * inbound connections (required for hole-punching to work).
 */
export const defaultNodeListenAddrs: string[] = [
  "/p2p-circuit",
  "/ip4/0.0.0.0/tcp/0",
  "/ip6/::/tcp/0",
];

/**
 * Like {@link defaultNodeListenAddrs} but also includes `/dns4/localhost`,
 * which identify will advertise to peers and allows relayed
 * connections to upgrade to direct ones when all peers are on the same machine.
 *
 * Use this as the default in local-development tools.
 * Do not use in production.
 */
export const localDevNodeListenAddrs: string[] = [
  "/p2p-circuit",
  "/dns4/localhost/tcp/0",
  "/ip4/0.0.0.0/tcp/0",
  "/ip6/::/tcp/0",
];

/**
 * Default listen address for a peerkit relay, suitable for local development.
 * Binds to all interfaces on port 9000.
 */
export const defaultRelayListenAddr = "/ip4/0.0.0.0/tcp/9000";

/**
 * Build the public announce address for a relay sitting behind NAT.
 * Peers use this address to dial the relay; the relay itself still binds
 * to `listenAddr`.
 *
 * @param listenAddr  The relay's local listen address.
 * @param publicIp    The relay's externally-reachable IP address.
 */
export function buildRelayAnnounceAddr(
  listenAddr: string,
  publicIp: string,
): string {
  const version = isIP(publicIp);
  if (version === 0) {
    throw new Error(
      `buildRelayAnnounceAddr: "${publicIp}" is not a valid IP address`,
    );
  }
  const prefix = version === 6 ? "/ip6" : "/ip4";
  const port = /\/tcp\/(\d+)/.exec(listenAddr)?.[1] ?? "9000";
  return `${prefix}/${publicIp}/tcp/${port}`;
}

/**
 * Node-specific options accepted by {@link createNode}, on top of the
 * platform-agnostic {@link NodeOptions}.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Listening multiaddrs. Defaults to `/p2p-circuit`, `/ip4/0.0.0.0/tcp/0`,
   * `/ip6/::/tcp/0` — circuit listening enables relayed inbound, TCP enables
   * direct inbound.
   */
  addrs?: string[];
  /**
   * Relay multiaddrs to dial at startup. The transport invokes
   * {@link NodeOptions.connectedToRelayCallback} once the dialable circuit
   * address has been received.
   */
  bootstrapRelays?: RelayAddress[];
}

/**
 * Node-specific options accepted by {@link createRelay}, on top of the
 * platform-agnostic {@link RelayOptions}.
 */
export interface CreateRelayOptions extends RelayOptions {
  /**
   * Listening multiaddrs. Defaults to `/ip4/0.0.0.0/tcp/0`, `/ip6/::/tcp/0`.
   */
  addrs?: string[];
}

/**
 * Build a Node.js peerkit transport. Configures libp2p with TCP +
 * circuit-relay-v2 client + noise + yamux + identify + dcutr.
 *
 * Handles all three protocols (access, agents, messages). The caller invokes
 * {@link TransportLibp2p.sendAgents} explicitly to distribute agent-info.
 */
export async function createNode(
  options: CreateNodeOptions,
): Promise<TransportLibp2p> {
  const libp2pNode = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    // Circuit relay transport enables connecting to peers through connected relays.
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), dcutr: dcutr() },
    addresses: {
      listen: options?.addrs ?? defaultNodeListenAddrs,
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  // Connect to all provided relays. Fire-and-forget: the transport calls
  // connectedToRelayCallback on successful connect to a relay.
  if (options?.bootstrapRelays?.length) {
    transport.connectToRelays(options.bootstrapRelays);
  }
  return transport;
}

/**
 * Build a Node.js peerkit relay transport. Configures libp2p with TCP +
 * circuit-relay-v2 server + noise + yamux + identify.
 *
 * Handles access and agents protocols; does not register the message
 * protocol. The relay-v2 server is configured with `applyDefaultLimit: false`
 * so the relay can serve as a permanent data-channel fallback.
 */
export async function createRelay(
  options: CreateRelayOptions,
): Promise<TransportLibp2p> {
  const libp2pNode = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Circuit relay server enables relay functionality.
    // applyDefaultLimit: false removes the 2-min / 128 KiB per-connection
    // caps so the relay can serve as a permanent data-channel fallback.
    services: {
      relay: circuitRelayServer({
        reservations: { applyDefaultLimit: false },
      }),
      identify: identify(),
    },
    addresses: {
      listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0"],
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  return transport;
}
