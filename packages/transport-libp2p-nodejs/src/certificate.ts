import "reflect-metadata";

import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import type { TransportCertificate } from "@libp2p/webrtc";
import type { RelayCertificate } from "@peerkit/api";
import { base64url } from "multiformats/bases/base64";
import { sha256 } from "multiformats/hashes/sha2";

const ONE_DAY_MS = 86_400_000;
const CERT_VALIDITY_DAYS = 14;

/**
 * Resolve the WebCrypto provider x509 will use to sign and export keys, and
 * generate the keypair with that same provider.
 *
 * x509's provider is a process-global singleton: `@libp2p/webrtc` sets it to
 * its own `@peculiar/webcrypto` instance, so a key minted by a different
 * provider trips x509's internal `instanceof CryptoKey` checks. Reading the
 * active provider — falling back to Node's native WebCrypto when none is set —
 * keeps the keypair and the provider on one CryptoKey implementation.
 */
function resolveCrypto(): Crypto {
  try {
    return x509.cryptoProvider.get();
  } catch {
    x509.cryptoProvider.set(webcrypto as unknown as Crypto);
    return x509.cryptoProvider.get();
  }
}

/**
 * Generate a fresh self-signed ECDSA P-256 certificate for a relay's WebRTC
 * Direct listener.
 *
 * A new keypair — and therefore a new certhash — is produced on every call.
 * Persist the result and pass it to `createRelay` (or the relay builder) so the
 * relay advertises a stable certhash across restarts.
 */
export async function generateRelayCertificate(): Promise<RelayCertificate> {
  // WebRTC Direct requires ECDSA on the P-256 curve.
  const crypto = resolveCrypto();
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const notBefore = new Date();
  notBefore.setMilliseconds(0);
  const notAfter = new Date(
    notBefore.getTime() + CERT_VALIDITY_DAYS * ONE_DAY_MS,
  );
  notAfter.setMilliseconds(0);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    // Serial uniqueness is satisfied by the fresh keypair per call, not this value.
    serialNumber: "01",
    name: "CN=peerkit-relay",
    notBefore,
    notAfter,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keyPair,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const certhash = base64url.encode(
    (await sha256.digest(new Uint8Array(cert.rawData))).bytes,
  );
  return {
    privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
    certificatePem: cert.toString("pem"),
    certhash,
  };
}

/** Map a peerkit {@link RelayCertificate} onto the libp2p WebRTC transport shape. */
export function toTransportCertificate(
  certificate: RelayCertificate,
): TransportCertificate {
  return {
    privateKey: certificate.privateKeyPem,
    pem: certificate.certificatePem,
    certhash: certificate.certhash,
  };
}
