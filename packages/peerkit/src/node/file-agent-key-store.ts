import type { IAgentKeyStore } from "@peerkit/api";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * File-backed {@link IAgentKeyStore} for Node.js platforms.
 *
 * Persists the agent's raw Ed25519 private key at a single path so the node
 * keeps a stable identity across restarts. The key is a secret: it is written
 * with owner-only (`0600`) permissions, and {@link loadKey} refuses to read a
 * key file that any group or other user can access.
 *
 */
export class FileAgentKeyStore implements IAgentKeyStore {
  constructor(private readonly path: string) {}

  async loadKey(): Promise<Uint8Array | undefined> {
    let mode: number;
    try {
      mode = (await stat(this.path)).mode;
    } catch (error: unknown) {
      // A missing file means "no identity yet"; the caller generates one.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    // The key is a secret: refuse to use it if anyone but the owner can read it.
    // POSIX permission bits are meaningless on Windows (chmod only toggles the
    // read-only flag there), so the owner-only check is skipped on that platform.
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to load key from ${this.path}: permissions ${(mode & 0o777)
          .toString(8)
          .padStart(3, "0")} are too open, expected 600`,
      );
    }

    return new Uint8Array(await readFile(this.path));
  }

  async storeKey(privateKey: Uint8Array): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, privateKey, { mode: 0o600 });
    // `mode` only applies when writeFile creates the file; chmod also tightens
    // an existing key file so the secret stays owner-only.
    await chmod(this.path, 0o600);
  }
}
