import { reset } from "@logtape/logtape";
import type { NodeId } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { TransportIroh } from "../src/transport.js";
import { MockDriver, MockNetwork } from "./mock-driver.js";

beforeEach(setupTestLogger);
afterEach(reset);

interface ReceivedMessage {
  from: NodeId;
  bytes: Uint8Array;
}

// A transport that grants access to everyone and records the messages it receives.
function makeTransport(
  network: MockNetwork,
  id: NodeId,
): { transport: TransportIroh; received: ReceivedMessage[] } {
  const received: ReceivedMessage[] = [];
  const transport = new TransportIroh(new MockDriver(id, network), {
    networkAccessHandler: async () => true,
    agentsReceivedCallback: async () => {},
    messageHandler: async (from, bytes) => {
      received.push({ from, bytes });
    },
  });
  return { transport, received };
}

async function connectedPair() {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  const b = makeTransport(network, "b");
  await a.transport.connect(b.transport.getListenAddresses());
  await vi.waitFor(() => expect(b.transport.isConnected("a")).toBe(true));
  return { a, b };
}

test("delivers a message to the receiver's handler", async () => {
  const { a, b } = await connectedPair();
  await a.transport.send("b", Uint8Array.of(1, 2, 3));

  await vi.waitFor(() => expect(b.received).toHaveLength(1));
  assert(b.received[0]);
  expect(b.received[0].from).toBe("a");
  expect(Array.from(b.received[0].bytes)).toEqual([1, 2, 3]);

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("carries messages in both directions over one stream", async () => {
  const { a, b } = await connectedPair();
  // b replies on the same stream a opened.
  await a.transport.send("b", Uint8Array.of(1));
  await vi.waitFor(() => expect(b.received).toHaveLength(1));
  await b.transport.send("a", Uint8Array.of(2));

  await vi.waitFor(() => expect(a.received).toHaveLength(1));
  assert(a.received[0] && b.received[0]);
  expect(Array.from(b.received[0].bytes)).toEqual([1]);
  expect(Array.from(a.received[0].bytes)).toEqual([2]);

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("preserves the order of messages sent on the reused stream", async () => {
  const { a, b } = await connectedPair();
  await a.transport.send("b", Uint8Array.of(1));
  await a.transport.send("b", Uint8Array.of(2));
  await a.transport.send("b", Uint8Array.of(3));

  await vi.waitFor(() => expect(b.received).toHaveLength(3));
  expect(b.received.map((r) => Array.from(r.bytes))).toEqual([[1], [2], [3]]);

  await a.transport.shutDown();
  await b.transport.shutDown();
});

test("send without a connection throws", async () => {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  await expect(a.transport.send("nobody", Uint8Array.of(1))).rejects.toThrow();
  await a.transport.shutDown();
});
