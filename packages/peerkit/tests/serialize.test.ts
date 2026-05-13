import type { AgentInfo } from "@peerkit/api";
import { expect, test } from "vitest";
import {
  deserializeAgentInfoList,
  serializeAgentInfoList,
} from "../src/serialize.js";

function makeAgent(agentId: string): AgentInfo {
  return {
    agentId,
    addresses: ["/ip4/127.0.0.1/tcp/9000"],
    expiresAt: Date.now() + 60_000,
  };
}

test("serialize/deserialize round-trips AgentInfo list", () => {
  const agent1 = makeAgent("1");
  const agent2 = makeAgent("2");
  const agents = [agent1, agent2];
  const result = deserializeAgentInfoList(serializeAgentInfoList(agents));
  expect(result).toStrictEqual([agent1, agent2]);
});

test("empty list round-trips", () => {
  expect(deserializeAgentInfoList(serializeAgentInfoList([]))).toEqual([]);
});
