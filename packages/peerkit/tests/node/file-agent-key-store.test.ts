import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentKeyStore } from "../../src/node/file-agent-key-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "peerkit-keystore-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A store pointed at a non-existent file reports "no identity yet" so the
// caller knows to generate one, rather than throwing.
test("loadKey returns undefined when the file does not exist", async () => {
  const store = new FileAgentKeyStore(join(dir, "missing", "identity.key"));
  expect(await store.loadKey()).toBeUndefined();
});

// Storing then loading the same key yields identical bytes, and the parent
// directory is created on demand.
test("storeKey then loadKey round-trips the key bytes", async () => {
  const path = join(dir, "nested", "identity.key");
  const store = new FileAgentKeyStore(path);
  const key = new Uint8Array([1, 2, 3, 4]);

  await store.storeKey(key);

  expect(await store.loadKey()).toEqual(key);
});

// The key is a secret, so it must land on disk owner-only (0600).
// POSIX permission bits do not apply on Windows, so this is skipped there.
test.skipIf(process.platform === "win32")(
  "storeKey writes the key with 0600 permissions",
  async () => {
    const path = join(dir, "identity.key");
    const store = new FileAgentKeyStore(path);

    await store.storeKey(new Uint8Array([1, 2, 3, 4]));

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  },
);

// A key file that other users can read is untrusted: loadKey refuses it
// instead of silently using a possibly-leaked secret. POSIX permission bits do
// not apply on Windows, so this is skipped there.
test.skipIf(process.platform === "win32")(
  "loadKey throws when the key file is group/other accessible",
  async () => {
    const path = join(dir, "identity.key");
    const store = new FileAgentKeyStore(path);
    await store.storeKey(new Uint8Array([1, 2, 3, 4]));
    // Widen permissions behind the store's back to simulate a tampered file.
    await chmod(path, 0o644);

    await expect(store.loadKey()).rejects.toThrow(/too open/);
  },
);
