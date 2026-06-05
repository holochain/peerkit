/**
 * A `TextEncoder` / `TextDecoder` polyfill for the React Native Hermes engine.
 *
 * Hermes ships neither global, yet libp2p reaches for them at
 * module-evaluation time: `uint8arrays` (a transitive dependency of nearly
 * every libp2p package) constructs `new TextEncoder()` / `new TextDecoder()`
 * to convert between UTF-8 strings and byte arrays for peer ids, multiaddrs,
 * and protocol names. Without these globals the bundle red-screens with
 * `Property 'TextDecoder' doesn't exist` before any application code runs.
 *
 * Only UTF-8 is implemented — the single encoding libp2p uses through these
 * APIs. The conversion is delegated to `Buffer` (already a required shim, see
 * `polyfills`), which provides a spec-correct UTF-8 implementation including
 * surrogate-pair handling and replacement of malformed sequences. Owning a
 * thin wrapper here, rather than pulling in a third-party text-encoding
 * package, keeps the polyfill surface small and dependency-free.
 */

import { Buffer } from "buffer";

const UTF8_ENCODING = "utf-8";

// The WHATWG labels that all denote UTF-8. A `TextDecoder` constructed with any
// other label must throw, matching browser behavior and surfacing accidental
// non-UTF-8 usage rather than silently misdecoding.
const UTF8_LABELS: ReadonlySet<string> = new Set([
  "utf-8",
  "utf8",
  "unicode-1-1-utf-8",
]);

interface TextDecoderOptionsLike {
  readonly fatal?: boolean;
  readonly ignoreBOM?: boolean;
}

// A `Buffer` is a `Uint8Array` whose `toString` accepts an encoding argument.
// The package's ambient `buffer` declaration (see `rn-modules.d.ts`) types
// `from` loosely as returning `unknown`; this narrows it to just the surface
// the codec needs without widening that shared shim.
interface Utf8Buffer extends Uint8Array {
  toString(encoding?: string): string;
}

interface BufferFactory {
  from(value: string, encoding: string): Utf8Buffer;
  from(
    value: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  ): Utf8Buffer;
}

const bufferFactory = Buffer as unknown as BufferFactory;

/** WHATWG `TextEncoder`, UTF-8 only. */
class PolyfillTextEncoder {
  get encoding(): string {
    return UTF8_ENCODING;
  }

  encode(input: string = ""): Uint8Array {
    return new Uint8Array(bufferFactory.from(input, "utf8"));
  }
}

/**
 * WHATWG `TextDecoder`, UTF-8 only.
 *
 * `fatal` and `ignoreBOM` are accepted and reflected as readonly properties for
 * API-shape compatibility, but not honored: `Buffer.toString('utf8')` always
 * replaces malformed sequences (`fatal: false`) and never strips a BOM. libp2p
 * constructs decoders with default options, so this is sufficient — a caller
 * relying on `fatal`/`ignoreBOM` semantics is out of this polyfill's scope.
 */
class PolyfillTextDecoder {
  readonly encoding = UTF8_ENCODING;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(
    label: string = UTF8_ENCODING,
    options: TextDecoderOptionsLike = {},
  ) {
    if (!UTF8_LABELS.has(label.toLowerCase())) {
      throw new RangeError(
        `Unsupported encoding: ${label}. Only UTF-8 is supported.`,
      );
    }
    this.fatal = options.fatal ?? false;
    this.ignoreBOM = options.ignoreBOM ?? false;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input == null) {
      return "";
    }
    const bytes = ArrayBuffer.isView(input)
      ? bufferFactory.from(input.buffer, input.byteOffset, input.byteLength)
      : bufferFactory.from(input);
    return bytes.toString("utf8");
  }
}

/**
 * Install `TextEncoder` and `TextDecoder` on the global scope if the runtime
 * does not already provide them. Idempotent and safe to call more than once;
 * on a runtime that ships its own implementations (e.g. Node in tests) this is
 * a no-op.
 */
export function installTextCodecPolyfill(): void {
  const codecScope = globalThis as {
    TextEncoder?: unknown;
    TextDecoder?: unknown;
  };
  codecScope.TextEncoder ??= PolyfillTextEncoder;
  codecScope.TextDecoder ??= PolyfillTextDecoder;
}
