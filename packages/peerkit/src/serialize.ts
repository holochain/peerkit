import { decode, encode } from "cbor-x";
import type { AgentInfo } from "@peerkit/api";

export function serializeAgentInfo(agent: AgentInfo): Uint8Array {
  return encode(agent);
}

export function serializeAgentInfoList(agents: AgentInfo[]): Uint8Array {
  return encode(agents);
}

export function deserializeAgentInfoList(bytes: Uint8Array): AgentInfo[] {
  return decode(bytes) as AgentInfo[];
}
