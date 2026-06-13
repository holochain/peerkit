import type { IStream, PeerkitStreamEvents } from "@peerkit/api";
import { expect, test } from "vitest";
import { BufferedStream } from "../src/buffered-stream.js";

// Minimal mock that lets the test fire message / remoteClose / close events
// on demand without any network involvement.
class MockStream implements IStream {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly remoteCloseListeners = new Set<
    PeerkitStreamEvents["remoteClose"]
  >();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  send(_data: Uint8Array): void {}

  isOpen(): boolean {
    return true;
  }
  async close(): Promise<void> {}

  addEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void {
    if (type === "message")
      this.messageListeners.add(listener as (data: Uint8Array) => void);
    else if (type === "remoteClose")
      this.remoteCloseListeners.add(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    else this.closeListeners.add(listener as (error?: Error) => void);
  }

  removeEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void {
    if (type === "message")
      this.messageListeners.delete(listener as (data: Uint8Array) => void);
    else if (type === "remoteClose")
      this.remoteCloseListeners.delete(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    else this.closeListeners.delete(listener as (error?: Error) => void);
  }

  emitMessage(data: Uint8Array): void {
    for (const l of this.messageListeners) l(data);
  }

  emitRemoteClose(): void {
    for (const l of this.remoteCloseListeners) l(new Event("remoteClose"));
  }

  emitClose(error?: Error): void {
    for (const l of this.closeListeners) l(error);
  }
}

const encode = (text: string) => new TextEncoder().encode(text);

test("Message buffered before next() is returned synchronously", async () => {
  // A message arriving before next() is called must be queued and returned
  // immediately rather than being lost.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  stream.emitMessage(encode("hello"));

  const result = await buffered.next();
  expect(result).toEqual(encode("hello"));
});

test("next() waits when queue is empty, then resolves on message", async () => {
  // When no message is ready, next() must suspend until one arrives.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  const promise = buffered.next();
  stream.emitMessage(encode("world"));

  expect(await promise).toEqual(encode("world"));
});

test("Multiple messages buffered before any next() are drained in order", async () => {
  // Messages emitted in rapid succession must be queued and returned FIFO.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  stream.emitMessage(encode("one"));
  stream.emitMessage(encode("two"));
  stream.emitMessage(encode("three"));

  expect(await buffered.next()).toEqual(encode("one"));
  expect(await buffered.next()).toEqual(encode("two"));
  expect(await buffered.next()).toEqual(encode("three"));
});

test("remoteClose resolves a waiting next() with null", async () => {
  // A pending next() must resolve with null when the remote closes their
  // write end. This is the protocol's end-of-exchange signal.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  const promise = buffered.next();
  stream.emitRemoteClose();

  expect(await promise).toBeNull();
});

test("close event resolves a waiting next() with null", async () => {
  // A full stream close must also resolve null.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  const promise = buffered.next();
  stream.emitClose();

  expect(await promise).toBeNull();
});

test("next() returns null immediately after remoteClose already fired", async () => {
  // Once the stream is marked closed, subsequent next() calls must return
  // null synchronously without registering a waiter.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  stream.emitRemoteClose();

  expect(await buffered.next()).toBeNull();
  expect(await buffered.next()).toBeNull();
});

test("Queued messages are drained before null after remoteClose", async () => {
  // If messages and remoteClose arrive before any next(), the buffered messages
  // must be returned first, then null — not the other way around.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  stream.emitMessage(encode("a"));
  stream.emitMessage(encode("b"));
  stream.emitRemoteClose();

  expect(await buffered.next()).toEqual(encode("a"));
  expect(await buffered.next()).toEqual(encode("b"));
  expect(await buffered.next()).toBeNull();
});

test("Second close signal after remoteClose is harmless", async () => {
  // Both remoteClose and close may fire on the same stream. The second one
  // must be a silent no-op — no duplicate null deliveries, no errors.
  const stream = new MockStream();
  const buffered = new BufferedStream(stream);

  const promise = buffered.next();
  stream.emitRemoteClose();
  stream.emitClose(); // duplicate — must not throw or double-resolve

  expect(await promise).toBeNull();
  expect(await buffered.next()).toBeNull();
});
