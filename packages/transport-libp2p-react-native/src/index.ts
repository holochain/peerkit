import {
  TransportLibp2p,
  type NodeOptions,
} from "@peerkit/transport-libp2p-core";

/**
 * Node-specific options accepted by {@link createNode}.
 *
 * Mirrors the shape of `@peerkit/transport-libp2p-nodejs` so the facade
 * `@peerkit/transport-libp2p` can present a uniform API across platforms.
 */
export interface CreateNodeOptions extends NodeOptions {
  /**
   * Listening multiaddrs. Mobile peers cannot accept inbound direct
   * connections (CGNAT + no listen socket on iOS/Android), so the only
   * meaningful value is `/p2p-circuit` for relayed inbound.
   */
  addrs?: string[];
  /**
   * Relay multiaddrs to dial at startup. Required on mobile because the node
   * can only be reached through a relay.
   */
  bootstrapRelays?: string[];
}

/**
 * Build a React Native peerkit transport.
 *
 * Not yet implemented. Planned stack: WebSocket client + WebRTC +
 * circuit-relay-v2 client, with `react-native-quick-crypto` providing the
 * Noise crypto primitives. See issue #15 for the full design.
 */
export async function createNode(
  _options: CreateNodeOptions,
): Promise<TransportLibp2p> {
  throw new Error(
    "@peerkit/transport-libp2p-react-native: createNode is not yet implemented",
  );
}

export {
  TransportLibp2p,
  CURRENT_ACCESS_PROTOCOL,
  CURRENT_AGENTS_PROTOCOL,
  CURRENT_MESSAGE_PROTOCOL,
  type NodeOptions,
  type RelayOptions,
  type TransportOptionsBase,
} from "@peerkit/transport-libp2p-core";
