/**
 * `ICryptoInterface` implementation backed by `react-native-quick-crypto`,
 * intended to be passed to `noise({ crypto: quickCryptoNoise })` on React
 * Native. JSI-backed primitives are noticeably faster than the pure-JS Noise
 * defaults on Hermes, which matters for handshake latency and bulk transfer.
 *
 * Only the primitives that have a usable synchronous quick-crypto mapping are
 * overridden:
 *
 *  - `hashSHA256` — `createHash('sha256')`
 *  - `getHKDF` — RFC 5869 HKDF built on `createHmac('sha256', ...)`
 *  - `chaCha20Poly1305Encrypt` / `chaCha20Poly1305Decrypt` —
 *    `createCipheriv` / `createDecipheriv` with the `chacha20-poly1305`
 *    AEAD, 16-byte authentication tag appended to / split from the
 *    ciphertext per the Noise specification.
 *
 * X25519 key generation and shared-secret derivation are delegated to
 * `pureJsCrypto` because the quick-crypto X25519 API is asynchronous
 * (subtle-style) whereas `ICryptoInterface` requires synchronous methods.
 * The pure-JS X25519 implementation is fast enough that JSI offers little
 * practical gain.
 *
 * This module pulls in `react-native-quick-crypto` at import time and must
 * therefore only be imported in a React Native bundle. It is exposed via the
 * dedicated `./quick-crypto-noise` subexport so the package's main entry
 * remains free of React Native-only side effects.
 */

import { pureJsCrypto, type ICryptoInterface } from "@chainsafe/libp2p-noise";
import QuickCrypto from "react-native-quick-crypto";
import type { Uint8ArrayList } from "uint8arraylist";

const TAG_LENGTH = 16;

function toBytes(data: Uint8Array | Uint8ArrayList): Uint8Array {
  // `Uint8ArrayList.subarray()` returns a contiguous Uint8Array view, which
  // is what quick-crypto's Node-compatible API expects.
  return data instanceof Uint8Array ? data : data.subarray();
}

function hashSHA256(data: Uint8Array | Uint8ArrayList): Uint8Array {
  return QuickCrypto.createHash("sha256").update(toBytes(data)).digest();
}

function hmacSHA256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return QuickCrypto.createHmac("sha256", key).update(data).digest();
}

function getHKDF(
  ck: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array, Uint8Array] {
  // RFC 5869 HKDF with SHA-256, three 32-byte outputs as required by the
  // Noise specification. Extract step: PRK = HMAC(ck, ikm). Expand step:
  // outN = HMAC(PRK, outN-1 || counter), starting from an empty previous
  // block.
  const prk = hmacSHA256(ck, ikm);
  const out1 = hmacSHA256(prk, new Uint8Array([0x01]));

  const out2Input = new Uint8Array(out1.length + 1);
  out2Input.set(out1, 0);
  out2Input[out1.length] = 0x02;
  const out2 = hmacSHA256(prk, out2Input);

  const out3Input = new Uint8Array(out2.length + 1);
  out3Input.set(out2, 0);
  out3Input[out2.length] = 0x03;
  const out3 = hmacSHA256(prk, out3Input);

  return [out1, out2, out3];
}

function chaCha20Poly1305Encrypt(
  plaintext: Uint8Array | Uint8ArrayList,
  nonce: Uint8Array,
  ad: Uint8Array,
  k: Uint8Array,
): Uint8Array {
  const cipher = QuickCrypto.createCipheriv("chacha20-poly1305", k, nonce, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(ad);
  const head = cipher.update(toBytes(plaintext));
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  // Noise wire format: ciphertext || tag (16 bytes).
  const out = new Uint8Array(head.length + tail.length + tag.length);
  out.set(head, 0);
  out.set(tail, head.length);
  out.set(tag, head.length + tail.length);
  return out;
}

function chaCha20Poly1305Decrypt(
  ciphertext: Uint8Array | Uint8ArrayList,
  nonce: Uint8Array,
  ad: Uint8Array,
  k: Uint8Array,
): Uint8Array {
  const bytes = toBytes(ciphertext);
  if (bytes.length < TAG_LENGTH) {
    throw new Error("ChaCha20-Poly1305 ciphertext shorter than tag length");
  }
  const ct = bytes.subarray(0, bytes.length - TAG_LENGTH);
  const tag = bytes.subarray(bytes.length - TAG_LENGTH);
  const decipher = QuickCrypto.createDecipheriv("chacha20-poly1305", k, nonce, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  const head = decipher.update(ct);
  const tail = decipher.final();
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/**
 * Quick-crypto-backed Noise crypto. Inherits synchronous X25519 operations
 * from `pureJsCrypto`; overrides SHA-256, HKDF, and ChaCha20-Poly1305 with
 * JSI-backed implementations.
 */
export const quickCryptoNoise: ICryptoInterface = {
  ...pureJsCrypto,
  hashSHA256,
  getHKDF,
  chaCha20Poly1305Encrypt,
  chaCha20Poly1305Decrypt,
};
