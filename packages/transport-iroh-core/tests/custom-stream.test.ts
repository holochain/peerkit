import { reset } from "@logtape/logtape";
import type { IStream, NodeId } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { TransportIroh } from "../src/transport.js";
import { MockDriver, MockNetwork } from "./mock-driver.js";

beforeEach(setupTestLogger);
afterEach(reset);

const PROTOCOL = "/custom/1";

function makeTransport(network: MockNetwork, id: NodeId): TransportIroh {
  return new TransportIroh(new MockDriver(id, network), {
    networkAccessHandler: async () => true,
    agentsReceivedCallback: async () => {},
  });
}

async function connectedPair() {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  const b = makeTransport(network, "b");
  return { network, a, b };
}

test("a custom stream carries messages in both directions", async () => {
  const { a, b } = await connectedPair();

  const serverReceived: Uint8Array[] = [];
  b.registerStreamHandler(PROTOCOL, (_nodeId, stream) => {
    stream.addEventListener("message", (message) => {
      serverReceived.push(message);
      stream.send(Uint8Array.of(99)); // reply on the same stream
    });
  });

  await a.connect(b.getListenAddresses());
  const clientStream = await a.createStream("b", PROTOCOL);
  const clientReceived: Uint8Array[] = [];
  clientStream.addEventListener("message", (message) => {
    clientReceived.push(message);
  });

  clientStream.send(Uint8Array.of(1, 2, 3));

  await vi.waitFor(() => expect(serverReceived).toHaveLength(1));
  assert(serverReceived[0]);
  expect(Array.from(serverReceived[0])).toEqual([1, 2, 3]);

  await vi.waitFor(() => expect(clientReceived).toHaveLength(1));
  assert(clientReceived[0]);
  expect(Array.from(clientReceived[0])).toEqual([99]);

  await a.shutDown();
  await b.shutDown();
});

test("closing the stream fires a close event and marks it closed", async () => {
  const { a, b } = await connectedPair();
  b.registerStreamHandler(PROTOCOL, () => {});

  await a.connect(b.getListenAddresses());
  const stream: IStream = await a.createStream("b", PROTOCOL);
  expect(stream.isOpen()).toBe(true);

  const closed = new Promise<void>((resolve) => {
    stream.addEventListener("close", () => resolve());
  });
  await stream.close();
  await closed;
  expect(stream.isOpen()).toBe(false);

  await a.shutDown();
  await b.shutDown();
});

test("createStream without a connection throws", async () => {
  const network = new MockNetwork();
  const a = makeTransport(network, "a");
  await expect(a.createStream("nobody", PROTOCOL)).rejects.toThrow();
  await a.shutDown();
});
