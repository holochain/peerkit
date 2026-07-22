import type { IStream, PeerkitStreamEvents } from "@peerkit/api";
import type { IrohStream } from "./driver.js";
import { writeMessage } from "./messages.js";

/**
 * A custom-protocol stream over one iroh bi-stream, exposing peerkit's
 * {@link IStream} event interface. Messages are length-prefix framed like every
 * other peerkit stream.
 *
 * A single read loop drains the stream and fans messages out to the registered
 * listeners, so add/remove operate on plain Sets.
 */
export class CustomStream implements IStream {
  private readonly messageListeners = new Set<PeerkitStreamEvents["message"]>();
  private readonly remoteCloseListeners = new Set<
    PeerkitStreamEvents["remoteClose"]
  >();
  private readonly closeListeners = new Set<PeerkitStreamEvents["close"]>();
  private open = true;

  // `reader` yields framed messages from the stream — already past the protocol
  // preamble for an inbound stream.
  constructor(
    private readonly stream: IrohStream,
    reader: AsyncGenerator<Uint8Array>,
  ) {
    void this.readLoop(reader);
  }

  send(data: Uint8Array): void {
    // IStream.send is fire-and-forget; the framed write runs in the background.
    void writeMessage(this.stream, data);
  }

  addEventListener<K extends keyof PeerkitStreamEvents>(
    type: K,
    listener: PeerkitStreamEvents[K],
  ): void {
    if (type === "message") {
      this.messageListeners.add(listener as PeerkitStreamEvents["message"]);
    } else if (type === "remoteClose") {
      this.remoteCloseListeners.add(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    } else {
      this.closeListeners.add(listener as PeerkitStreamEvents["close"]);
    }
  }

  removeEventListener<K extends keyof PeerkitStreamEvents>(
    type: K,
    listener: PeerkitStreamEvents[K],
  ): void {
    if (type === "message") {
      this.messageListeners.delete(listener as PeerkitStreamEvents["message"]);
    } else if (type === "remoteClose") {
      this.remoteCloseListeners.delete(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    } else {
      this.closeListeners.delete(listener as PeerkitStreamEvents["close"]);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  async close(): Promise<void> {
    // Close both halves; the read loop then ends and fires the close event.
    await Promise.allSettled([
      this.stream.finishWrite(),
      this.stream.stopRead(),
    ]);
  }

  private async readLoop(reader: AsyncGenerator<Uint8Array>): Promise<void> {
    try {
      for await (const message of reader) {
        for (const listener of this.messageListeners) listener(message);
      }
      // The peer finished sending on their end.
      const event = new Event("remoteClose");
      for (const listener of this.remoteCloseListeners) listener(event);
    } catch {
      // The stream errored; fall through to the close notification.
    } finally {
      this.open = false;
      for (const listener of this.closeListeners) listener();
    }
  }
}
