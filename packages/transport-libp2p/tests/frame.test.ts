import { assert, describe, expect, test } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/frame.js";

describe("encodeFrame", () => {
  test("prefixes payload with its 4-byte big-endian length", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(payload);

    expect(frame.byteLength).toBe(7); // 4-byte header + 3-byte payload
    // Header encodes the payload length as a big-endian uint32.
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(3);
    expect(Array.from(frame.slice(4))).toEqual([1, 2, 3]);
  });

  test("handles empty payload", () => {
    const frame = encodeFrame(new Uint8Array(0));
    expect(frame.byteLength).toBe(4);
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(0);
  });
});

describe("FrameDecoder", () => {
  test("decodes a single complete frame fed at once", () => {
    const decoder = new FrameDecoder();
    const payload = new Uint8Array([10, 20, 30]);
    const msgs = decoder.feed(encodeFrame(payload));

    assert(msgs.length === 1 && msgs[0]);
    expect(Array.from(msgs[0])).toEqual([10, 20, 30]);
  });

  test("returns nothing when chunk contains only a partial header", () => {
    const decoder = new FrameDecoder();
    const msgs = decoder.feed(new Uint8Array([0, 0]));
    expect(msgs).toHaveLength(0);
  });

  test("returns nothing when chunk contains a complete header but partial payload", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(new Uint8Array([1, 2, 3, 4, 5]));
    const msgs = decoder.feed(frame.slice(0, 5)); // header + 1 byte of 5
    expect(msgs).toHaveLength(0);
  });

  test("reassembles a message split across multiple chunks", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(new Uint8Array([1, 2, 3, 4, 5]));

    expect(decoder.feed(frame.slice(0, 3))).toHaveLength(0);
    expect(decoder.feed(frame.slice(3, 6))).toHaveLength(0);
    const msgs = decoder.feed(frame.slice(6));

    assert(msgs.length === 1 && msgs[0]);
    expect(Array.from(msgs[0])).toEqual([1, 2, 3, 4, 5]);
  });

  test("decodes multiple messages arriving in a single chunk", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame(new Uint8Array([1, 2]));
    const b = encodeFrame(new Uint8Array([3, 4, 5]));
    const combined = new Uint8Array(a.byteLength + b.byteLength);
    combined.set(a, 0);
    combined.set(b, a.byteLength);

    const msgs = decoder.feed(combined);
    assert(msgs.length === 2 && msgs[0] && msgs[1]);
    expect(Array.from(msgs[0])).toEqual([1, 2]);
    expect(Array.from(msgs[1])).toEqual([3, 4, 5]);
  });

  test("decodes messages split across chunks with a boundary mid-header", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame(new Uint8Array([42]));
    const b = encodeFrame(new Uint8Array([99]));
    const combined = new Uint8Array(a.byteLength + b.byteLength);
    combined.set(a, 0);
    combined.set(b, a.byteLength);

    // Split right through the second frame's header
    const split = a.byteLength + 2;
    const first = decoder.feed(combined.slice(0, split));
    assert(first.length && first[0]);
    expect(first).toHaveLength(1);
    expect(Array.from(first[0])).toEqual([42]);

    const second = decoder.feed(combined.slice(split));
    assert(second.length && second[0]);
    expect(second).toHaveLength(1);
    expect(Array.from(second[0])).toEqual([99]);
  });

  test("round-trips a large payload", () => {
    const decoder = new FrameDecoder();
    // yamux has a 256 KiB max frame size
    const payload = new Uint8Array(1024 * 300).fill(7);
    const msgs = decoder.feed(encodeFrame(payload));

    assert(msgs.length === 1 && msgs[0]);
    expect(msgs[0].byteLength).toBe(payload.byteLength);
    expect(msgs[0].every((b) => b === 7)).toBe(true);
  });
});
