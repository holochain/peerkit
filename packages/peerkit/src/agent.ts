import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AgentId, IKeyPair } from "@peerkit/api";

ed25519.hashes.sha512 = sha512;

/**
 * Encodes raw Ed25519 public key bytes as a hex-string {@link AgentId}.
 *
 * @param publicKeyBytes - Raw 32-byte Ed25519 public key.
 * @returns Hex-encoded agent identifier.
 */
function encodeAgentId(publicKeyBytes: Uint8Array): AgentId {
  return bytesToHex(publicKeyBytes);
}

/**
 * Decodes an {@link AgentId} to its raw Ed25519 public key bytes.
 *
 * @param agentId - Hex-encoded agent identifier.
 * @returns Raw 32-byte Ed25519 public key.
 */
export function decodeAgentId(agentId: AgentId): Uint8Array {
  return hexToBytes(agentId);
}

/**
 * Concrete Ed25519 key pair for an agent. Generates a new random key pair on
 * construction.
 */
export class AgentKeyPair implements IKeyPair {
  private readonly privateKey: Uint8Array;
  private readonly publicKey: Uint8Array;

  constructor() {
    this.privateKey = ed25519.utils.randomSecretKey();
    this.publicKey = ed25519.getPublicKey(this.privateKey);
  }

  /**
   * Returns this agent's identifier (hex-encoded Ed25519 public key).
   *
   * @returns Hex-encoded {@link AgentId}.
   */
  agentId(): AgentId {
    return encodeAgentId(this.publicKey);
  }

  /**
   * Signs data with the agent's Ed25519 private key.
   *
   * @param data - Bytes to sign.
   * @returns Raw 64-byte Ed25519 signature.
   */
  sign(data: Uint8Array): Uint8Array {
    return ed25519.sign(data, this.privateKey);
  }
}
