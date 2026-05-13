import { expect, test, vi } from "vitest";
import { MemoryAgentStore } from "../src/agent-store.js";
import type { AgentInfoSigned } from "@peerkit/api";

function makeAgent(agentId: string, expiresInMs = 60_000): AgentInfoSigned {
  return {
    agentId,
    addresses: ["/ip4/127.0.0.1/tcp/9000"],
    expiresAt: Date.now() + expiresInMs,
    signature: new Uint8Array(64),
  };
}

test("Starts empty", () => {
  const store = new MemoryAgentStore();
  expect(store.getAll()).toEqual([]);
  store.destroy();
});

test("Store and get agent by agentId", () => {
  const store = new MemoryAgentStore();
  const agent = makeAgent("a1");
  store.store([agent]);
  expect(store.get("a1")).toEqual(agent);
  store.destroy();
});

test("getAll returns all stored agents", () => {
  const store = new MemoryAgentStore();
  store.store([makeAgent("a1"), makeAgent("a2"), makeAgent("a3")]);
  expect(store.getAll()).toHaveLength(3);
  store.destroy();
});

test("get returns undefined for unknown agentId", () => {
  const store = new MemoryAgentStore();
  expect(store.get("unknown")).toBeUndefined();
  store.destroy();
});

test("store overwrites existing entry for same agentId", () => {
  const store = new MemoryAgentStore();
  const v1: AgentInfoSigned = {
    agentId: "a1",
    addresses: ["/ip4/1.1.1.1/tcp/1"],
    expiresAt: Date.now() + 60_000,
    signature: new Uint8Array(64),
  };
  const v2: AgentInfoSigned = {
    agentId: "a1",
    addresses: ["/ip4/2.2.2.2/tcp/2"],
    expiresAt: Date.now() + 60_000,
    signature: new Uint8Array(64),
  };
  store.store([v1]);
  store.store([v2]);
  expect(store.get("a1")).toEqual(v2);
  expect(store.getAll()).toHaveLength(1);
  store.destroy();
});

test("getAll filters out expired agents", () => {
  const store = new MemoryAgentStore();
  store.store([makeAgent("active", 60_000), makeAgent("expired", -1)]);
  const all = store.getAll();
  expect(all).toHaveLength(1);
  expect(all[0]?.agentId).toBe("active");
  store.destroy();
});

test("get returns undefined for an expired agent", () => {
  const store = new MemoryAgentStore();
  store.store([makeAgent("expired", -1)]);
  expect(store.get("expired")).toBeUndefined();
  store.destroy();
});

test("prune() removes expired agents from the internal map", () => {
  const store = new MemoryAgentStore();
  store.store([makeAgent("active", 60_000), makeAgent("expired", -1)]);
  store.prune();
  expect(store.getAll()).toHaveLength(1);
  expect(store.getAll()[0]?.agentId).toBe("active");
  store.destroy();
});

test("getAll() filters out agents that expire after being stored", () => {
  vi.useFakeTimers();
  const store = new MemoryAgentStore();
  store.store([makeAgent("a1", 1_000)]);
  vi.advanceTimersByTime(2_000);
  expect(store.getAll()).toHaveLength(0);
  store.destroy();
  vi.useRealTimers();
});

test("get() returns undefined for agent that expires after being stored", () => {
  vi.useFakeTimers();
  const store = new MemoryAgentStore();
  store.store([makeAgent("a1", 1_000)]);
  vi.advanceTimersByTime(2_000);
  expect(store.get("a1")).toBeUndefined();
  store.destroy();
  vi.useRealTimers();
});

test("interval calls prune() periodically", () => {
  vi.useFakeTimers();
  const store = new MemoryAgentStore(1_000);
  const pruneSpy = vi.spyOn(store, "prune");
  vi.advanceTimersByTime(3_000);
  expect(pruneSpy).toHaveBeenCalledTimes(3);
  store.destroy();
  vi.useRealTimers();
});

test("destroy() stops the prune interval", () => {
  vi.useFakeTimers();
  const store = new MemoryAgentStore(1_000);
  const pruneSpy = vi.spyOn(store, "prune");
  store.destroy();
  vi.advanceTimersByTime(5_000);
  expect(pruneSpy).not.toHaveBeenCalled();
  vi.useRealTimers();
});
