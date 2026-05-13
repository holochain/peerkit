import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AgentId, IKeyPair } from "@peerkit/api";

ed25519.hashes.sha512 = sha512;

function encodeAgentId(publicKeyBytes: Uint8Array): AgentId {
  return bytesToHex(publicKeyBytes);
}

export function decodeAgentId(agentId: AgentId): Uint8Array {
  return hexToBytes(agentId);
}

export class AgentKeyPair implements IKeyPair {
  private readonly privateKey: Uint8Array;
  private readonly publicKey: Uint8Array;

  constructor() {
    this.privateKey = ed25519.utils.randomSecretKey();
    this.publicKey = ed25519.getPublicKey(this.privateKey);
  }

  agentId(): AgentId {
    return encodeAgentId(this.publicKey);
  }

  sign(data: Uint8Array): Uint8Array {
    return ed25519.sign(data, this.privateKey);
  }
}
