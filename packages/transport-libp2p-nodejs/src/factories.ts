import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import {
  TransportLibp2p,
  type NodeOptions,
  type RelayOptions,
} from "@peerkit/transport-libp2p-core";
import type { RelayAddress } from "@peerkit/api";

/**
 * Node-specific options accepted by {@link createNode}, on top of the
 * platform-agnostic {@link NodeOptions}.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Listening multiaddrs. Defaults to `/p2p-circuit`, `/ip4/0.0.0.0/tcp/0/ws`,
   * `/ip6/::/tcp/0/ws` — circuit listening enables relayed inbound, WebSocket
   * enables direct inbound.
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
   * Listening multiaddrs. Defaults to `/ip4/0.0.0.0/tcp/0/ws`, `/ip6/::/tcp/0/ws`.
   */
  addrs?: string[];
}

/**
 * Build a Node.js peerkit transport. Configures libp2p with WebSocket +
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
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), dcutr: dcutr() },
    addresses: {
      listen: options?.addrs ?? [
        "/p2p-circuit", // p2p-circuit enables listening for relayed connections
        "/ip4/0.0.0.0/tcp/0/ws",
        "/ip6/::/tcp/0/ws",
      ],
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
 * Build a Node.js peerkit relay transport. Configures libp2p with WebSocket +
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
    transports: [webSockets()],
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
      listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0/ws", "/ip6/::/tcp/0/ws"],
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  return transport;
}
