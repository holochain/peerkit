import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import type { ITransport, NodeAddress, RelayAddress } from "@peerkit/api";
import {
  TransportLibp2p,
  type NodeOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";

/**
 * Default libp2p listen addresses for a peerkit node.
 *
 * `/p2p-circuit` enables inbound relayed connections.
 * WebSocket enables direct outbound connections to the relay.
 */
export const defaultNodeListenAddrs: NodeAddress[] = [
  "/p2p-circuit",
  "/ip4/0.0.0.0/tcp/0/ws",
  "/ip6/::/tcp/0/ws",
];

/**
 * Like {@link defaultNodeListenAddrs} but also includes `/dns4/localhost`,
 * which identify will advertise to peers and allows relayed
 * connections to upgrade to direct ones when all peers are on the same machine.
 *
 * Use this as the default in local-development tools.
 * Do not use in production.
 */
export const localDevNodeListenAddrs: NodeAddress[] = [
  "/p2p-circuit",
  "/dns4/localhost/tcp/0/ws",
  "/ip4/0.0.0.0/tcp/0/ws",
  "/ip6/::/tcp/0/ws",
];

/**
 * Node-specific options accepted by {@link createNode}, on top of the
 * platform-agnostic {@link NodeOptions}.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Listening addresses
   *
   * Defaults to {@link defaultNodeListenAddrs}
   */
  addrs?: string[];
  /**
   * Relay multiaddrs to dial at startup. The transport invokes
   * {@link NodeOptions.connectedToRelayCallback} once the dialable circuit
   * address has been received.
   */
  bootstrapRelays?: RelayAddress[];
}

// function createNodeCommon(): TransportLibp2p {}

/**
 * Build a Node.js peerkit transport node
 *
 * Configures libp2p with WebSockets + circuit-relay-v2 client + noise +
 * yamux + identify + DCUtR.
 *
 * Handles all three protocols (access, agents, messages). The caller invokes
 * {@link TransportLibp2p.sendAgents} explicitly to distribute agent-info.
 */
export async function createNode(
  options: CreateNodeOptions,
): Promise<ITransport> {
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
