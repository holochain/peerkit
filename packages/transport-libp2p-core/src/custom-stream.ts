import type {
  Stream,
  StreamCloseEvent,
  StreamMessageEvent,
} from "@libp2p/interface";
import type { IStream, PeerkitStreamEvents } from "@peerkit/api";
import { encodeFrame, FrameDecoder } from "./frame.js";

/**
 * Stream with a custom protocol that can be created on existing connections
 * to peers.
 *
 * Enables sending any kind of data over peerkit's connection to the peer.
 */
export class CustomStream implements IStream {
  private stream: Stream;
  private messageListeners = new Set<(data: Uint8Array) => void>();
  private remoteCloseListeners = new Set<PeerkitStreamEvents["remoteClose"]>();
  private closeListeners = new Set<(error?: Error) => void>();

  constructor(stream: Stream) {
    this.stream = stream;

    // Register single dispatchers per event type in the constructor.
    // stream.removeEventListener does not work reliably: the underlying
    // TypedEventEmitter wraps each listener on add but passes the original to
    // remove, so EventTarget never finds a match. Owning the dispatch loop
    // here lets addEventListener/removeEventListener operate on plain Sets.
    const frameDecoder = new FrameDecoder();
    stream.addEventListener("message", (event: StreamMessageEvent) => {
      for (const msg of frameDecoder.feed(event.data.subarray())) {
        for (const listener of this.messageListeners) {
          listener(msg);
        }
      }
    });
    stream.addEventListener("remoteCloseWrite", (event: Event) => {
      for (const listener of this.remoteCloseListeners) {
        listener(event);
      }
    });
    stream.addEventListener("close", (closeEvent: StreamCloseEvent) => {
      for (const listener of this.closeListeners) {
        listener(closeEvent.error);
      }
    });
  }

  send(data: Uint8Array): void {
    this.stream.send(encodeFrame(data));
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
    return this.stream.status === "open";
  }

  async close(): Promise<void> {
    return this.stream.close();
  }
}
