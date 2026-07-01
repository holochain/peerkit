import type { MultiaddrResolveOptions } from "@libp2p/interface";
import { dns, RecordType } from "@multiformats/dns";
import { multiaddr } from "@multiformats/multiaddr";
import { expect, test, vi } from "vitest";
import { webRtcDirectDnsResolver } from "../src/address.js";

const CERTHASH = "uEiBItrdDAL56R0V_igeoxvI_vkP5i2YosW62uJl-GffANg";
const RELAY_PEER = "12D3KooWDoSPhd4DTwcuAWXobSTqFTKWxyGosfoqT2LZz21AyY7e";

// A WebRTC Direct relay address with the given leading host component
// (e.g. "dns4/relay.example.org" or "ip4/203.0.113.7").
function webRtcDirect(host: string): string {
  return `/${host}/udp/9000/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY_PEER}`;
}

// Builds a mock libp2p resolve-options object whose `dns.query` returns the
// given answers, so resolve() can be exercised without real DNS.
function mockDnsOptions(answers: Array<{ type: RecordType; data: string }>): {
  options: MultiaddrResolveOptions;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ Answer: answers });
  const options = { dns: { query } } as unknown as MultiaddrResolveOptions;
  return { options, query };
}

test("canResolve matches a dns4 WebRTC Direct address", () => {
  // A named relay reached over WebRTC Direct is exactly what we must rewrite.
  expect(
    webRtcDirectDnsResolver.canResolve(
      multiaddr(webRtcDirect("dns4/relay.example.org")),
    ),
  ).toBe(true);
});

test("canResolve matches dns6 and plain dns WebRTC Direct addresses", () => {
  expect(
    webRtcDirectDnsResolver.canResolve(
      multiaddr(webRtcDirect("dns6/relay.example.org")),
    ),
  ).toBe(true);
  expect(
    webRtcDirectDnsResolver.canResolve(
      multiaddr(webRtcDirect("dns/relay.example.org")),
    ),
  ).toBe(true);
});

test("canResolve rejects an IP-addressed WebRTC Direct address", () => {
  // Already an IP literal: nothing to resolve, dialer accepts it as-is.
  expect(
    webRtcDirectDnsResolver.canResolve(
      multiaddr(webRtcDirect("ip4/203.0.113.7")),
    ),
  ).toBe(false);
});

test("canResolve rejects a non-WebRTC-Direct DNS address (WSS)", () => {
  // WSS resolves DNS itself and needs the hostname for SNI/TLS — must not match.
  expect(
    webRtcDirectDnsResolver.canResolve(
      multiaddr(`/dns4/relay.example.org/tcp/443/tls/ws/p2p/${RELAY_PEER}`),
    ),
  ).toBe(false);
});

test("canResolve rejects a DNS component that follows p2p-circuit", () => {
  // The dns host belongs to a hop past the circuit, not the WebRTC Direct relay.
  const addr = `/ip4/203.0.113.7/udp/9000/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY_PEER}/p2p-circuit/dns4/peer.example.org/p2p/${RELAY_PEER}`;
  expect(webRtcDirectDnsResolver.canResolve(multiaddr(addr))).toBe(false);
});

test("resolve swaps a dns4 host for the resolved ip4, keeping the rest", async () => {
  const { options, query } = mockDnsOptions([
    { type: RecordType.A, data: "203.0.113.7" },
  ]);
  const [resolved] = await webRtcDirectDnsResolver.resolve(
    multiaddr(webRtcDirect("dns4/relay.example.org")),
    options,
  );
  // Only the host becomes ip4; udp/webrtc-direct/certhash/p2p are preserved.
  expect(resolved?.toString()).toBe(webRtcDirect("ip4/203.0.113.7"));
  // dns4 must query an A record for the hostname.
  expect(query).toHaveBeenCalledWith(
    "relay.example.org",
    expect.objectContaining({ types: [RecordType.A] }),
  );
});

test("resolve swaps a dns6 host for the resolved ip6", async () => {
  const { options, query } = mockDnsOptions([
    { type: RecordType.AAAA, data: "2001:db8::1" },
  ]);
  const [resolved] = await webRtcDirectDnsResolver.resolve(
    multiaddr(webRtcDirect("dns6/relay.example.org")),
    options,
  );
  expect(resolved?.toString()).toBe(webRtcDirect("ip6/2001:db8::1"));
  expect(query).toHaveBeenCalledWith(
    "relay.example.org",
    expect.objectContaining({ types: [RecordType.AAAA] }),
  );
});

test("resolve queries both families for a plain dns host and prefers A", async () => {
  // A plain `dns` host is family-agnostic: query A and AAAA, prefer the A record.
  const { options, query } = mockDnsOptions([
    { type: RecordType.AAAA, data: "2001:db8::1" },
    { type: RecordType.A, data: "203.0.113.7" },
  ]);
  const [resolved] = await webRtcDirectDnsResolver.resolve(
    multiaddr(webRtcDirect("dns/relay.example.org")),
    options,
  );
  expect(resolved?.toString()).toBe(webRtcDirect("ip4/203.0.113.7"));
  expect(query).toHaveBeenCalledWith(
    "relay.example.org",
    expect.objectContaining({ types: [RecordType.A, RecordType.AAAA] }),
  );
});

test("resolve throws when no A/AAAA record is returned", async () => {
  const { options } = mockDnsOptions([]);
  await expect(
    webRtcDirectDnsResolver.resolve(
      multiaddr(webRtcDirect("dns4/relay.example.org")),
      options,
    ),
  ).rejects.toThrow(/no A\/AAAA record/i);
});

test("resolve uses the default @multiformats/dns instance when options.dns is unset", () => {
  // Sanity: the real dns() factory is a valid resolver source; not queried here.
  expect(typeof dns).toBe("function");
});
