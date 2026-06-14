import { expect, test } from "vitest";
import { getDialableAddresses } from "../src/address.js";

test("getDialableAddresses returns undefined addresses when passed empty list", () => {
  const { directAddress, relayedAddress } = getDialableAddresses([]);
  expect(directAddress).toBeUndefined();
  expect(relayedAddress).toBeUndefined();
});

test("getDialableAddresses resolves direct address", () => {
  const directAddr =
    "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmPeer";
  const addresses = [directAddr];
  const { directAddress, relayedAddress } = getDialableAddresses(addresses);
  expect(directAddress).toEqual(directAddr);
  expect(relayedAddress).toBeUndefined();
});

test("getDialableAddresses resolves relayed address", () => {
  const relayedAddr =
    "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/p2p/QmPeer";
  const addresses = [relayedAddr];
  const { directAddress, relayedAddress } = getDialableAddresses(addresses);
  expect(directAddress).toBeUndefined();
  expect(relayedAddress).toEqual(relayedAddr);
});

test("getDialableAddresses resolves both direct and relayed addresses", () => {
  const directAddr =
    "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmPeer";
  const relayedAddr =
    "/ip4/192.0.2.0/tcp/5002/p2p/QmRelay/p2p-circuit/p2p/QmPeer";
  const addresses = [relayedAddr, directAddr];
  const { directAddress, relayedAddress } = getDialableAddresses(addresses);
  expect(directAddress).toEqual(directAddr);
  expect(relayedAddress).toEqual(relayedAddr);
});
