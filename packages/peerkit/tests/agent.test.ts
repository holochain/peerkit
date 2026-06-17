import * as ed25519 from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentInfo, AgentInfoSigned } from "@peerkit/api";
import { MemoryAgentKeyStore } from "@peerkit/test-utils";
import { expect, test } from "vitest";
import {
  buildOwnAgentInfo,
  signAgentInfo,
  verifyAgentInfo,
} from "../src/agent-info.js";
import { AgentKeyPair, decodeAgentId } from "../src/agent.js";

test("agentId round-trips through decodeAgentId", async () => {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
  const agentId = keyPair.agentId();
  const decoded = decodeAgentId(agentId);
  expect(decoded).toHaveLength(32);
  expect(decodeAgentId(agentId)).toEqual(decoded);
});

test("agentId is lowercase hex", async () => {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
  expect(keyPair.agentId()).toMatch(/^[0-9a-f]{64}$/);
});

test("Sign and verify agent info", async () => {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
  const agentInfo: AgentInfo = {
    agentId: keyPair.agentId(),
    addresses: ["/ip4/127.0.0.1/tcp/9000/ws"],
    expiresAt: Date.now() + 60_000,
  };
  const agentInfoSigned = signAgentInfo(agentInfo, keyPair);
  expect(verifyAgentInfo(agentInfoSigned)).toBe(true);
});

test("buildOwnAgentInfo produces a verifiable signature", async () => {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
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

test("Invalid signature fails verification", async () => {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
  const agentInfoWithInvalidSignature: AgentInfoSigned = {
    agentId: keyPair.agentId(),
    addresses: ["/ip4/127.0.0.1/tcp/9000/ws"],
    expiresAt: Date.now() + 60_000,
    signature: new Uint8Array(64),
  };
  expect(verifyAgentInfo(agentInfoWithInvalidSignature)).toBe(false);
});

test("load generates a new key and persists it when the store is empty", async () => {
  const store = new MemoryAgentKeyStore();
  // The store starts empty, so load must generate a fresh key.
  expect(await store.loadKey()).toBeUndefined();

  const keyPair = await AgentKeyPair.load_or_create(store);

  // The generated key must have been written back to the store...
  const persisted = await store.loadKey();
  expect(persisted).toBeDefined();
  expect(persisted).toHaveLength(32);
  // ...so the public key (== AgentId) derives from a valid Ed25519 key.
  expect(keyPair.agentId()).toMatch(/^[0-9a-f]{64}$/);
});

test("load keeps a stable identity across restarts", async () => {
  // First run: an empty store generates and persists a key.
  const store = new MemoryAgentKeyStore();
  const firstRun = await AgentKeyPair.load_or_create(store);

  // Second run: the same store already holds the key, so the identity
  // must survive the "restart" rather than cycling to a new one.
  const secondRun = await AgentKeyPair.load_or_create(store);
  expect(secondRun.agentId()).toBe(firstRun.agentId());
});

test("load reuses a pre-seeded key without overwriting it", async () => {
  // Seed the store with a known key, as if loaded from disk on startup.
  const seed = new Uint8Array(32).fill(7);
  const store = new MemoryAgentKeyStore(seed);

  const keyPair = await AgentKeyPair.load_or_create(store);

  // The AgentId must be derived from the seeded key, deterministically.
  const expectedAgentId = bytesToHex(ed25519.getPublicKey(seed));
  expect(keyPair.agentId()).toBe(expectedAgentId);
  // The seeded key must be left untouched in the store.
  expect(await store.loadKey()).toEqual(seed);
});

test("load rejects a stored key with an invalid length", async () => {
  // A truncated key in the store is corruption, not a missing identity.
  const store = new MemoryAgentKeyStore(new Uint8Array(31));
  await expect(AgentKeyPair.load_or_create(store)).rejects.toThrow(
    "Invalid Ed25519 private key length",
  );
});
