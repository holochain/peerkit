import { describe, expect, test, vi } from "vitest";

// The polyfill entry is a single side-effecting module: importing it must
// install the JSI crypto and WebRTC globals in a documented order (RNG first,
// then quick-crypto's `install()`, then WebRTC `registerGlobals()`). The three
// React Native native modules do not exist in a Node test environment, so they
// are mocked with spies that also record the order in which they run.
//
// `vi.hoisted` lifts the shared recorder above the hoisted `vi.mock` factories
// so every mock can push into the same array.
const calls = vi.hoisted(() => [] as string[]);

vi.mock("react-native-get-random-values", () => {
  // A bare side-effect import; the recording happens at module-evaluation time,
  // which is exactly when `import "react-native-get-random-values"` runs.
  calls.push("get-random-values");
  return {};
});

vi.mock("react-native-quick-crypto", () => ({
  install: vi.fn(() => calls.push("install-quick-crypto")),
}));

vi.mock("react-native-webrtc", () => ({
  registerGlobals: vi.fn(() => calls.push("register-webrtc-globals")),
}));

// `react-native`'s real entry is a Flow source the test bundler cannot parse, and
// its native modules do not exist under Node. The datachannel polyfill only reads
// `NativeModules.WebRTCModule` (absent here, so it no-ops); an empty `NativeModules`
// is enough to keep that guard from throwing.
vi.mock("react-native", () => ({
  NativeModules: {},
  NativeEventEmitter: class {},
}));

describe("polyfills entry", () => {
  test("installs RNG, quick-crypto, and WebRTC globals in order", async () => {
    // Importing the module triggers all side effects exactly once.
    await import("../src/polyfills.js");

    // The order is load-bearing: RNG must be patched before anything generates
    // key material, and the JSI crypto must be installed before WebRTC.
    expect(calls).toEqual([
      "get-random-values",
      "install-quick-crypto",
      "register-webrtc-globals",
    ]);
  });

  test("exposes Buffer and process on the global scope", async () => {
    // libp2p dependencies reach for `globalThis.Buffer` / `globalThis.process`
    // as ambient globals rather than ES imports; the entry must guarantee both
    // are present after it runs.
    await import("../src/polyfills.js");

    const scope = globalThis as {
      Buffer?: unknown;
      process?: { nextTick?: unknown };
    };
    expect(scope.Buffer).toBeDefined();
    expect(scope.process).toBeDefined();
    expect(typeof scope.process?.nextTick).toBe("function");
  });
});
