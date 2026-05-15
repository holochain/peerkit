import { expect, test } from "vitest";
import { AgentKeyPair, decodeAgentId } from "../src/agent.js";
import { AgentInfo, AgentInfoSigned } from "@peerkit/api";
import {
  buildOwnAgentInfo,
  signAgentInfo,
  verifyAgentInfo,
} from "../src/agent-info.js";

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

test("Sign and verify agent info", () => {
  const keyPair = new AgentKeyPair();
  const agentInfo: AgentInfo = {
    agentId: keyPair.agentId(),
    addresses: ["/ip4/127.0.0.1/tcp/9000/ws"],
    expiresAt: Date.now() + 60_000,
  };
  const agentInfoSigned = signAgentInfo(agentInfo, keyPair);
  expect(verifyAgentInfo(agentInfoSigned)).toBe(true);
});

test("buildOwnAgentInfo produces a verifiable signature", () => {
  const keyPair = new AgentKeyPair();
  const addresses = ["/ip4/127.0.0.1/tcp/9000/ws"];
  const expiresAt = Date.now() + 60_000;

  const agentInfo = buildOwnAgentInfo(keyPair, addresses, expiresAt);

  // The agentId must match the key pair's public key.
  expect(agentInfo.agentId).toBe(keyPair.agentId());
  // All provided addresses must appear in the result.
  expect(agentInfo.addresses).toEqual(addresses);
  expect(agentInfo.expiresAt).toBe(expiresAt);
  // The signature must be valid.
  expect(verifyAgentInfo(agentInfo)).toBe(true);
});

test("Invalid signature fails verification", () => {
  const keyPair = new AgentKeyPair();
  const agentInfoWithInvalidSignature: AgentInfoSigned = {
    agentId: keyPair.agentId(),
    addresses: ["/ip4/127.0.0.1/tcp/9000/ws"],
    expiresAt: Date.now() + 60_000,
    signature: new Uint8Array(64),
  };
  expect(verifyAgentInfo(agentInfoWithInvalidSignature)).toBe(false);
});
