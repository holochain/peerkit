import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import type { ConnectionGater } from "@libp2p/interface";
import type { NodeAddress, RelayDialAddress } from "@peerkit/api";
import {
  TransportLibp2p,
  type NodeOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";
import { quickCryptoNoise } from "./quick-crypto-noise.js";

/**
 * Default libp2p listen addresses for a React Native peerkit node.
 *
 * Mobile peers cannot accept inbound direct TCP/UDP (CGNAT, no listen socket
 * survives backgrounding on iOS / Android), so reachability is always
 * relay-mediated: `/p2p-circuit` advertises a reservation on a connected
 * relay, `/webrtc` advertises that the peer can be upgraded to a direct
 * WebRTC connection through the relay-coordinated SDP exchange.
 */
export const defaultNodeListenAddrs: NodeAddress[] = [
  "/p2p-circuit",
  "/webrtc",
];

/**
 * React Native-specific options accepted by {@link createNode}, on top of the
 * platform-agnostic {@link NodeOptions}.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Listening addresses.
   *
   * Defaults to {@link defaultNodeListenAddrs}.
   */
  addrs?: string[];
  /**
   * Relay multiaddrs to dial at startup. Required on mobile — without an
   * active relay reservation the peer is unreachable. The transport invokes
   * {@link NodeOptions.connectedToRelayCallback} once the dialable circuit
   * address has been received.
   */
  bootstrapRelays?: RelayDialAddress[];
  /**
   * List of ICE server URLs needed for establishing direct connections.
   */
  iceServerUrls?: string[];
  /**
   * Overrides libp2p's connection gater.
   *
   * On React Native libp2p applies its browser gater, which refuses to dial
   * private/LAN addresses. A production deployment behind a public relay never
   * hits this, but development and demo setups that target a LAN relay or LAN
   * peers must supply a gater that permits those dials
   * (e.g. `{ denyDialMultiaddr: async () => false }`).
   *
   * Left undefined, libp2p keeps its secure-by-default browser gater.
   */
  connectionGater?: ConnectionGater;
}

/**
 * Build a React Native peerkit transport. Configures libp2p with WebRTC +
 * WebRTC Direct + circuit-relay-v2 client + noise + yamux + identify.
 *
 * Noise is wired with `quickCryptoNoise`, the JSI-backed `ICryptoInterface`
 * from `./quick-crypto-noise`, so SHA-256, HKDF, and ChaCha20-Poly1305 are
 * offloaded to `react-native-quick-crypto`. X25519 stays on pure JS because
 * `ICryptoInterface` is synchronous and quick-crypto's X25519 surface is not.
 *
 * Crypto primitives, RNG and the WebRTC globals come from runtime polyfills
 * — the consumer must import `@peerkit/transport-libp2p-react-native/polyfills`
 * once from the app entry before this factory runs.
 *
 * Handles all three peerkit protocols (access, agents, messages). DCUtR is
 * deliberately not registered: mobile cannot listen on TCP/QUIC, so there is
 * no relayed connection that can be upgraded by hole-punching; WebRTC ICE
 * provides the only viable direct-connection path on mobile.
 */
export async function createNode(options: CreateNodeOptions) {
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
    transports: [
      webRTC({ rtcConfiguration: { iceServers } }),
      webRTCDirect(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise({ crypto: quickCryptoNoise })],
    streamMuxers: [yamux()],
    services: { identify: identify() },
    connectionGater: options.connectionGater,
    addresses: {
      listen: options.addrs ?? defaultNodeListenAddrs,
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  // Connect to all provided relays. Fire-and-forget: the transport calls
  // connectedToRelayCallback on successful connect to a relay.
  if (options.bootstrapRelays?.length) {
    transport.connectToRelays(options.bootstrapRelays);
  }
  return transport;
}
