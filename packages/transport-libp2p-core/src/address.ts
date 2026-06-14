import {
  CODE_P2P_CIRCUIT,
  CODE_WEBRTC,
  multiaddr,
} from "@multiformats/multiaddr";
import type { NodeAddress } from "@peerkit/api";

function isRelayed(address: NodeAddress) {
  const components = multiaddr(address).getComponents();
  return (
    components.find((c) => c.code === CODE_P2P_CIRCUIT) &&
    components.every((c) => c.code !== CODE_WEBRTC)
  );
}

export function getDialableAddresses(addresses: NodeAddress[]) {
  const relayedAddress = addresses.find(isRelayed);
  const directAddress = addresses.find((address) => !isRelayed(address));
  return { directAddress, relayedAddress };
}
