import { assert, expect, test } from "vitest";
import { xorHashes } from "../src/pull.js";

test("Empty set yields all zeroes", () => {
  assert.deepEqual(xorHashes([]), new Uint8Array(new Array(32).fill(0)));
});

test("Hash with wrong size throws", () => {
  expect(() => xorHashes([new Uint8Array(2)])).toThrow(/Expected 32-byte hash/);
});

test("Single non-zero hash yields identical hash", () => {
  const hash = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5,
    6, 7, 8, 9, 0, 1, 2,
  ]);
  assert.deepEqual(xorHashes([hash]), hash);
});

test("Arbitrary byte values are xored correctly", () => {
  // 0b10101010 ^ 0b11001100 = 0b01100110
  const hash1 = new Uint8Array(32).fill(0b10101010);
  const hash2 = new Uint8Array(32).fill(0b11001100);
  assert.deepEqual(
    xorHashes([hash1, hash2]),
    new Uint8Array(32).fill(0b01100110),
  );
});

test("Two identical non-zero hashes yield all zeroes", () => {
  const hash = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  ]);
  assert.deepEqual(xorHashes([hash, hash]), new Uint8Array(32).fill(0));
});

test("Hash with all ones and hash with all zeroes yield all ones", () => {
  const hash1 = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
  ]);
  const hash2 = new Uint8Array([
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1,
  ]);
  assert.deepEqual(
    xorHashes([hash1, hash2]),
    new Uint8Array(new Array(32).fill(1)),
  );
});

test("Three hashes with mixed zeroes and ones yield correct xored values", () => {
  const hash1 = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1,
  ]);
  const hash2 = new Uint8Array([
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    0, 0, 0, 0, 0, 0, 0,
  ]);
  const hash3 = new Uint8Array([
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1,
  ]);
  assert.deepEqual(
    xorHashes([hash1, hash2, hash3]),
    new Uint8Array(new Array(32).fill(0)),
  );
});
