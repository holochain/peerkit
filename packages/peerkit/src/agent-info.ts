import * as ed25519 from "@noble/ed25519";
import type {
  AgentInfo,
  AgentInfoSigned,
  IKeyPair,
  NodeAddress,
} from "@peerkit/api";
import { getLogger } from "@logtape/logtape";
import { decodeAgentId } from "./agent.js";
import { serializeAgentInfoCanonical } from "./serialize.js";

const logger = getLogger(["peerkit", "agent-info"]);

/**
 * Create a signature of the canonical byte representation of an
 * {@link AgentInfo}.
 *
 * @param agentInfo The agent info to sign
 * @param keyPair The private key with which to sign
 * @returns The signature over the canonical agent info bytes
 */
export function signAgentInfo(
  agentInfo: AgentInfo,
  keyPair: IKeyPair,
): AgentInfoSigned {
  const serializedAgentInfo = serializeAgentInfoCanonical(agentInfo);
  const signature = keyPair.sign(serializedAgentInfo);
  return { signature, ...agentInfo };
}

/**
 * Build and sign an {@link AgentInfoSigned} for the local agent.
 *
 * @param keyPair The local agent's key pair
 * @param addresses The addresses at which this agent can be reached
 * @param expiresAt Unix timestamp (ms) after which this info should be discarded
 */
export function buildOwnAgentInfo(
  keyPair: IKeyPair,
  addresses: NodeAddress[],
  expiresAt: number,
): AgentInfoSigned {
  return signAgentInfo(
    { agentId: keyPair.agentId(), addresses, expiresAt },
    keyPair,
  );
}

/**
 * Verify the signature of a signed agent info
 *
 * @param agentInfoSigned The signed agent info to verify
 * @returns `true` for a valid, `false` for an invalid signature
 */
export function verifyAgentInfo(agentInfoSigned: AgentInfoSigned): boolean {
  try {
    const publicKey = decodeAgentId(agentInfoSigned.agentId);
    // Signature will be ignored when serializing the agent info.
    const payload = serializeAgentInfoCanonical(agentInfoSigned);
    return ed25519.verify(agentInfoSigned.signature, payload, publicKey);
  } catch (error) {
    logger.warn("Error verifying agent info signature {*}", {
      agentInfoSigned,
      error,
    });
    return false;
  }
}
