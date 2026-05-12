import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AgentId, IKeyPair, NodeAddress } from "@peerkit/api";

ed25519.hashes.sha512 = sha512;

function encodeAgentId(publicKeyBytes: Uint8Array): AgentId {
  return bytesToHex(publicKeyBytes);
}

export function decodeAgentId(agentId: AgentId): Uint8Array {
  return hexToBytes(agentId);
}

/**
 * Returns the bytes that are signed over in an {@link AgentInfo}.
 *
 * Both signer and verifier must use this function to produce the canonical
 * representation of the payload fields.
 *
 * TODO: replace with AgentInfo serialization once the wire format is defined.
 */
export function encodeAgentInfoPayload(
  agentId: AgentId,
  addresses: NodeAddress[],
  expiresAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ agentId, addresses, expiresAt }),
  );
}

export function verifyAgentInfo(
  agentId: AgentId,
  addresses: NodeAddress[],
  expiresAt: number,
  signature: Uint8Array,
): boolean {
  const publicKey = decodeAgentId(agentId);
  const payload = encodeAgentInfoPayload(agentId, addresses, expiresAt);
  return ed25519.verify(signature, payload, publicKey);
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
