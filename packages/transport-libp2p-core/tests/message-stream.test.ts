import { StreamCloseEvent, type Stream } from "@libp2p/interface";
import { describe, expect, test } from "vitest";
import { MessageStream } from "../src/message-stream.js";

interface FakeStreamOptions {
  readonly closesSynchronouslyOnBackpressure?: boolean;
  readonly throwsOnSend?: boolean;
}

class FakeStream extends EventTarget {
  readonly sent: Uint8Array[] = [];
  private readonly eventListeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  private readonly sendResults: boolean[];
  private readonly closesSynchronouslyOnBackpressure: boolean;
  private readonly throwsOnSend: boolean;

  constructor(sendResults: boolean[], options: FakeStreamOptions = {}) {
    super();
    this.sendResults = sendResults;
    this.closesSynchronouslyOnBackpressure =
      options.closesSynchronouslyOnBackpressure ?? false;
    this.throwsOnSend = options.throwsOnSend ?? false;
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, listener, options);
    if (listener !== null) {
      const listeners = this.eventListeners.get(type) ?? new Set();
      listeners.add(listener);
      this.eventListeners.set(type, listeners);
    }
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, listener, options);
    if (listener !== null) {
      this.eventListeners.get(type)?.delete(listener);
    }
  }

  listenerCount(type: string): number {
    return this.eventListeners.get(type)?.size ?? 0;
  }

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    if (this.throwsOnSend) {
      throw new Error("stream send failed");
    }
    const sendResult = this.sendResults.shift() ?? true;
    if (!sendResult && this.closesSynchronouslyOnBackpressure) {
      this.close(new Error("stream closed synchronously"));
    }
    return sendResult;
  }

  drain(): void {
    this.dispatchEvent(new Event("drain"));
  }

  close(error?: Error): void {
    this.dispatchEvent(new StreamCloseEvent(true, error));
  }
}

// FakeStream models only the stream methods used by MessageStream.
function asLibp2pStream(stream: FakeStream): Stream {
  return stream as unknown as Stream;
}

describe("MessageStream", () => {
  test("waits for drain before resolving and sending the next queued frame", async () => {
    const stream = new FakeStream([false, true]);
    const messageStream = new MessageStream(asLibp2pStream(stream));
    const firstFrame = new Uint8Array([1]);
    const secondFrame = new Uint8Array([2]);

    const firstSend = messageStream.send(firstFrame);
    await Promise.resolve();
    expect(stream.sent).toEqual([firstFrame]);
    let firstSendResolved = false;
    void firstSend.then(() => {
      firstSendResolved = true;
    });
    await Promise.resolve();
    expect(firstSendResolved).toBe(false);

    const secondSend = messageStream.send(secondFrame);
    await Promise.resolve();
    expect(stream.sent).toEqual([firstFrame]);

    stream.drain();
    await firstSend;
    await secondSend;

    expect(stream.sent).toEqual([firstFrame, secondFrame]);
  });

  test("rejects a backpressured send when the stream closes before draining", async () => {
    const stream = new FakeStream([false]);
    const messageStream = new MessageStream(asLibp2pStream(stream));
    const send = messageStream.send(new Uint8Array([1]));

    await Promise.resolve();
    stream.close(new Error("stream closed"));

    await expect(send).rejects.toThrow("stream closed");
  });

  test("rejects when the stream closes synchronously during a backpressured send", async () => {
    const stream = new FakeStream([false], {
      closesSynchronouslyOnBackpressure: true,
    });
    const messageStream = new MessageStream(asLibp2pStream(stream));

    await expect(messageStream.send(new Uint8Array([1]))).rejects.toThrow(
      "stream closed synchronously",
    );
  });

  test("removes listeners when stream.send throws", async () => {
    const stream = new FakeStream([true], { throwsOnSend: true });
    const messageStream = new MessageStream(asLibp2pStream(stream));

    await expect(messageStream.send(new Uint8Array([1]))).rejects.toThrow(
      "stream send failed",
    );

    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  });
});
