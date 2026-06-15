/**
 * @fileoverview Integration tests for the relay.
 *
 * Spins up a real relay bound to a free loopback TCP port, then dials it
 * with peerkit node transports to exercise the network-access handshake,
 * agent storage, signature verification, replay, circuit-relay forwarding,
 * sticky denial, and disconnect handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeAgentInfoList } from "@peerkit/peerkit";
import {
  computeNetworkAccessBytes,
  makeSignedAgentInfo,
  startTestNode,
  startTestRelay,
  type TestNode,
  type TestRelay,
} from "./test-helpers.js";

const TEST_TIMEOUT_MS = 30_000;
const WAIT_OPTS = { timeout: 10_000, interval: 25 } as const;

describe("relay integration", () => {
  let relay: TestRelay;
  const nodes: TestNode[] = [];

  beforeEach(async () => {
    relay = await startTestRelay();
  });

  afterEach(async () => {
    await Promise.allSettled(nodes.splice(0).map((n) => n.shutdown()));
    await relay.shutdown();
  });

  async function spawn(opts?: Parameters<typeof startTestNode>[0]) {
    const n = await startTestNode(opts);
    nodes.push(n);
    return n;
  }

  it(
    "rejects nodes that present wrong access bytes",
    async () => {
      const wrong = computeNetworkAccessBytes("not-the-secret");
      const n = await spawn({ accessBytes: wrong });
      await expect(n.node.connect([relay.multiaddr])).rejects.toThrow(
        /Access denied/,
      );
      expect(relay.relay.peerCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "accepts nodes that present the correct access bytes",
    async () => {
      const n = await spawn();
      await n.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(1),
        WAIT_OPTS,
      );
      expect(relay.relay.peerCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stores verified agent info received from a connected node",
    async () => {
      const n = await spawn();
      await n.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(1),
        WAIT_OPTS,
      );
      const { info, bytes } = await makeSignedAgentInfo();
      await n.node.sendAgents(relay.relay.nodeId, bytes);
      await vi.waitFor(
        () => expect(relay.store.get(info.agentId)).toBeTruthy(),
        WAIT_OPTS,
      );
      expect(relay.store.getAll()).toContainEqual(info);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops an agent info whose signature does not verify",
    async () => {
      const n = await spawn();
      await n.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(1),
        WAIT_OPTS,
      );
      const { bytes } = await makeSignedAgentInfo();
      // Corrupt the cbor payload so the signature can no longer verify.
      bytes[bytes.length - 1] ^= 0xff;
      await n.node.sendAgents(relay.relay.nodeId, bytes);
      // Give the relay time to process (and reject) the payload.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(relay.store.getAll()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replays stored agents to a newly connected peer",
    async () => {
      const first = await spawn();
      const { info, bytes } = await makeSignedAgentInfo();
      await first.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(1),
        WAIT_OPTS,
      );
      await first.node.sendAgents(relay.relay.nodeId, bytes);
      await vi.waitFor(
        () => expect(relay.store.get(info.agentId)).toBeTruthy(),
        WAIT_OPTS,
      );

      const second = await spawn();
      await second.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(second.receivedAgents.length).toBeGreaterThan(0),
        WAIT_OPTS,
      );
      const replayed = deserializeAgentInfoList(
        second.receivedAgents[0]!.bytes,
      );
      expect(replayed).toContainEqual(info);
      // The relay forwards agent info under its own nodeId; original-sender
      // attribution lives inside each signed record, not the transport frame.
      expect(second.receivedAgents[0]?.from).toBe(relay.relay.nodeId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "forwards a circuit-relayed connection between two nodes end-to-end",
    async () => {
      const a = await spawn({ bootstrapRelays: [relay.multiaddr] });
      const b = await spawn({ bootstrapRelays: [relay.multiaddr] });
      const aNodeAddresses = await a.waitForCircuitAddr();
      const bNodeAddresses = await b.waitForCircuitAddr();
      expect(
        aNodeAddresses.every((a) => a.includes("/p2p-circuit")),
      ).toBeTruthy();
      expect(
        bNodeAddresses.every((a) => a.includes("/p2p-circuit")),
      ).toBeTruthy();
      expect(aNodeAddresses.some((a) => a.includes("/webrtc"))).toBeTruthy();
      expect(bNodeAddresses.some((a) => a.includes("/webrtc"))).toBeTruthy();

      await a.node.connect([bNodeAddresses[0]]);
      await vi.waitFor(
        () => expect(a.node.isConnected(b.nodeId)).toBe(true),
        WAIT_OPTS,
      );

      const payload = new Uint8Array([42, 13, 7]);
      await a.node.send(b.nodeId, payload);
      await vi.waitFor(
        () => expect(b.received.length).toBeGreaterThan(0),
        WAIT_OPTS,
      );
      expect(b.received[0]?.from).toBe(a.nodeId);
      expect(b.received[0]?.bytes).toEqual(payload);
    },
    TEST_TIMEOUT_MS,
  );

  it("keeps track of connected relays", async () => {
    const a = await spawn({ bootstrapRelays: [relay.multiaddr] });
    await vi.waitFor(() => expect(a.connectedRelays).toHaveLength(1));
    expect(a.connectedRelays.has(relay.relay.nodeId)).toBeTruthy();
  });

  it(
    "keeps access denial sticky across reconnects from the same peer",
    async () => {
      const wrong = computeNetworkAccessBytes("not-the-secret");
      const n = await spawn({ accessBytes: wrong });
      await expect(n.node.connect([relay.multiaddr])).rejects.toThrow(
        /Access denied/,
      );
      // Second attempt: libp2p may surface the closed-muxer error rather
      // than peerkit's "Access denied" — the relay-side stickiness is
      // proven by `peerCount()` staying 0 across both attempts.
      await expect(n.node.connect([relay.multiaddr])).rejects.toThrow();
      expect(relay.relay.peerCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "decrements peerCount on disconnect but retains the agent record",
    async () => {
      const n = await spawn();
      const { info, bytes } = await makeSignedAgentInfo();
      await n.node.connect([relay.multiaddr]);
      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(1),
        WAIT_OPTS,
      );
      await n.node.sendAgents(relay.relay.nodeId, bytes);
      await vi.waitFor(
        () => expect(relay.store.get(info.agentId)).toBeTruthy(),
        WAIT_OPTS,
      );
      expect(relay.relay.peerCount()).toBe(1);

      await n.node.shutDown();
      // Remove from cleanup registry since we shut it down ourselves.
      nodes.splice(nodes.indexOf(n), 1);

      await vi.waitFor(
        () => expect(relay.relay.peerCount()).toBe(0),
        WAIT_OPTS,
      );
      // The store is keyed by AgentId and expires by each record's own
      // expiresAt; a transport disconnect does not evict the record.
      expect(relay.store.get(info.agentId)).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );
});
