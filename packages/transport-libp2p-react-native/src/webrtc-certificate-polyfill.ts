/**
 * Give React Native's `RTCPeerConnection` the static `generateCertificate`
 * method that `@libp2p/webrtc`'s webrtc-direct dialer requires.
 *
 * Metro selects the browser build of `@libp2p/webrtc` on React Native. Its
 * dialer creates the peer connection like this:
 *
 * ```js
 * const certificate = await RTCPeerConnection.generateCertificate({
 *   name: "ECDSA",
 *   namedCurve: "P-256",
 * });
 * new RTCPeerConnection({ certificates: [certificate] });
 * ```
 *
 * `react-native-webrtc` (v124) implements neither the static
 * `generateCertificate` method nor the `certificates` constructor option — it
 * always generates its own DTLS certificate natively — so the dialer throws
 * `RTCPeerConnection.generateCertificate is not a function`.
 *
 * Supplying a specific certificate is unnecessary for webrtc-direct. The dialer
 * reads its own fingerprint back out of the generated local SDP
 * (`getFingerprintFromSdp(peerConnection.localDescription.sdp)`) and binds it
 * into the Noise prologue, so the certificate the native layer produces is the
 * one that actually gets authenticated. We only need the call to resolve: the
 * returned value is forwarded as the `certificates` option, which
 * `react-native-webrtc` does not read, so a plain placeholder object that the
 * native bridge can serialize is sufficient.
 */

interface CertificateCapablePeerConnection {
  generateCertificate?: (algorithm?: unknown) => Promise<unknown>;
}

const CERTIFICATE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Install the static `generateCertificate` method on the global
 * `RTCPeerConnection`. Idempotent, and a no-op when the global is absent
 * (`registerGlobals()` has not run, or under tests) or already provides the
 * method (a browser, or a future `react-native-webrtc` release).
 */
export function installWebRtcCertificatePolyfill(): void {
  const scope = globalThis as {
    RTCPeerConnection?: CertificateCapablePeerConnection;
  };
  const peerConnection = scope.RTCPeerConnection;
  if (peerConnection == null) {
    return;
  }
  if (typeof peerConnection.generateCertificate === "function") {
    return;
  }
  peerConnection.generateCertificate = (): Promise<unknown> => {
    // react-native-webrtc generates its own DTLS certificate natively; libp2p
    // reads the resulting fingerprint from the SDP rather than from this
    // object, so a serializable placeholder is enough to satisfy the dialer.
    return Promise.resolve({ expires: Date.now() + CERTIFICATE_TTL_MS });
  };
}
