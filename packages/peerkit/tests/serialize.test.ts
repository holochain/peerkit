import { expect, test } from "vitest";
import type { AgentInfo } from "@peerkit/api";
import { deserialize, serialize } from "../src/serialize.js";

function makeAgent(agentId: string): AgentInfo {
  return {
    agentId,
    addresses: ["/ip4/127.0.0.1/tcp/9000"],
    expiresAt: Date.now() + 60_000,
    signature: crypto.getRandomValues(new Uint8Array(64)),
  };
}

test("serialize/deserialize round-trips AgentInfo list", () => {
  const agent1 = makeAgent("1");
  const agent2 = makeAgent("2");
  const agents = [agent1, agent2];
  const result = deserialize(serialize(agents));
  expect(result).toStrictEqual([agent1, agent2]);
});

test("empty list round-trips", () => {
  expect(deserialize(serialize([]))).toEqual([]);
});
