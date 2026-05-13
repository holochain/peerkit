import { decode, encode } from "cbor-x";
import type { AgentInfo, AgentInfoSigned } from "@peerkit/api";

/**
 * Serializes an AgentInfo to a canonical byte representation for signing and
 * verification.
 */
export function serializeAgentInfoCanonical(agent: AgentInfo): Uint8Array {
  const canonicalAgentInfo: AgentInfo = {
    addresses: agent.addresses,
    agentId: agent.agentId,
    expiresAt: agent.expiresAt,
  };
  return encode(canonicalAgentInfo);
}

/**
 * Serialize a list of {@link AgentInfo}s to send over the wire.
 *
 * @param agents The list of signed agent infos
 * @returns Serialized list as byte array
 */
export function serializeAgentInfoList(agents: AgentInfoSigned[]): Uint8Array {
  return encode(agents);
}

/**
 * Deserialize a byte array to a list of signed {@link AgentInfo}s.
 *
 * @param bytes The serialized list of agent infos as byte array
 * @returns The deserialized list of signed agent infos
 */
export function deserializeAgentInfoList(bytes: Uint8Array): AgentInfoSigned[] {
  return decode(bytes);
}
