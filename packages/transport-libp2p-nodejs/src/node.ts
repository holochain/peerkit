import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import type { NodeAddress, RelayDialAddress } from "@peerkit/api";
import {
  TransportLibp2p,
  type NodeOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";

/**
 * Default libp2p listen addresses for a peerkit node.
 *
 * `/p2p-circuit` enables inbound relayed connections.
 * WebRTC enables inbound direct connections.
 */
export const defaultNodeListenAddrs: NodeAddress[] = [
  "/p2p-circuit",
  "/webrtc",
];

/**
 * Node-specific options accepted by {@link createNode}, on top of the
 * platform-agnostic {@link NodeOptions}.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Raw libp2p multiaddr listen addresses, e.g. `"/p2p-circuit"`, `"/webrtc"`.
   *
   * **For testing only.** In production leave this unset and let the transport
   * use {@link defaultNodeListenAddrs}.
   *
   * Defaults to {@link defaultNodeListenAddrs}.
   */
  addrs?: NodeAddress[];
  /**
   * Relay multiaddrs to dial at startup. The transport invokes
   * {@link NodeOptions.connectedToRelayCallback} once the dialable circuit
   * address has been received.
   */
  bootstrapRelays?: RelayDialAddress[];
  /**
   * List of ICE server URLs needed for establishing direct connections.
   */
  iceServerUrls?: string[];
}

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
): Promise<TransportLibp2p> {
  // Build array of ICE servers if provided or leave undefined to use
  // libp2p default.
  const iceServers =
    options.iceServerUrls &&
    options.iceServerUrls.map((url) => ({
      urls: url,
    }));
  const libp2pNode = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    // Circuit relay transport enables connecting to peers through connected relays.
    transports: [
      webSockets(),
      webRTC({ rtcConfiguration: { iceServers } }),
      circuitRelayTransport(),
    ],
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
