import type { RelayListenAddress } from "@peerkit/api";
import { isIP } from "node:net";

/**
 * Convert a `"host:port"` relay listen address to a libp2p WebSocket multiaddr.
 *
 * Supports IPv4, IPv6 (with brackets), and hostnames.
 * Internal to the transport, so callers pass {@link RelayListenAddress}
 * and never see the multiaddr form.
 */
export function hostPortToMultiaddr(hostPort: RelayListenAddress): string {
  const url = new URL(`ws://${hostPort}`);
  const hostname = url.hostname;
  const port = url.port;
  if (!port) {
    throw new Error(
      `hostPortToMultiaddr: "${hostPort}" must include an explicit port`,
    );
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 0) {
    throw new Error(`Invalid relay hostname: ${hostname}`);
  }
  const prefix = ipVersion === 0 ? "/dns" : ipVersion === 6 ? "/ip6" : "/ip4";
  return `${prefix}/${hostname}/tcp/${port}/ws`;
}
