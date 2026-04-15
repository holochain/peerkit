// Identifier for a peer
export type PeerId = Uint8Array;

// Address to dial a peer
export interface PeerAddress {
  id: PeerId;
  address: number;
}

export interface RelayConfig {
  canRelay: boolean;
}

// Byte sequence to prove access to a network has been granted
export type NetworkAccessPass = Uint8Array;
