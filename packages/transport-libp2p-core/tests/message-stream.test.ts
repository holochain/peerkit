import { StreamCloseEvent, type Stream } from "@libp2p/interface";
import { describe, expect, test, vi } from "vitest";
import { encodeFrame } from "../src/frame.js";
import { MessageStream } from "../src/message-stream.js";

/**
 * Minimal stand-in for a libp2p Stream. `sendResults` scripts the return value
 * of each `send()` call; `true` means accepted with capacity to spare, `false`
 * means accepted but the caller must wait for `drain`.
 */
class FakeStream extends EventTarget {
  readonly sent: Uint8Array[] = [];
  status: "open" | "closed" = "open";
  writableNeedsDrain = false;

  constructor(private readonly sendResults: boolean[] = []) {
    super();
  }

  send(data: Uint8Array): boolean {
    if (this.status !== "open") {
      throw new Error("Cannot write to a stream that is closed");
    }
    this.sent.push(data);
    const accepted = this.sendResults.shift() ?? true;
    this.writableNeedsDrain = !accepted;
    return accepted;
  }

  /** Simulates libp2p: its own drain listener clears the flag before ours. */
  drain(): void {
    this.writableNeedsDrain = false;
    this.dispatchEvent(new Event("drain"));
  }

  /** Emits libp2p's message event shape (`data` with `subarray()`). */
  receive(chunk: Uint8Array): void {
    const event = new Event("message") as Event & { data: Uint8Array };
    event.data = chunk;
    this.dispatchEvent(event);
  }

  close(error?: Error): void {
    this.status = "closed";
    this.dispatchEvent(new StreamCloseEvent(true, error));
  }
}

// FakeStream models only the members MessageStream touches.
function asStream(stream: FakeStream): Stream {
  return stream as unknown as Stream;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MessageStream inbound", () => {
  test("decodes frames split across chunks and delivers them in order", async () => {
    const stream = new FakeStream();
    const received: Uint8Array[] = [];
    new MessageStream(
      asStream(stream),
      (message) => {
        received.push(message);
      },
      () => {},
    );
    const frame = encodeFrame(new Uint8Array([1, 2, 3, 4]));

    // Split the frame in the middle of the payload.
    stream.receive(frame.subarray(0, 6));
    stream.receive(frame.subarray(6));
    await flushMicrotasks();

    expect(received).toEqual([new Uint8Array([1, 2, 3, 4])]);
  });

  test("reports listener failures through onError instead of rejecting unhandled", async () => {
    const stream = new FakeStream();
    const onError = vi.fn();
    new MessageStream(
      asStream(stream),
      async () => {
        throw new Error("handler failed");
      },
      onError,
    );

    stream.receive(encodeFrame(new Uint8Array([1])));
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe("MessageStream outbound", () => {
  test("resolves immediately when the stream accepts the frame", async () => {
    const stream = new FakeStream([true]);
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const frame = new Uint8Array([1]);

    await messageStream.send(frame);

    expect(stream.sent).toEqual([frame]);
  });

  test("holds the next frame until drain after a backpressured send", async () => {
    // First send returns false: the stream accepted it but is saturated.
    const stream = new FakeStream([false, true]);
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const firstDone = vi.fn();
    const secondDone = vi.fn();

    void messageStream.send(first).then(firstDone);
    void messageStream.send(second).then(secondDone);
    await flushMicrotasks();

    // Only the first frame reached the stream; nothing has resolved.
    expect(stream.sent).toEqual([first]);
    expect(firstDone).not.toHaveBeenCalled();
    expect(secondDone).not.toHaveBeenCalled();

    stream.drain();
    await flushMicrotasks();

    // Drain released the first send and let the second frame through.
    expect(stream.sent).toEqual([first, second]);
    expect(firstDone).toHaveBeenCalledOnce();
    expect(secondDone).toHaveBeenCalledOnce();
  });

  test("waits for drain before writing when the stream already needs it", async () => {
    const stream = new FakeStream([true]);
    stream.writableNeedsDrain = true;
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const done = vi.fn();

    void messageStream.send(new Uint8Array([1])).then(done);
    await flushMicrotasks();

    // Nothing written while the stream reports it needs drain.
    expect(stream.sent).toEqual([]);

    stream.drain();
    await flushMicrotasks();

    expect(stream.sent).toHaveLength(1);
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("MessageStream close", () => {
  test("rejects a send waiting for drain when the stream closes", async () => {
    const stream = new FakeStream([false]);
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const send = messageStream.send(new Uint8Array([1]));
    await flushMicrotasks();

    stream.close(new Error("stream reset"));

    await expect(send).rejects.toThrow("stream reset");
  });

  test("rejects every queued send when the stream closes", async () => {
    const stream = new FakeStream([false]);
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const first = messageStream.send(new Uint8Array([1]));
    const second = messageStream.send(new Uint8Array([2]));
    const third = messageStream.send(new Uint8Array([3]));
    await flushMicrotasks();

    // Close without an error still rejects with a descriptive message.
    stream.close();

    await expect(first).rejects.toThrow("Message stream closed");
    await expect(second).rejects.toThrow("Message stream closed");
    await expect(third).rejects.toThrow("Message stream closed");
    // Only the first frame was ever handed to the stream.
    expect(stream.sent).toHaveLength(1);
  });

  test("rejects sends issued after close and reports isOpen false", async () => {
    const stream = new FakeStream();
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );

    stream.close();

    expect(messageStream.isOpen).toBe(false);
    await expect(messageStream.send(new Uint8Array([1]))).rejects.toThrow(
      "Message stream closed",
    );
  });

  test("rejects when stream.send throws and keeps serving later sends", async () => {
    const stream = new FakeStream();
    const messageStream = new MessageStream(
      asStream(stream),
      () => {},
      () => {},
    );
    const original = stream.send.bind(stream);
    let calls = 0;
    stream.send = (data: Uint8Array): boolean => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient write failure");
      }
      return original(data);
    };

    await expect(messageStream.send(new Uint8Array([1]))).rejects.toThrow(
      "transient write failure",
    );
    // A failed write does not poison the queue.
    await messageStream.send(new Uint8Array([2]));

    expect(stream.sent).toEqual([new Uint8Array([2])]);
  });
});
