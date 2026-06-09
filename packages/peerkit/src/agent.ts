import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AgentId, IAgentKeyStore, IKeyPair } from "@peerkit/api";

// Set hashing function to enable synchronous crypto functions.
// See https://github.com/paulmillr/noble-ed25519#enabling-synchronous-methods
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
 * Concrete Ed25519 key pair for an agent.
 *
 * Construct via {@link AgentKeyPair.load_or_create}: it reads the private key from the
 * given {@link IAgentKeyStore}, or generates and persists a new one when the
 * store is empty.
 */
export class AgentKeyPair implements IKeyPair {
  private readonly privateKey: Uint8Array;
  private readonly publicKey: Uint8Array;

  private constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
    this.publicKey = ed25519.getPublicKey(privateKey);
  }

  /**
   * Loads the agent's key pair from the store, generating and persisting a new
   * one when the store holds no key.
   * If the store doesn't contain a key yet, a new random Ed25519 private key is generated and stored.
   * If the store contains an invalid key, an error is thrown.
   *
   * @param agentKeyStore - Storage for the agent's private key.
   * @returns The loaded or newly created key pair.
   * @throws Error if the store contains an invalid key.
   */
  static async load_or_create(
    agentKeyStore: IAgentKeyStore,
  ): Promise<AgentKeyPair> {
    let privateKey = await agentKeyStore.loadKey();

    if (privateKey === undefined) {
      privateKey = ed25519.utils.randomSecretKey();
      await agentKeyStore.storeKey(privateKey);
    } else if (privateKey.length !== 32) {
      throw new Error("Invalid Ed25519 private key length");
    }

    return new AgentKeyPair(privateKey);
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
