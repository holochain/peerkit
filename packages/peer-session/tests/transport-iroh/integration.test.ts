import { reset } from "@logtape/logtape";
import type {
  NodeAddress,
  NetworkAccessBytes,
  NetworkAccessHandler,
  AgentsReceivedCallback,
  PeerConnectedCallback,
  PeerDisconnectedCallback,
  MessageHandler,
  ITransport,
} from "@peerkit/api";
import { createNode } from "@peerkit/transport-iroh-nodejs";
import { MemoryAgentKeyStore } from "@peerkit/test-utils";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { setupTestLogger } from "../../../test-utils/dist/test-logger.js";
import {
  startNode,
  type NodeEventCallbacks,
  type NodeSession,
} from "../../src/index.js";

beforeEach(setupTestLogger);
afterEach(reset);

// Options the peerkit node builder passes to a transport factory.
interface FactoryOptions {
  id?: string;
  networkAccessBytes?: NetworkAccessBytes;
  networkAccessHandler: NetworkAccessHandler;
  agentsReceivedCallback: AgentsReceivedCallback;
  messageHandler?: MessageHandler;
  peerConnectedCallback?: PeerConnectedCallback;
  peerDisconnectedCallback?: PeerDisconnectedCallback;
  bootstrapRelays?: NodeAddress[];
}

// Offline iroh transport so the test is hermetic: endpoints connect directly
// over local addresses with no relay and no internet.
const offlineIrohFactory = (options: FactoryOptions): Promise<ITransport> =>
  createNode({ ...options, relay: false });

async function startIrohNode(
  bootstrapRelays: NodeAddress[],
  callbacks?: Partial<NodeEventCallbacks>,
): Promise<NodeSession> {
  return startNode({
    bootstrapRelays,
    agentKeyStore: new MemoryAgentKeyStore(),
    transportFactory: offlineIrohFactory,
    callbacks: {
      onPeerConnected: callbacks?.onPeerConnected ?? (() => {}),
      onPeerDisconnected: callbacks?.onPeerDisconnected ?? (() => {}),
      onAgentsReceived: callbacks?.onAgentsReceived ?? (() => {}),
      onRelayConnected: callbacks?.onRelayConnected ?? (() => {}),
      onAddressesChanged: callbacks?.onAddressesChanged ?? (() => {}),
      onMessageReceived: callbacks?.onMessageReceived ?? (() => {}),
    },
  });
}

test(
  "two iroh nodes: B dials A directly and delivers a message",
  { timeout: 30_000 },
  async () => {
    const aMessages: Array<{ alias: string; text: string }> = [];

    // A listens; with no relay tier, it just waits to be dialed.
    const sessionA = await startIrohNode([], {
      onMessageReceived: (alias, text) => {
        aMessages.push({ alias, text });
      },
    });
    const aAddress = sessionA.node.transport.getListenAddresses()[0];
    assert(aAddress);

    // B dials A's address directly.
    const sessionB = await startIrohNode([aAddress]);

    // The bootstrap dial establishes the transport connection first.
    await vi.waitFor(
      () =>
        expect(
          sessionB.node.transport.getConnectedPeers().length,
        ).toBeGreaterThan(0),
      { timeout: 15_000 },
    );

    // Then B learns about A from the connection's access handshake (peerkit
    // maps the peer's AgentId from its access bytes), so A shows up as a peer.
    await vi.waitFor(() => expect(sessionB.listPeers()).toHaveLength(1), {
      timeout: 15_000,
    });

    // B messages A (alias "1"); A receives it and assigns B alias "1".
    await sessionB.sendText("1", "hello from B");
    await vi.waitFor(
      () => {
        expect(aMessages).toHaveLength(1);
        expect(aMessages[0]).toEqual({ alias: "1", text: "hello from B" });
      },
      { timeout: 10_000 },
    );

    await sessionB.shutdown();
    await sessionA.shutdown();
  },
);
