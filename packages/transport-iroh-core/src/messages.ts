import { encodeFrame, FrameDecoder } from "@peerkit/transport-shared";
import type { IrohStream } from "./driver.js";

/**
 * A QUIC stream is a raw byte stream, so peerkit delimits messages on it with
 * the shared length-prefix framing. These helpers put that framing on top of an
 * {@link IrohStream}.
 */

/** Send one length-prefixed message over the stream. */
export async function writeMessage(
  stream: IrohStream,
  data: Uint8Array,
): Promise<void> {
  await stream.write(encodeFrame(data));
}

/**
 * Yield length-prefixed messages from the stream as they arrive, until the peer
 * finishes sending. A single read may carry several messages or only part of
 * one, so the decoder reassembles across reads.
 */
export async function* readMessages(
  stream: IrohStream,
): AsyncGenerator<Uint8Array> {
  const decoder = new FrameDecoder();
  for (;;) {
    const chunk = await stream.read();
    if (chunk === null) return;
    yield* decoder.feed(chunk);
  }
}
