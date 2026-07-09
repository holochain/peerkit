import { encodeFrame } from "@peerkit/transport-shared";
import { assert, expect, test } from "vitest";
import type { IrohStream } from "../src/driver.js";
import { readMessages, writeMessage } from "../src/messages.js";
import { connectedStreams } from "./mock-driver.js";

async function collect(stream: IrohStream): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const msg of readMessages(stream)) out.push(msg);
  return out;
}

test("round-trips a single message", async () => {
  const [near, far] = await connectedStreams();
  await writeMessage(near, new Uint8Array([1, 2, 3]));
  await near.finishWrite();

  const msgs = await collect(far);
  assert(msgs.length === 1 && msgs[0]);
  expect(Array.from(msgs[0])).toEqual([1, 2, 3]);
});

test("preserves multiple messages in order", async () => {
  const [near, far] = await connectedStreams();
  await writeMessage(near, new Uint8Array([1]));
  await writeMessage(near, new Uint8Array([2, 2]));
  await writeMessage(near, new Uint8Array([3, 3, 3]));
  await near.finishWrite();

  const msgs = await collect(far);
  expect(msgs.map((m) => Array.from(m))).toEqual([[1], [2, 2], [3, 3, 3]]);
});

test("reassembles a message split across raw writes", async () => {
  const [near, far] = await connectedStreams();
  // Split one frame across two writes; the decoder must rejoin it.
  const frame = encodeFrame(new Uint8Array([7, 7, 7, 7, 7]));
  await near.write(frame.slice(0, 3));
  await near.write(frame.slice(3));
  await near.finishWrite();

  const msgs = await collect(far);
  assert(msgs.length === 1 && msgs[0]);
  expect(Array.from(msgs[0])).toEqual([7, 7, 7, 7, 7]);
});

test("stops yielding once the peer finishes sending", async () => {
  const [near, far] = await connectedStreams();
  await writeMessage(near, new Uint8Array([1]));
  await near.finishWrite();

  // Returns rather than hanging past the end of the stream.
  const msgs = await collect(far);
  expect(msgs.length).toBe(1);
});

test("first message can be read, then the rest handed off", async () => {
  // The preamble pattern: read the protocol id, then iterate the body.
  const [near, far] = await connectedStreams();
  await writeMessage(near, new TextEncoder().encode("/peerkit/access/v1"));
  await writeMessage(near, new Uint8Array([42]));
  await near.finishWrite();

  const reader = readMessages(far);
  const first = await reader.next();
  assert(!first.done && first.value);
  expect(new TextDecoder().decode(first.value)).toBe("/peerkit/access/v1");

  const rest: Uint8Array[] = [];
  for await (const msg of reader) rest.push(msg);
  expect(rest.map((m) => Array.from(m))).toEqual([[42]]);
});
