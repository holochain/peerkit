import type { ITransport } from "@peerkit/api";

/**
 * Read a transport's dialable WebRTC Direct address.
 *
 * The address carries the ephemeral certhash generated at start, so it can
 * only be discovered at runtime — it cannot be constructed from a known port.
 */
export function webrtcDirectAddr(transport: ITransport): string {
  const addresses = transport.getListenAddresses();
  const addr = addresses.find((a) => a.includes("/webrtc-direct"));
  if (addr === undefined) {
    throw new Error(
      `no webrtc-direct address available; got: ${addresses.join(", ")}`,
    );
  }
  return addr;
}
