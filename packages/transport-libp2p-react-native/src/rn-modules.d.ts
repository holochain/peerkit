// Ambient module declarations for React Native-only packages that ship without
// TypeScript types or are not resolvable in the workspace's host toolchain.
// Real implementations are pulled in by Metro at app build time; here we only
// need enough surface to let `tsc` type-check `polyfills.ts`.

declare module "react-native-get-random-values";

declare module "react-native-quick-crypto" {
  export function install(): void;

  type BinaryLike = Uint8Array;

  export interface Hash {
    update(data: BinaryLike): Hash;
    digest(): Uint8Array;
  }

  export interface Hmac {
    update(data: BinaryLike): Hmac;
    digest(): Uint8Array;
  }

  export interface CipherOptions {
    authTagLength?: number;
  }

  export interface Cipher {
    setAAD(buffer: BinaryLike): Cipher;
    update(data: BinaryLike): Uint8Array;
    final(): Uint8Array;
    getAuthTag(): Uint8Array;
  }

  export interface Decipher {
    setAAD(buffer: BinaryLike): Decipher;
    setAuthTag(tag: BinaryLike): Decipher;
    update(data: BinaryLike): Uint8Array;
    final(): Uint8Array;
  }

  export function createHash(algorithm: "sha256"): Hash;
  export function createHmac(algorithm: "sha256", key: BinaryLike): Hmac;
  export function createCipheriv(
    algorithm: "chacha20-poly1305",
    key: BinaryLike,
    iv: BinaryLike,
    options?: CipherOptions,
  ): Cipher;
  export function createDecipheriv(
    algorithm: "chacha20-poly1305",
    key: BinaryLike,
    iv: BinaryLike,
    options?: CipherOptions,
  ): Decipher;

  const QuickCrypto: {
    install: typeof install;
    createHash: typeof createHash;
    createHmac: typeof createHmac;
    createCipheriv: typeof createCipheriv;
    createDecipheriv: typeof createDecipheriv;
  };
  export default QuickCrypto;
}

declare module "react-native-webrtc" {
  export function registerGlobals(): void;
}

declare module "buffer" {
  export const Buffer: {
    from(...args: readonly unknown[]): unknown;
    alloc(...args: readonly unknown[]): unknown;
    isBuffer(value: unknown): boolean;
  };
}

declare module "process" {
  const process: {
    nextTick(callback: () => void): void;
    env: Record<string, string | undefined>;
  };
  export default process;
}
