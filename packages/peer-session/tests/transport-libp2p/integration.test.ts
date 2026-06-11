import { reset } from "@logtape/logtape";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setupTestLogger } from "../../../test-utils/dist/test-logger.js";
import { startTestNode, startTestRelay } from "./util.js";

beforeEach(setupTestLogger);

afterEach(reset);

test(
  "Relay + two nodes: text message delivered end-to-end",
  { timeout: 30_000 },
  async () => {
    const relaySession = await startTestRelay();
    const { dialAddr } = relaySession;

    // Messages received by node A (the one that will be dialed).
    const nodeAMessages: Array<{ alias: string; text: string }> = [];

    // Start A and wait for relay registration before starting B.
    // startTestNode resolves after onRelayConnected fires, so B is
    // guaranteed to learn about A when it connects.
    const sessionA = await startTestNode(dialAddr, {
      onMessageReceived: (alias, text) => {
        nodeAMessages.push({ alias, text });
      },
    });

    // B connects after A's info is in the relay — the relay will push A's
    // agent info to B during B's peerConnectedCallback.
    const sessionB = await startTestNode(dialAddr);

    // Wait for B to discover A via the relay broadcast.
    await vi.waitFor(
      () => {
        expect(sessionB.listPeers()).toHaveLength(1);
      },
      { timeout: 15_000 },
    );

    // B sends to alias "1" (A, the first peer B discovered).
    // sendText connects and sends.
    await sessionB.sendText("1", "hello from B");

    // A receives the message. A assigns alias "1" to B.
    await vi.waitFor(
      () => {
        expect(nodeAMessages).toHaveLength(1);
        expect(nodeAMessages[0]).toEqual({ alias: "1", text: "hello from B" });
      },
      { timeout: 10_000 },
    );

    await sessionA.shutdown();
    await sessionB.shutdown();
    await relaySession.shutdown();
  },
);

test(
  "relay broadcasts late-joining peer's agents to already-connected nodes",
  { timeout: 30_000 },
  async () => {
    const relaySession = await startTestRelay();
    const { dialAddr } = relaySession;

    // A connects and fully registers with the relay before B joins.
    // startTestNode resolves after onRelayConnected fires.
    const sessionA = await startTestNode(dialAddr);

    // B joins after A is already registered. The relay receives B's agent
    // info and broadcasts it to A (the already-connected peer). A must
    // discover B through this broadcast — not through the snapshot sent on
    // connect, which only contained agents stored before B joined.
    const sessionB = await startTestNode(dialAddr);

    await vi.waitFor(() => expect(sessionA.listPeers()).toHaveLength(1), {
      timeout: 15_000,
    });
    expect(sessionA.listPeers()[0]?.agentId).toBe(sessionB.myAgentId);

    await sessionA.shutdown();
    await sessionB.shutdown();
    await relaySession.shutdown();
  },
);

test(
  "onPeerDisconnected fires on disconnect with alias and removes peer from connectedAgents",
  { timeout: 30_000 },
  async () => {
    // Start a relay so the two nodes can discover each other.
    const relaySession = await startTestRelay();
    const { dialAddr } = relaySession;

    const aConnected: Array<{ alias: string }> = [];
    const aDisconnected: Array<{ alias: string }> = [];

    const sessionA = await startTestNode(dialAddr, {
      onPeerConnected: (alias) => {
        aConnected.push({ alias });
      },
      onPeerDisconnected: (alias) => {
        aDisconnected.push({ alias });
      },
    });

    const sessionB = await startTestNode(dialAddr);

    // Wait for B to discover A and send a message so a direct connection forms.
    await vi.waitFor(() => expect(sessionB.listPeers()).toHaveLength(1), {
      timeout: 15_000,
    });
    await sessionB.sendText("1", "hi");

    // Wait for A to see B as connected.
    await vi.waitFor(() => expect(aConnected).toHaveLength(1), {
      timeout: 10_000,
    });
    const bAlias = aConnected[0].alias;
    const aAlias = sessionA.listPeers()[0].alias;

    // Disconnect with an non-existing alias throws.
    await expect(sessionB.disconnect("harold")).rejects.toThrow(
      /Unknown alias/,
    );

    // B disconnects — A's onPeerDisconnected must fire with B's alias.
    await sessionB.disconnect(aAlias);

    await vi.waitFor(() => expect(aDisconnected).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(aDisconnected[0]?.alias).toBe(bAlias);

    // B is no longer listed as connected in A's peer list.
    const bPeer = sessionA.listPeers().find((p) => p.alias === bAlias);
    expect(bPeer?.connected).toBe(false);

    await sessionA.shutdown();
    await sessionB.shutdown();
    await relaySession.shutdown();
  },
);

test(
  "onPeerDisconnected fires on shutdown with alias and removes peer from connectedAgents on shutdown",
  { timeout: 30_000 },
  async () => {
    // Start a relay so the two nodes can discover each other.
    const relaySession = await startTestRelay();
    const { dialAddr } = relaySession;

    const aConnected: Array<{ alias: string }> = [];
    const aDisconnected: Array<{ alias: string }> = [];

    const sessionA = await startTestNode(dialAddr, {
      onPeerConnected: (alias) => {
        aConnected.push({ alias });
      },
      onPeerDisconnected: (alias) => {
        aDisconnected.push({ alias });
      },
    });

    const sessionB = await startTestNode(dialAddr);

    // Wait for B to discover A and send a message so a direct connection forms.
    await vi.waitFor(() => expect(sessionB.listPeers()).toHaveLength(1), {
      timeout: 15_000,
    });
    await sessionB.sendText("1", "hi");

    // Wait for A to see B as connected.
    await vi.waitFor(() => expect(aConnected).toHaveLength(1), {
      timeout: 10_000,
    });
    const bAlias = aConnected[0]!.alias;

    // B shuts down — A's onPeerDisconnected must fire with B's alias.
    await sessionB.shutdown();

    await vi.waitFor(() => expect(aDisconnected).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(aDisconnected[0]?.alias).toBe(bAlias);

    // B is no longer listed as connected in A's peer list.
    const bPeer = sessionA.listPeers().find((p) => p.alias === bAlias);
    expect(bPeer?.connected).toBe(false);

    await sessionA.shutdown();
    await relaySession.shutdown();
  },
);
