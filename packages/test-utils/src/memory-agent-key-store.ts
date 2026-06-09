import type { IAgentKeyStore } from "@peerkit/api";

/**
 * In-memory {@link IAgentKeyStore} for tests. Holds the private key in memory
 * for the lifetime of the instance only; nothing is persisted.
 */
export class MemoryAgentKeyStore implements IAgentKeyStore {
  private privateKey: Uint8Array | undefined;

  constructor(privateKey?: Uint8Array) {
    this.privateKey = privateKey;
  }

  loadKey(): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.privateKey);
  }

  storeKey(privateKey: Uint8Array): Promise<void> {
    this.privateKey = privateKey;
    return Promise.resolve();
  }
}
