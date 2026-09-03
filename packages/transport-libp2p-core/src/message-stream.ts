import type { Stream, StreamCloseEvent } from "@libp2p/interface";
import { FrameDecoder } from "./frame.js";

export type MessageStreamListener = (
  message: Uint8Array,
) => Promise<void> | void;

export type MessageStreamErrorListener = (error: unknown) => void;

interface PendingSend {
  frame: Uint8Array;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface DrainWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Owns one long-lived libp2p message stream.
 *
 * Inbound: decodes length-prefixed frames and hands each message to the
 * listener, one at a time per chunk.
 *
 * Outbound: writes queued frames one at a time. `Stream.send()` returning
 * `false` means the stream buffered the frame but must not receive more until
 * `drain`; the queue waits for that event before the next write.
 *
 * Listeners are registered once and never removed because libp2p streams do
 * not reliably support `removeEventListener`. `Stream.onDrain()` is not used
 * because `@libp2p/utils` 7.2.1 never resets its promise after the first drain.
 */
export class MessageStream {
  private readonly queue: PendingSend[] = [];
  private pumping = false;
  private drainWaiter?: DrainWaiter;
  private closeError?: Error;

  constructor(
    private readonly stream: Stream,
    onMessage: MessageStreamListener,
    onError: MessageStreamErrorListener,
  ) {
    const decoder = new FrameDecoder();
    stream.addEventListener("message", async (event) => {
      try {
        for (const message of decoder.feed(event.data.subarray())) {
          await onMessage(message);
        }
      } catch (error) {
        onError(error);
      }
    });
    stream.addEventListener("drain", () => {
      this.drainWaiter?.resolve();
      this.drainWaiter = undefined;
    });
    stream.addEventListener("close", (event: StreamCloseEvent) => {
      this.closeError = event.error ?? new Error("Message stream closed");
      this.drainWaiter?.reject(this.closeError);
      this.drainWaiter = undefined;
      for (const pending of this.queue.splice(0)) {
        pending.reject(this.closeError);
      }
    });
  }

  get isOpen(): boolean {
    return this.closeError === undefined && this.stream.status === "open";
  }

  send(frame: Uint8Array): Promise<void> {
    if (this.closeError) {
      return Promise.reject(this.closeError);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ frame, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      let next = this.queue.shift();
      while (next !== undefined) {
        try {
          await this.write(next.frame);
          next.resolve();
        } catch (error) {
          next.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        next = this.queue.shift();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async write(frame: Uint8Array): Promise<void> {
    // A previous drain may have let libp2p re-saturate the stream from its
    // own buffer, so check before writing as well as after.
    if (this.stream.writableNeedsDrain) {
      await this.drained();
    }
    if (!this.stream.send(frame)) {
      await this.drained();
    }
  }

  private drained(): Promise<void> {
    if (this.closeError) {
      return Promise.reject(this.closeError);
    }
    return new Promise<void>((resolve, reject) => {
      this.drainWaiter = { resolve, reject };
    });
  }
}
