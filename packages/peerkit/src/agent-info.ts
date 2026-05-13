import * as ed25519 from "@noble/ed25519";
import type {
  AgentInfo,
  AgentInfoSigned,
  IKeyPair,
  NodeAddress,
} from "@peerkit/api";
import { decodeAgentId } from "./agent.js";
import { serializeAgentInfo } from "./serialize.js";

export function signAgentInfo(
  agentInfo: AgentInfo,
  keyPair: IKeyPair,
): AgentInfoSigned {
  const serializedAgentInfo = serializeAgentInfo(agentInfo);
  const signature = keyPair.sign(serializedAgentInfo);
  return { signature, ...agentInfo };
}

export function verifyAgentInfo(agentInfoSigned: AgentInfoSigned): boolean {
  const publicKey = decodeAgentId(agentInfoSigned.agentId);
  const { ["signature"]: _, ...agentInfo } = agentInfoSigned;
  const payload = serializeAgentInfo(agentInfo);
  return ed25519.verify(agentInfoSigned.signature, payload, publicKey);
}
