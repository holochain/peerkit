import { reset } from "@logtape/logtape";
import type { ITransport, NodeId } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { createNode } from "../src/node.js";

// These run against the real native iroh binding. `relay: false` keeps them
// hermetic: the two endpoints connect directly over local addresses, no internet.

beforeEach(setupTestLogger);
afterEach(reset);

interface Received {
  from: NodeId;
  bytes: Uint8Array;
}

interface TestNode {
  transport: ITransport;
  agents: Received[];
  messages: Received[];
}

async function makeNode(
  id: string,
  networkAccessHandler: () => Promise<boolean> = async () => true,
): Promise<TestNode> {
  const agents: Received[] = [];
  const messages: Received[] = [];
  const transport = await createNode({
    id,
    relay: false,
    networkAccessHandler,
    agentsReceivedCallback: async (from, bytes) => {
      agents.push({ from, bytes });
    },
    messageHandler: async (from, bytes) => {
      messages.push({ from, bytes });
    },
  });
  return { transport, agents, messages };
}

test("two nodes connect and exchange agents and messages", async () => {
  const a = await makeNode("a");
  const b = await makeNode("b");
  const aId = a.transport.getNodeId();
  const bId = b.transport.getNodeId();
  try {
    // The dialer runs the access handshake against the responder's real address.
    await a.transport.connect(b.transport.getListenAddresses());
    expect(a.transport.isConnected(bId)).toBe(true);
    await vi.waitFor(() => expect(b.transport.isConnected(aId)).toBe(true));

    // Agent-info from a reaches b's callback.
    await a.transport.sendAgents(bId, Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(b.agents).toHaveLength(1));
    assert(b.agents[0]);
    expect(b.agents[0].from).toBe(aId);
    expect(Array.from(b.agents[0].bytes)).toEqual([1, 2, 3]);

    // Messages flow in both directions over the connection.
    await a.transport.send(bId, Uint8Array.of(9));
    await b.transport.send(aId, Uint8Array.of(8));
    await vi.waitFor(() => {
      expect(a.messages).toHaveLength(1);
      expect(b.messages).toHaveLength(1);
    });
    assert(a.messages[0] && b.messages[0]);
    expect(Array.from(b.messages[0].bytes)).toEqual([9]);
    expect(Array.from(a.messages[0].bytes)).toEqual([8]);
  } finally {
    await a.transport.shutDown();
    await b.transport.shutDown();
  }
});

test("the connection is a direct path when offline", async () => {
  const a = await makeNode("a");
  const b = await makeNode("b");
  try {
    await a.transport.connect(b.transport.getListenAddresses());
    expect(a.transport.isDirectConnection(b.transport.getNodeId())).toBe(true);
  } finally {
    await a.transport.shutDown();
    await b.transport.shutDown();
  }
});

test("a denied dialer cannot connect", async () => {
  const a = await makeNode("a");
  const b = await makeNode("b", async () => false); // b denies everyone
  try {
    await expect(
      a.transport.connect(b.transport.getListenAddresses()),
    ).rejects.toThrow();
    expect(a.transport.isConnected(b.transport.getNodeId())).toBe(false);
  } finally {
    await a.transport.shutDown();
    await b.transport.shutDown();
  }
});
