/**
 * Runtime polyfills required by libp2p when running on React Native (Hermes).
 *
 * Side-effect import from the app entry, **before any other import**:
 *
 * ```ts
 * import "@peerkit/transport-libp2p-react-native/polyfills";
 * ```
 *
 * Order matters:
 *  1. `react-native-get-random-values` — patches `globalThis.crypto.getRandomValues`.
 *     Must run first so anything that touches RNG during module init (peer-id,
 *     noise key generation) observes the JSI implementation.
 *  2. `react-native-quick-crypto` `install()` — installs the JSI-backed
 *     `globalThis.crypto.subtle` (Ed25519, X25519, AES-GCM, ChaCha20-Poly1305,
 *     HMAC, SHA-256) used by `@chainsafe/libp2p-noise`.
 *  3. `react-native-webrtc` `registerGlobals()` — defines the global
 *     `RTCPeerConnection`, `RTCSessionDescription`, etc. used by
 *     `@libp2p/webrtc`.
 *
 * Consumers must also configure Metro to map bare Node imports (`crypto`,
 * `stream`, `buffer`, `events`) to their React Native equivalents and enable
 * `@babel/plugin-transform-private-methods` (loose) so libp2p's ES2022
 * private fields parse under Hermes. See the package README for the full
 * Metro / Babel configuration.
 */

import "react-native-get-random-values";
import { Buffer } from "buffer";
import process from "process";
import { install as installQuickCrypto } from "react-native-quick-crypto";
import { registerGlobals as registerWebRtcGlobals } from "react-native-webrtc";

// Buffer + process must live on globalThis: some libp2p dependencies reach for these as globals
// rather than as ES module imports. Metro's `extraNodeModules` only rewrites
// bare imports — code that touches `globalThis.Buffer` or
// `globalThis.process.nextTick` directly relies on this assignment.
const globalScope = globalThis as {
  Buffer?: typeof Buffer;
  process?: typeof process;
};
globalScope.Buffer ??= Buffer;
globalScope.process ??= process;

installQuickCrypto();
registerWebRtcGlobals();
