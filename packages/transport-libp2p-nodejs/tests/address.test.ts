import { assert, test } from "vitest";
import { hostPortToMultiaddr } from "../src/address.js";

test("hostPortToMultiaddr: IPv4 host:port becomes a webrtc-direct multiaddr", () => {
  assert.equal(
    hostPortToMultiaddr("0.0.0.0:9000"),
    "/ip4/0.0.0.0/udp/9000/webrtc-direct",
  );
});

test("hostPortToMultiaddr: IPv6 host:port strips brackets and uses /ip6", () => {
  // URL parsing keeps IPv6 hosts in brackets (e.g. "[::]"); the multiaddr form must not.
  assert.equal(
    hostPortToMultiaddr("[::]:9000"),
    "/ip6/::/udp/9000/webrtc-direct",
  );
});

test("hostPortToMultiaddr: port 0 (ephemeral) is allowed for listening", () => {
  // Relays may bind an OS-assigned port; the real port is read after start.
  assert.equal(
    hostPortToMultiaddr("0.0.0.0:0"),
    "/ip4/0.0.0.0/udp/0/webrtc-direct",
  );
});

test("hostPortToMultiaddr: DNS hostname uses /dns", () => {
  // isIP returns 0 for a DNS name; that is the /dns prefix, not an error.
  assert.equal(
    hostPortToMultiaddr("example.com:9000"),
    "/dns/example.com/udp/9000/webrtc-direct",
  );
});

test("hostPortToMultiaddr: rejects a missing hostname", () => {
  // No host before the port fails URL parsing outright.
  assert.throws(() => hostPortToMultiaddr(":9000"));
});

test("hostPortToMultiaddr: rejects a missing port", () => {
  assert.throws(
    () => hostPortToMultiaddr("0.0.0.0"),
    /must include an explicit port/,
  );
});
