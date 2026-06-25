import type {
  MultiaddrResolveOptions,
  MultiaddrResolver,
} from "@libp2p/interface";
import { dns as defaultDns, RecordType } from "@multiformats/dns";
import {
  CODE_DNS,
  CODE_DNS4,
  CODE_DNS6,
  CODE_IP4,
  CODE_IP6,
  CODE_P2P_CIRCUIT,
  CODE_WEBRTC,
  CODE_WEBRTC_DIRECT,
  type Multiaddr,
  multiaddr,
} from "@multiformats/multiaddr";
import type { NodeAddress } from "@peerkit/api";

const DNS_CODES: ReadonlySet<number> = new Set([
  CODE_DNS,
  CODE_DNS4,
  CODE_DNS6,
]);

function isRelayed(address: NodeAddress) {
  const components = multiaddr(address).getComponents();
  return (
    components.find((c) => c.code === CODE_P2P_CIRCUIT) &&
    components.every((c) => c.code !== CODE_WEBRTC)
  );
}

export function getDialableAddresses(addresses: NodeAddress[]) {
  const directAddresses = addresses.filter((address) => !isRelayed(address));
  const relayedAddresses = addresses.filter((address) => isRelayed(address));
  return { directAddresses, relayedAddresses };
}

/**
 * Finds the leading DNS host component of a WebRTC Direct address — the relay
 * host that must be an IP literal before the WebRTC Direct dialer will accept
 * it. Returns the component index, or -1 when the address is not a
 * name-addressed WebRTC Direct relay (no webrtc-direct component, already an IP,
 * or the DNS component belongs to a later hop past `/p2p-circuit`).
 */
function webRtcDirectDnsIndex(ma: Multiaddr): number {
  const components = ma.getComponents();
  const webRtcDirectIndex = components.findIndex(
    (c) => c.code === CODE_WEBRTC_DIRECT,
  );
  if (webRtcDirectIndex === -1) {
    return -1;
  }
  return components.findIndex(
    (c, index) => index < webRtcDirectIndex && DNS_CODES.has(c.code),
  );
}

/**
 * libp2p multiaddr resolver that rewrites the DNS host of a WebRTC Direct relay
 * to a resolved IP literal.
 *
 * The `@libp2p/webrtc` WebRTC Direct dialer only accepts `ip4`/`ip6` hosts and
 * libp2p auto-resolves `dnsaddr` only, so a `/dns4|dns6|dns/.../webrtc-direct/...`
 * relay fails the dial with "was not an IPv4 or IPv6 address". Registered in the
 * dial pipeline via `connectionManager.resolvers`, this resolves such addresses
 * before the dialer sees them. Scoped to WebRTC Direct: WSS and circuit relay
 * addresses resolve DNS on their own (and need the hostname for SNI/TLS).
 */
export const webRtcDirectDnsResolver: MultiaddrResolver = {
  canResolve(address: Multiaddr): boolean {
    return webRtcDirectDnsIndex(address) !== -1;
  },
  async resolve(
    address: Multiaddr,
    options: MultiaddrResolveOptions,
  ): Promise<Multiaddr[]> {
    const components = address.getComponents();
    const dnsIndex = webRtcDirectDnsIndex(address);
    const dnsComponent = dnsIndex === -1 ? undefined : components[dnsIndex];
    const hostname = dnsComponent?.value;
    if (dnsComponent === undefined || hostname === undefined) {
      return [address];
    }
    // dns4 -> A, dns6 -> AAAA, plain dns -> both (prefer A: relays are most
    // reachable over IPv4).
    const types =
      dnsComponent.code === CODE_DNS4
        ? [RecordType.A]
        : dnsComponent.code === CODE_DNS6
          ? [RecordType.AAAA]
          : [RecordType.A, RecordType.AAAA];
    const resolver = options.dns ?? defaultDns();
    const { Answer } = await resolver.query(hostname, {
      types,
      signal: options.signal,
    });
    const answer =
      Answer.find((record) => record.type === RecordType.A) ??
      Answer.find((record) => record.type === RecordType.AAAA);
    if (answer === undefined) {
      throw new Error(`WebRTC Direct DNS: no A/AAAA record for "${hostname}"`);
    }
    const isIp6 = answer.type === RecordType.AAAA;
    const resolved = components.map((component, index) =>
      index === dnsIndex
        ? isIp6
          ? { code: CODE_IP6, name: "ip6", value: answer.data }
          : { code: CODE_IP4, name: "ip4", value: answer.data }
        : component,
    );
    return [multiaddr(resolved)];
  },
};
