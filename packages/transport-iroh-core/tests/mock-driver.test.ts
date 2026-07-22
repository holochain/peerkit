import { expect, test } from "vitest";
import { connectedDrivers, MockDriver, MockNetwork } from "./mock-driver.js";

test("connect + accept: both sides see the correct remote id", async () => {
  const { a, b, connA, connB } = await connectedDrivers();
  // The dialing side's connection reports the peer it dialed, and vice versa.
  expect(connA.remoteNodeId()).toBe(b.getNodeId());
  expect(connB.remoteNodeId()).toBe(a.getNodeId());
});

test("openStream + acceptStream round-trips bytes", async () => {
  const { connA, connB } = await connectedDrivers();
  const [near, far] = await Promise.all([
    connA.openStream(),
    connB.acceptStream(),
  ]);
  await near.write(new Uint8Array([1, 2, 3]));
  await near.finishWrite();
  const got = await far.readToEnd(1024);
  expect(Array.from(got)).toEqual([1, 2, 3]);
});

test("read returns null once the writer finishes", async () => {
  const { connA, connB } = await connectedDrivers();
  const [near, far] = await Promise.all([
    connA.openStream(),
    connB.acceptStream(),
  ]);
  await near.write(new Uint8Array([9]));
  await near.finishWrite();
  expect(await far.read()).not.toBeNull(); // the one chunk
  expect(await far.read()).toBeNull(); // end of stream
});

test("connecting to an unknown address rejects", async () => {
  const network = new MockNetwork();
  const solo = new MockDriver("solo", network);
  await expect(solo.connect("nobody")).rejects.toThrow();
});

test("closing a connection rejects a pending acceptStream", async () => {
  const { connA, connB } = await connectedDrivers();
  const accepting = connB.acceptStream(); // no stream will ever arrive
  connA.close();
  await expect(accepting).rejects.toThrow();
});

test("closing the driver rejects a pending accept", async () => {
  const network = new MockNetwork();
  const lonely = new MockDriver("lonely", network);
  const accepting = lonely.accept(); // nobody will connect
  await lonely.close();
  await expect(accepting).rejects.toThrow();
});
