import { pureJsCrypto } from "@chainsafe/libp2p-noise";
import { Uint8ArrayList } from "uint8arraylist";
import { describe, expect, test, vi } from "vitest";

// `quick-crypto-noise` imports `react-native-quick-crypto` at module load and
// calls its Node-compatible `createHash` / `createHmac` / `createCipheriv` /
// `createDecipheriv` surface. That package ships no Node build and is not
// installed in the workspace, so we substitute Node's own `node:crypto`, which
// exposes the identical API. The factory is async because `vi.mock` is hoisted
// above the imports, so it cannot close over an imported binding.
vi.mock("react-native-quick-crypto", async () => {
  const nodeCrypto = await import("node:crypto");
  return { default: nodeCrypto };
});

// Imported after the mock is registered so the module under test binds to the
// `node:crypto`-backed stand-in.
const { quickCryptoNoise } = await import("../src/quick-crypto-noise.js");

// Deterministic fixtures: every byte is fixed so a regression in the mapping
// produces a stable, diffable failure rather than a flaky one.
const CHAINING_KEY = new Uint8Array(32).fill(0x11);
const INPUT_KEY_MATERIAL = new Uint8Array(32).fill(0x22);
const PLAINTEXT = new TextEncoder().encode("peerkit noise payload");
const NONCE = new Uint8Array(12).fill(0x33);
const ASSOCIATED_DATA = new Uint8Array([0xaa, 0xbb, 0xcc]);
const KEY = new Uint8Array(32).fill(0x44);

// The reference and quick-crypto paths may return different `Uint8Array`
// wrappers for the same bytes (a Node `Buffer` versus a plain `Uint8Array`),
// which `toEqual` treats as unequal. Compare the byte content directly.
function bytes(value: Uint8Array): number[] {
  return Array.from(value);
}

describe("quickCryptoNoise.hashSHA256", () => {
  test("matches the pure-JS Noise reference byte-for-byte", () => {
    // The JSI-backed SHA-256 must be a drop-in for the pure-JS one; any
    // divergence would corrupt the Noise transcript hash.
    const data = new TextEncoder().encode("the quick brown fox");
    expect(bytes(quickCryptoNoise.hashSHA256(data))).toEqual(
      bytes(pureJsCrypto.hashSHA256(data)),
    );
  });

  test("accepts a Uint8ArrayList input", () => {
    // libp2p frequently hands crypto a `Uint8ArrayList`; `toBytes` must
    // flatten it to the same digest as the equivalent contiguous array.
    const parts = new Uint8ArrayList(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    );
    const contiguous = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(bytes(quickCryptoNoise.hashSHA256(parts))).toEqual(
      bytes(pureJsCrypto.hashSHA256(contiguous)),
    );
  });
});

describe("quickCryptoNoise.getHKDF", () => {
  test("derives the same three 32-byte blocks as the reference", () => {
    // HKDF is hand-rolled here (extract + three expand steps); compare every
    // output block against the audited pure-JS implementation.
    const actual = quickCryptoNoise.getHKDF(CHAINING_KEY, INPUT_KEY_MATERIAL);
    const expected = pureJsCrypto.getHKDF(CHAINING_KEY, INPUT_KEY_MATERIAL);

    expect(actual).toHaveLength(3);
    expect(bytes(actual[0])).toEqual(bytes(expected[0]));
    expect(bytes(actual[1])).toEqual(bytes(expected[1]));
    expect(bytes(actual[2])).toEqual(bytes(expected[2]));
  });
});

describe("quickCryptoNoise.chaCha20Poly1305Encrypt", () => {
  test("produces the reference ciphertext-with-appended-tag", () => {
    // The Noise wire format is `ciphertext || tag`; a matching byte sequence
    // confirms both the AEAD output and the tag-append ordering.
    const actual = quickCryptoNoise.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    const expected = pureJsCrypto.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    expect(bytes(actual.subarray())).toEqual(bytes(expected.subarray()));
    // ciphertext length + 16-byte Poly1305 tag.
    expect(actual).toHaveLength(PLAINTEXT.length + 16);
  });
});

describe("quickCryptoNoise.chaCha20Poly1305Decrypt", () => {
  test("recovers plaintext from its own ciphertext", () => {
    const ciphertext = quickCryptoNoise.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    expect(
      quickCryptoNoise.chaCha20Poly1305Decrypt(
        ciphertext,
        NONCE,
        ASSOCIATED_DATA,
        KEY,
      ),
    ).toEqual(PLAINTEXT);
  });

  test("decrypts ciphertext produced by the reference implementation", () => {
    // Interop both directions: a peer running the pure-JS Noise crypto must be
    // decryptable by the quick-crypto path, and vice versa.
    const reference = pureJsCrypto.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    expect(
      quickCryptoNoise.chaCha20Poly1305Decrypt(
        reference,
        NONCE,
        ASSOCIATED_DATA,
        KEY,
      ),
    ).toEqual(PLAINTEXT);
  });

  test("accepts a Uint8ArrayList ciphertext", () => {
    const ciphertext = quickCryptoNoise.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    const asList = new Uint8ArrayList(ciphertext);
    expect(
      quickCryptoNoise.chaCha20Poly1305Decrypt(
        asList,
        NONCE,
        ASSOCIATED_DATA,
        KEY,
      ),
    ).toEqual(PLAINTEXT);
  });

  test("rejects ciphertext shorter than the authentication tag", () => {
    // A buffer too short to even hold the 16-byte tag is malformed; the guard
    // must throw rather than hand a negative-length slice to the cipher.
    const tooShort = new Uint8Array(8);
    expect(() =>
      quickCryptoNoise.chaCha20Poly1305Decrypt(
        tooShort,
        NONCE,
        ASSOCIATED_DATA,
        KEY,
      ),
    ).toThrow(/shorter than tag length/);
  });

  test("fails authentication when associated data differs", () => {
    // AEAD binds the AAD: decrypting with mismatched AAD must fail the tag
    // check, proving the AAD is actually fed into the cipher.
    const ciphertext = quickCryptoNoise.chaCha20Poly1305Encrypt(
      PLAINTEXT,
      NONCE,
      ASSOCIATED_DATA,
      KEY,
    );
    const wrongAd = new Uint8Array([0x00, 0x00, 0x00]);
    expect(() =>
      quickCryptoNoise.chaCha20Poly1305Decrypt(ciphertext, NONCE, wrongAd, KEY),
    ).toThrow();
  });
});

describe("quickCryptoNoise composition", () => {
  test("inherits synchronous X25519 from the pure-JS crypto", () => {
    // X25519 is intentionally not overridden (quick-crypto's API is async,
    // ICryptoInterface is sync); confirm the methods are the pure-JS ones.
    expect(quickCryptoNoise.generateX25519KeyPair).toBe(
      pureJsCrypto.generateX25519KeyPair,
    );
    expect(quickCryptoNoise.generateX25519SharedKey).toBe(
      pureJsCrypto.generateX25519SharedKey,
    );
  });
});
