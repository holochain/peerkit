import { expect, test } from "vitest";
import { completeWhenStateConfirmed } from "../src/node.js";

test("accepts an operation error when the requested state is confirmed", async () => {
  let connected = false;

  await expect(
    completeWhenStateConfirmed(
      async () => {
        connected = true;
        throw new Error("another caller connected first");
      },
      () => connected,
    ),
  ).resolves.toBeUndefined();
});

test("accepts a disconnect error when the peer is already disconnected", async () => {
  let connected = true;

  await expect(
    completeWhenStateConfirmed(
      async () => {
        connected = false;
        throw new Error("peer disconnected first");
      },
      () => !connected,
    ),
  ).resolves.toBeUndefined();
});

test("preserves an operation error when the requested state is not confirmed", async () => {
  const error = new Error("connection refused");

  await expect(
    completeWhenStateConfirmed(
      async () => {
        throw error;
      },
      () => false,
    ),
  ).rejects.toBe(error);
});
