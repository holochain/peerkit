import { reset } from "@logtape/logtape";
import type { NodeId } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { TransportIroh } from "../src/transport.js";
import { MockDriver, MockNetwork } from "./mock-driver.js";

beforeEach(setupTestLogger);
afterEach(reset);

interface ReceivedAgents {
  from: NodeId;
  bytes: Uint8Array;
}

// A transport that grants access to everyone and records the agent-info it receives.
function makeTransport(
  network: MockNetwork,
  id: NodeId,
): { transport: TransportIroh; received: ReceivedAgents[] } {
  const received: ReceivedAgents[] = [];
  const transport = new TransportIroh(new MockDriver(id, network), {
    networkAccessHandler: async () => true,
    agentsReceivedCallback: async (from, bytes) => {
      received.push({ from, bytes });
    },
  });
  return { transport, received };
}

// Two connected transports, with the responder's handshake already complete.
async function connectedPair() {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  const b = makeTransport(network, "b");
  await a.transport.connect(b.transport.getListenAddresses());
  await vi.waitFor(() => expect(b.transport.isConnected("a")).toBe(true));
  return { a, b };
}

test("delivers agent-info to the receiver's callback", async () => {
  const { a, b } = await connectedPair();
  await a.transport.sendAgents("b", Uint8Array.of(1, 2, 3, 4));

  await vi.waitFor(() => expect(b.received).toHaveLength(1));
  assert(b.received[0]);
  expect(b.received[0].from).toBe("a");
  expect(Array.from(b.received[0].bytes)).toEqual([1, 2, 3, 4]);

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("delivers in both directions over the same connection", async () => {
  const { a, b } = await connectedPair();
  await a.transport.sendAgents("b", Uint8Array.of(1));
  await b.transport.sendAgents("a", Uint8Array.of(2));

  await vi.waitFor(() => {
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });
  assert(a.received[0] && b.received[0]);
  expect(Array.from(b.received[0].bytes)).toEqual([1]);
  expect(Array.from(a.received[0].bytes)).toEqual([2]);

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("each call delivers a separate payload", async () => {
  const { a, b } = await connectedPair();
  await a.transport.sendAgents("b", Uint8Array.of(1));
  await a.transport.sendAgents("b", Uint8Array.of(2, 2));

  await vi.waitFor(() => expect(b.received).toHaveLength(2));
  // Each payload arrives on its own stream; order between them is not important.
  const payloads = new Set(b.received.map((r) => r.bytes.join(",")));
  expect(payloads).toEqual(new Set(["1", "2,2"]));

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("sendAgents without a connection throws", async () => {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  await expect(
    a.transport.sendAgents("nobody", Uint8Array.of(1)),
  ).rejects.toThrow();
  await a.transport.shutDown();
});
