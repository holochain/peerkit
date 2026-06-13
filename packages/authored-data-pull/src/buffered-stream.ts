import type { IStream } from "@peerkit/api";

/**
 * Buffers incoming stream messages, so the protocol can read them
 * one at a time with `next()`. A single persistent listener avoids the
 * register/remove pattern that would drop messages arriving between reads.
 */
export class BufferedStream {
  private readonly queue: Uint8Array[] = [];
  private waiters: Array<(data: Uint8Array | null) => void> = [];
  private closed = false;

  constructor(stream: IStream) {
    stream.addEventListener("message", (data) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(data);
      } else {
        this.queue.push(data);
      }
    });
    const onClose = () => {
      this.closed = true;
      for (const waiter of this.waiters) {
        waiter(null);
      }
      this.waiters = [];
    };
    stream.addEventListener("remoteClose", onClose);
    stream.addEventListener("close", onClose);
  }

  next(): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
