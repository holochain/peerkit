import type { RelayListenAddress } from "@peerkit/api";
import { isIP } from "node:net";

/**
 * Convert a `"host:port"` relay listen address to a libp2p WebRTC Direct
 * multiaddr.
 *
 * Supports IPv4 and IPv6 (bracketed). Internal to the transport, so callers
 * pass {@link RelayListenAddress} and never see the multiaddr form.
 */
export function hostPortToMultiaddr(hostPort: RelayListenAddress): string {
  // Use URL only to split host from port (it handles IPv6 brackets); the
  // ws:// scheme is a parsing vehicle and is discarded.
  const url = new URL(`ws://${hostPort}`);
  // URL keeps IPv6 hosts bracketed (e.g. "[::]"); multiaddrs are unbracketed.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
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
  const prefix = ipVersion === 6 ? "/ip6" : "/ip4";
  return `${prefix}/${hostname}/udp/${port}/webrtc-direct`;
}
