import { reset } from "@logtape/logtape";
import type { NetworkAccessHandler, NodeId } from "@peerkit/api";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeMessage } from "../src/messages.js";
import { TransportIroh } from "../src/transport.js";
import { MockDriver, MockNetwork } from "./mock-driver.js";

beforeEach(setupTestLogger);
afterEach(reset);

// Record of the peer-connected / peer-disconnected notifications a transport fires.
interface Events {
  connected: NodeId[];
  disconnected: NodeId[];
}

// Build a transport on the shared network with the given access decision.
function makeTransport(
  network: MockNetwork,
  id: NodeId,
  networkAccessHandler: NetworkAccessHandler,
): { transport: TransportIroh; events: Events } {
  const events: Events = { connected: [], disconnected: [] };
  const transport = new TransportIroh(new MockDriver(id, network), {
    networkAccessHandler,
    peerConnectedCallback: async (nodeId) => {
      events.connected.push(nodeId);
    },
    peerDisconnectedCallback: async (nodeId) => {
      events.disconnected.push(nodeId);
    },
  });
  return { transport, events };
}

const grantAll: NetworkAccessHandler = async () => true;
const denyAll: NetworkAccessHandler = async () => false;

test("grants access and connects both sides", async () => {
  const network = new MockNetwork();
  const server = makeTransport(network, "server", grantAll);
  const client = makeTransport(network, "client", grantAll);

  await client.transport.connect(server.transport.getListenAddresses());

  // The initiator sees the peer as soon as connect resolves.
  expect(client.transport.isConnected("server")).toBe(true);
  expect(client.events.connected).toContain("server");

  // The responder completes a beat later, once it receives the ack.
  await vi.waitFor(() => {
    expect(server.transport.isConnected("client")).toBe(true);
    expect(server.events.connected).toContain("client");
  });

  await client.transport.shutDown();
  await server.transport.shutDown();
});

test("a denial by the responder closes the connection and rejects connect", async () => {
  const network = new MockNetwork();
  const server = makeTransport(network, "server", denyAll);
  const client = makeTransport(network, "client", grantAll);

  await expect(
    client.transport.connect(server.transport.getListenAddresses()),
  ).rejects.toThrow();

  // Neither side treats the peer as connected.
  expect(client.events.connected).not.toContain("server");
  expect(server.events.connected).not.toContain("client");
  // The closed connection is dropped on the initiator side.
  await vi.waitFor(() =>
    expect(client.transport.isConnected("server")).toBe(false),
  );

  await client.transport.shutDown();
  await server.transport.shutDown();
});

test("a denial by the initiator closes the connection and rejects connect", async () => {
  const network = new MockNetwork();
  const server = makeTransport(network, "server", grantAll);
  // The client denies the server's access bytes.
  const client = makeTransport(network, "client", denyAll);

  await expect(
    client.transport.connect(server.transport.getListenAddresses()),
  ).rejects.toThrow("Access denied to remote");

  expect(client.events.connected).not.toContain("server");
  expect(server.events.connected).not.toContain("client");

  await client.transport.shutDown();
  await server.transport.shutDown();
});

test("a denied peer is turned away on reconnect without asking again", async () => {
  const network = new MockNetwork();
  let serverCalls = 0;
  const server = makeTransport(network, "server", async () => {
    serverCalls++;
    return false;
  });
  const client = makeTransport(network, "client", grantAll);

  await expect(
    client.transport.connect(server.transport.getListenAddresses()),
  ).rejects.toThrow();
  expect(serverCalls).toBe(1);

  // The second attempt is rejected immediately, without consulting the handler.
  await expect(
    client.transport.connect(server.transport.getListenAddresses()),
  ).rejects.toThrow();
  expect(serverCalls).toBe(1);

  await client.transport.shutDown();
  await server.transport.shutDown();
});

test("disconnect drops the connection and notifies both sides", async () => {
  const network = new MockNetwork();
  const server = makeTransport(network, "server", grantAll);
  const client = makeTransport(network, "client", grantAll);
  await client.transport.connect(server.transport.getListenAddresses());
  await vi.waitFor(() =>
    expect(server.transport.isConnected("client")).toBe(true),
  );

  await client.transport.disconnect("server");
  expect(client.transport.isConnected("server")).toBe(false);
  expect(client.events.disconnected).toContain("server");

  // The server sees its side close too.
  await vi.waitFor(() => {
    expect(server.transport.isConnected("client")).toBe(false);
    expect(server.events.disconnected).toContain("client");
  });

  await client.transport.shutDown();
  await server.transport.shutDown();
});

test("a stream opened before access is granted closes the whole connection", async () => {
  const network = new MockNetwork();
  const server = makeTransport(network, "server", grantAll);

  // A peer that skips the handshake and opens a message stream straight away.
  const rogue = new MockDriver("rogue", network);
  const connection = await rogue.connect("server");
  const stream = await connection.openStream();
  await writeMessage(stream, new TextEncoder().encode("/peerkit/message/v1"));
  await writeMessage(stream, new Uint8Array([1]));
  await stream.finishWrite();

  // The server closes the whole connection, so opening another stream fails.
  await vi.waitFor(async () => {
    await expect(connection.openStream()).rejects.toThrow();
  });

  await server.transport.shutDown();
});
