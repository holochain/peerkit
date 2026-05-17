import { reset } from "@logtape/logtape";
import getPort, { portNumbers } from "get-port";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startNode, startRelay } from "../../src/index.js";
import { setupTestLogger } from "../util.js";

beforeEach(setupTestLogger);

afterEach(reset);

test(
  "Relay + two nodes: text message delivered end-to-end",
  { timeout: 30_000 },
  async () => {
    // Start a relay on a free port.
    const port = await getPort({ port: portNumbers(30_000, 40_000) });
    const listenAddr = `/ip4/127.0.0.1/tcp/${port}`;
    const relaySession = await startRelay({ listenAddr });
    const { dialAddr } = relaySession;

    // Messages received by node A (the one that will be dialed).
    const nodeAMessages: Array<{ alias: string; text: string }> = [];

    // Track when A has finished registering with the relay.
    // onRelayConnected fires after the relay has received A's agent info,
    // so B is guaranteed to learn about A when it connects.
    let aRelayConnected = false;

    const sessionA = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: () => {},
        onPeerDisconnected: () => {},
        onAgentsReceived: () => {},
        onRelayConnected: () => {
          aRelayConnected = true;
        },
        onMessageReceived: (alias, text) => {
          nodeAMessages.push({ alias, text });
        },
      },
    });

    // Relay only broadcasts stored agents when a peer connects, so A must
    // have completed its relay registration before B joins.
    await vi.waitFor(() => expect(aRelayConnected).toBe(true), {
      timeout: 10_000,
    });

    // B connects after A's info is in the relay — the relay will push A's
    // agent info to B during B's peerConnectedCallback.
    const sessionB = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: () => {},
        onPeerDisconnected: () => {},
        onAgentsReceived: () => {},
        onRelayConnected: () => {},
        onMessageReceived: () => {},
      },
    });

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
    // Start a relay on a free port.
    const port = await getPort({ port: portNumbers(30_000, 40_000) });
    const listenAddr = `/ip4/127.0.0.1/tcp/${port}`;
    const relaySession = await startRelay({ listenAddr });
    const { dialAddr } = relaySession;

    // A connects and fully registers with the relay before B joins.
    // onRelayConnected fires after the relay has received A's agent info.
    let aRelayConnected = false;

    const sessionA = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: () => {},
        onPeerDisconnected: () => {},
        onAgentsReceived: () => {},
        onRelayConnected: () => {
          aRelayConnected = true;
        },
        onMessageReceived: () => {},
      },
    });

    await vi.waitFor(() => expect(aRelayConnected).toBe(true), {
      timeout: 10_000,
    });

    // B joins after A is already registered. The relay receives B's agent
    // info and broadcasts it to A (the already-connected peer). A must
    // discover B through this broadcast — not through the snapshot sent on
    // connect, which only contained agents stored before B joined.
    const sessionB = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: () => {},
        onPeerDisconnected: () => {},
        onAgentsReceived: () => {},
        onRelayConnected: () => {},
        onMessageReceived: () => {},
      },
    });

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
  "onPeerDisconnected fires with alias and removes peer from connectedAgents",
  { timeout: 30_000 },
  async () => {
    // Start a relay so the two nodes can discover each other.
    const port = await getPort({ port: portNumbers(30_000, 40_000) });
    const listenAddr = `/ip4/127.0.0.1/tcp/${port}`;
    const relaySession = await startRelay({ listenAddr });
    const { dialAddr } = relaySession;

    let aRelayConnected = false;
    const aConnected: Array<{ alias: string }> = [];
    const aDisconnected: Array<{ alias: string }> = [];

    const sessionA = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: (alias) => {
          aConnected.push({ alias });
        },
        onPeerDisconnected: (alias) => {
          aDisconnected.push({ alias });
        },
        onAgentsReceived: () => {},
        onRelayConnected: () => {
          aRelayConnected = true;
        },
        onMessageReceived: () => {},
      },
    });

    await vi.waitFor(() => expect(aRelayConnected).toBe(true), {
      timeout: 10_000,
    });

    const sessionB = await startNode({
      bootstrapRelays: [dialAddr],
      callbacks: {
        onPeerConnected: () => {},
        onPeerDisconnected: () => {},
        onAgentsReceived: () => {},
        onRelayConnected: () => {},
        onMessageReceived: () => {},
      },
    });

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
