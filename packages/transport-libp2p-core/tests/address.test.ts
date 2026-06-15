import { expect, test } from "vitest";
import { getDialableAddresses } from "../src/address.js";

// A `/p2p-circuit/webrtc` address is only used for signaling, so the resulting
// connection is direct.
const DIRECT_WEBRTC =
  "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmPeer";
// A plain transport address with no circuit at all is direct too.
const DIRECT_WS = "/ip4/203.0.113.1/tcp/4001/ws/p2p/QmPeer";
// A `/p2p-circuit` address without webrtc carries data over the relay.
const RELAYED_VIA_RELAY_A =
  "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/p2p/QmPeer";
// A second relayed address, reached through a different relay host.
const RELAYED_VIA_RELAY_B =
  "/ip4/198.51.100.7/tcp/5002/p2p/QmRelay/p2p-circuit/p2p/QmPeer";

test("getDialableAddresses returns empty groups when passed an empty list", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([]);
  expect(directAddresses).toEqual([]);
  expect(relayedAddresses).toEqual([]);
});

test("getDialableAddresses resolves a single direct address", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    DIRECT_WEBRTC,
  ]);
  expect(directAddresses).toEqual([DIRECT_WEBRTC]);
  expect(relayedAddresses).toEqual([]);
});

test("getDialableAddresses resolves a single relayed address", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    RELAYED_VIA_RELAY_A,
  ]);
  expect(directAddresses).toEqual([]);
  expect(relayedAddresses).toEqual([RELAYED_VIA_RELAY_A]);
});

test("getDialableAddresses splits one direct and one relayed address", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    RELAYED_VIA_RELAY_A,
    DIRECT_WEBRTC,
  ]);
  expect(directAddresses).toEqual([DIRECT_WEBRTC]);
  expect(relayedAddresses).toEqual([RELAYED_VIA_RELAY_A]);
});

test("getDialableAddresses collects multiple direct addresses", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    DIRECT_WEBRTC,
    DIRECT_WS,
  ]);
  expect(directAddresses).toEqual([DIRECT_WEBRTC, DIRECT_WS]);
  expect(relayedAddresses).toEqual([]);
});

test("getDialableAddresses collects multiple relayed addresses", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    RELAYED_VIA_RELAY_A,
    RELAYED_VIA_RELAY_B,
  ]);
  expect(directAddresses).toEqual([]);
  expect(relayedAddresses).toEqual([RELAYED_VIA_RELAY_A, RELAYED_VIA_RELAY_B]);
});

test("getDialableAddresses splits multiple direct and relayed addresses", () => {
  const { directAddresses, relayedAddresses } = getDialableAddresses([
    RELAYED_VIA_RELAY_A,
    DIRECT_WEBRTC,
    RELAYED_VIA_RELAY_B,
    DIRECT_WS,
  ]);
  expect(directAddresses).toEqual([DIRECT_WEBRTC, DIRECT_WS]);
  expect(relayedAddresses).toEqual([RELAYED_VIA_RELAY_A, RELAYED_VIA_RELAY_B]);
});
