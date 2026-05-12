import { expect, test } from "vitest";
import { AgentKeyPair, decodeAgentId } from "../src/agent.js";

test("agentId round-trips through decodeAgentId", () => {
  const keyPair = new AgentKeyPair();
  const agentId = keyPair.agentId();
  const decoded = decodeAgentId(agentId);
  expect(decoded).toHaveLength(32);
  expect(decodeAgentId(agentId)).toEqual(decoded);
});

test("agentId is lowercase hex", () => {
  const keyPair = new AgentKeyPair();
  expect(keyPair.agentId()).toMatch(/^[0-9a-f]{64}$/);
});
