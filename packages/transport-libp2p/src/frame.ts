/** 4-byte big-endian length prefix. */
const HEADER_SIZE = 4;

/**
 * Encodes a message as a length-prefixed frame.
 *
 * The frame layout is:
 *   [0..3]  uint32 big-endian: byte length of the payload
 *   [4..]   payload bytes
 */
export function encodeFrame(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + data.byteLength);
  // DataView is needed to write a multi-byte integer into a Uint8Array's
  // underlying buffer with a guaranteed byte order (false = big-endian).
  new DataView(frame.buffer).setUint32(0, data.byteLength, false);
  frame.set(data, HEADER_SIZE);
  return frame;
}

/**
 * Accumulates raw bytes from a stream and extracts complete length-prefixed
 * frames. Feed it every received chunk; it returns all complete messages
 * decoded from the accumulated buffer, handling the case where a single
 * logical message arrives across multiple chunks or multiple messages arrive
 * in a single chunk.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  /**
   * Feed a raw chunk into the decoder.
   *
   * @returns Zero or more complete messages decoded from the accumulated buffer.
   */
  feed(chunk: Uint8Array): Uint8Array[] {
    // Append the new chunk to whatever was left over from the previous feed.
    const combined = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    combined.set(this.buf, 0);
    combined.set(chunk, this.buf.byteLength);
    this.buf = combined;

    const messages: Uint8Array[] = [];
    while (this.buf.byteLength >= HEADER_SIZE) {
      // buf.byteOffset is required because slice() may return a view into a
      // larger buffer, so the DataView must start at the view's actual offset.
      const msgLen = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
      ).getUint32(0, false);
      // Not enough bytes for the full payload yet; wait for the next feed.
      if (this.buf.byteLength < HEADER_SIZE + msgLen) {
        break;
      }
      messages.push(this.buf.slice(HEADER_SIZE, HEADER_SIZE + msgLen));
      // Advance past the frame we just consumed.
      this.buf = this.buf.slice(HEADER_SIZE + msgLen);
    }
    return messages;
  }
}
