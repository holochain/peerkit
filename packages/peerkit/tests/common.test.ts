import { expect, test } from "vitest";
import { getAgentsReceivedCallback } from "../src/common.js";
import { MemoryAgentStore } from "@peerkit/agent-store";
import { AgentKeyPair } from "../src/agent.js";
import { signAgentInfo } from "../src/agent-info.js";
import { serializeAgentInfoList } from "../src/serialize.js";
import { getLogger } from "@logtape/logtape";
import { hexToBytes } from "@noble/hashes/utils.js";

const logger = getLogger(["peerkit", "test"]);

test("Valid agent info is stored", async () => {
  const agentStore = new MemoryAgentStore();
  const callback = getAgentsReceivedCallback(logger, agentStore);
  const keyPair = new AgentKeyPair();
  const agentInfo = signAgentInfo(
    {
      agentId: keyPair.agentId(),
      addresses: [],
      expiresAt: Date.now() + 60_000,
    },
    keyPair,
  );

  await callback("node1", serializeAgentInfoList([agentInfo]));

  // Correctly signed agent info must be stored.
  expect(agentStore.getAll()).toContainEqual(agentInfo);
});

test("Agent info with invalid signature is discarded", async () => {
  const agentStore = new MemoryAgentStore();
  const callback = getAgentsReceivedCallback(logger, agentStore);

  // Signature is 64 bytes but does not match the agentId's public key.
  await callback(
    "node1",
    serializeAgentInfoList([
      {
        agentId:
          "0000000000000000000000000000000000000000000000000000000000000001",
        addresses: [],
        expiresAt: Date.now() + 60_000,
        signature: hexToBytes(
          "01234567890123456789012345678901234567890123456789012345678901230123456789012345678901234567890123456789012345678901234567890123",
        ),
      },
    ]),
  );

  expect(agentStore.getAll()).toHaveLength(0);
});

test("Agent info with wrong-size signature is discarded", async () => {
  const agentStore = new MemoryAgentStore();
  const callback = getAgentsReceivedCallback(logger, agentStore);

  // Ed25519 signatures are 64 bytes; 32 bytes is structurally invalid.
  await callback(
    "node1",
    serializeAgentInfoList([
      {
        agentId:
          "0000000000000000000000000000000000000000000000000000000000000002",
        addresses: [],
        expiresAt: Date.now() + 60_000,
        signature: new Uint8Array(32),
      },
    ]),
  );

  expect(agentStore.getAll()).toHaveLength(0);
});

test("Only valid agent infos are stored from a mixed list", async () => {
  const agentStore = new MemoryAgentStore();
  const callback = getAgentsReceivedCallback(logger, agentStore);
  const keyPair = new AgentKeyPair();
  const valid = signAgentInfo(
    {
      agentId: keyPair.agentId(),
      addresses: [],
      expiresAt: Date.now() + 60_000,
    },
    keyPair,
  );

  // One valid and one invalid agent info — only the valid one should be stored.
  await callback(
    "node1",
    serializeAgentInfoList([
      valid,
      {
        agentId:
          "0000000000000000000000000000000000000000000000000000000000000001",
        addresses: [],
        expiresAt: Date.now() + 60_000,
        signature: new Uint8Array(64),
      },
    ]),
  );

  expect(agentStore.getAll()).toStrictEqual([valid]);
});

test("Malformed bytes are discarded without throwing", async () => {
  const agentStore = new MemoryAgentStore();
  const callback = getAgentsReceivedCallback(logger, agentStore);

  // Invalid CBOR deserialization must not propagate an exception.
  await expect(
    callback("node1", new Uint8Array([0xff, 0xfe])),
  ).resolves.toBeUndefined();
  expect(agentStore.getAll()).toHaveLength(0);
});
