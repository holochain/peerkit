import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webRTCDirect } from "@libp2p/webrtc";
import {
  CODE_IP4,
  CODE_IP6,
  multiaddr,
  type Multiaddr,
} from "@multiformats/multiaddr";
import type {
  ITransport,
  RelayCertificate,
  RelayListenAddress,
} from "@peerkit/api";
import {
  TransportLibp2p,
  type RelayOptions,
} from "@peerkit/transport-libp2p-core";
import { createLibp2p } from "libp2p";
import { isIP } from "node:net";
import { hostPortToMultiaddr } from "./address.js";
import { toTransportCertificate } from "./certificate.js";

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
 * Replace the host of a multiaddr with the relay's public IP, preserving the
 * rest of the address — including the WebRTC Direct certhash, which libp2p
 * generates at start and is therefore only known at runtime.
 *
 * Used to announce a NAT'd relay's dialable address: the relay binds locally
 * but advertises its public IP.
 *
 * @param addr      A multiaddr string beginning with `/ip4/<host>` or `/ip6/<host>`.
 * @param publicIp  The relay's externally-reachable IP address.
 */
export function rewriteHostToPublicIp(addr: string, publicIp: string): string {
  const version = isIP(publicIp);
  if (version === 0) {
    throw new Error(
      `rewriteHostToPublicIp: "${publicIp}" is not a valid IP address`,
    );
  }
  const ipCode = version === 6 ? CODE_IP6 : CODE_IP4;
  const components = multiaddr(addr).getComponents();
  // Only the leading IP component is swapped; the family must match so we never
  // advertise an IPv4 port under an IPv6 address (or vice versa).
  const ipComponent = components.find(
    (component) => component.code === CODE_IP4 || component.code === CODE_IP6,
  );
  if (ipComponent?.code !== ipCode) {
    throw new Error(
      `rewriteHostToPublicIp: cannot rewrite ${addr} to IPv${version} address "${publicIp}"`,
    );
  }
  const rewritten = components.map((component) =>
    component.code === ipCode ? { ...component, value: publicIp } : component,
  );
  return multiaddr(rewritten).toString();
}

/**
 * Build a libp2p `announceFilter` that rewrites every announced address to use
 * the relay's public IP. Runs at runtime, so the live certhash is retained.
 */
function publicIpAnnounceFilter(publicIp: string) {
  const publicIpVersion = isIP(publicIp);
  if (publicIpVersion === 0) {
    throw new Error(
      `publicIpAnnounceFilter: "${publicIp}" is not a valid IP address`,
    );
  }
  const ipCode = publicIpVersion === 6 ? CODE_IP6 : CODE_IP4;
  return (addrs: Multiaddr[]) => {
    const seen = new Set<string>();
    const out: Multiaddr[] = [];
    for (const addr of addrs) {
      // Skip addresses without a matching-family IP component; only those can
      // be rewritten to the public IP.
      if (
        !addr.getComponents().some((component) => component.code === ipCode)
      ) {
        continue;
      }
      const rewritten = rewriteHostToPublicIp(addr.toString(), publicIp);
      if (!seen.has(rewritten)) {
        seen.add(rewritten);
        out.push(multiaddr(rewritten));
      }
    }
    return out;
  };
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
   * The transport computes `/ip4/<ip>/udp/<port>/webrtc-direct/certhash/<hash>`
   * (or `/ip6/…`) for each listen address and configures libp2p to advertise
   * it. Peers dial the public address; the relay still binds locally to `addrs`.
   */
  publicIp?: string;
  /**
   * Certificate for the WebRTC Direct listener.
   *
   * When omitted, libp2p generates an ephemeral certificate at start, so the
   * certhash changes on every restart. Supply a persisted certificate (e.g.
   * from {@link generateRelayCertificate}) to keep the relay's certhash — and
   * therefore its dialable multiaddrs — stable across restarts.
   */
  certificate?: RelayCertificate;
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
 * Configures libp2p with WebRTC Direct + circuit-relay-v2 server + noise + yamux
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

  const libp2pNode = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    // With a caller-supplied certificate the certhash is stable across
    // restarts; otherwise webRTCDirect generates an ephemeral one at start.
    // Either way the certhash is appended to the listen multiaddrs and read
    // via getListenAddresses() once started.
    transports: [
      webRTCDirect(
        options.certificate
          ? { certificate: toTransportCertificate(options.certificate) }
          : undefined,
      ),
    ],
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
      // Behind NAT, rewrite the announced addresses to the public IP at
      // runtime so the live certhash is preserved.
      ...(options.publicIp
        ? { announceFilter: publicIpAnnounceFilter(options.publicIp) }
        : {}),
    },
  });
  const transport = new TransportLibp2p(libp2pNode, options);
  await libp2pNode.start();
  return transport;
}
