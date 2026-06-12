import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { installWebRtcCertificatePolyfill } from "../src/webrtc-certificate-polyfill.js";

// The polyfill patches the global `RTCPeerConnection`, so each test swaps in a
// stand-in constructor and restores the original afterwards.
const mutableGlobal = globalThis as unknown as { RTCPeerConnection?: unknown };

let saved: unknown;

beforeEach(() => {
  saved = mutableGlobal.RTCPeerConnection;
});

afterEach(() => {
  if (saved === undefined) {
    delete mutableGlobal.RTCPeerConnection;
  } else {
    mutableGlobal.RTCPeerConnection = saved;
  }
});

interface CertificateProvider {
  generateCertificate?: (algorithm?: unknown) => Promise<unknown>;
}

describe("installWebRtcCertificatePolyfill", () => {
  test("adds a static generateCertificate that resolves to a serializable value", async () => {
    class FakeRTCPeerConnection {}
    mutableGlobal.RTCPeerConnection = FakeRTCPeerConnection;

    installWebRtcCertificatePolyfill();

    const provider = FakeRTCPeerConnection as CertificateProvider;
    expect(typeof provider.generateCertificate).toBe("function");

    const certificate = await provider.generateCertificate?.({
      name: "ECDSA",
      namedCurve: "P-256",
    });
    // libp2p forwards this straight into `new RTCPeerConnection({ certificates })`,
    // which crosses the native bridge, so it must be a plain serializable object.
    expect(JSON.stringify(certificate)).toEqual(expect.any(String));
  });

  test("does not overwrite an existing generateCertificate implementation", () => {
    const existing = (): Promise<unknown> => Promise.resolve("real");
    class FakeRTCPeerConnection {
      static generateCertificate = existing;
    }
    mutableGlobal.RTCPeerConnection = FakeRTCPeerConnection;

    installWebRtcCertificatePolyfill();

    expect(FakeRTCPeerConnection.generateCertificate).toBe(existing);
  });

  test("is a no-op when the runtime provides no RTCPeerConnection", () => {
    delete mutableGlobal.RTCPeerConnection;
    expect(() => {
      installWebRtcCertificatePolyfill();
    }).not.toThrow();
  });
});
