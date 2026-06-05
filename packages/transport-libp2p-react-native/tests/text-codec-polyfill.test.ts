import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { installTextCodecPolyfill } from "../src/text-codec-polyfill.js";

// Node already provides `TextEncoder` / `TextDecoder`, so the polyfill is a
// no-op there. To exercise the hand-rolled classes we strip those globals,
// install the polyfill onto the bare scope, then restore the originals so the
// rest of the suite (and other files) observe Node's implementations.
type TextCodecGlobals = Pick<typeof globalThis, "TextEncoder" | "TextDecoder">;

const mutableGlobal = globalThis as unknown as Record<
  keyof TextCodecGlobals,
  unknown
>;

let saved: TextCodecGlobals;

beforeEach(() => {
  saved = {
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  };
  delete mutableGlobal.TextEncoder;
  delete mutableGlobal.TextDecoder;
  installTextCodecPolyfill();
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

describe("installTextCodecPolyfill", () => {
  test("installs both codec globals when the runtime lacks them", () => {
    expect(typeof globalThis.TextEncoder).toBe("function");
    expect(typeof globalThis.TextDecoder).toBe("function");
  });

  test("round-trips multi-byte UTF-8 through encode/decode", () => {
    // libp2p's `uint8arrays` encodes protocol names, peer ids, and arbitrary
    // user strings; the codec must survive characters outside the ASCII range,
    // including ones that require surrogate pairs (emoji).
    const original = "héllo · 世界 · 🚀";
    const encoded = new globalThis.TextEncoder().encode(original);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(new globalThis.TextDecoder().decode(encoded)).toBe(original);
  });

  test("decodes a plain Uint8Array view of bytes", () => {
    const bytes = new Uint8Array([0x68, 0x69]); // "hi"

    expect(new globalThis.TextDecoder().decode(bytes)).toBe("hi");
  });

  test("decode with no argument yields the empty string", () => {
    expect(new globalThis.TextDecoder().decode()).toBe("");
  });

  test("reports the utf-8 encoding", () => {
    expect(new globalThis.TextEncoder().encoding).toBe("utf-8");
    expect(new globalThis.TextDecoder().encoding).toBe("utf-8");
  });

  test("rejects encodings other than utf-8", () => {
    expect(() => new globalThis.TextDecoder("utf-16")).toThrow(RangeError);
  });
});
