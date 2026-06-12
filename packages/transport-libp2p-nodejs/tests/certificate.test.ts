import { describe, expect, test } from "vitest";

import {
  generateRelayCertificate,
  toTransportCertificate,
} from "../src/certificate.js";

// generateRelayCertificate produces a fresh self-signed certificate that the
// caller persists and passes to the relay so its WebRTC Direct certhash stays
// stable across restarts.
describe("generateRelayCertificate", () => {
  test("returns a PEM private key, PEM certificate and a certhash", async () => {
    const cert = await generateRelayCertificate();

    // Private key and certificate are PEM-encoded blocks.
    expect(cert.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(cert.privateKeyPem).toContain("-----END PRIVATE KEY-----");
    expect(cert.certificatePem).toContain("-----BEGIN CERTIFICATE-----");
    expect(cert.certificatePem).toContain("-----END CERTIFICATE-----");
    // certhash is the multibase-encoded multihash WebRTC Direct advertises.
    expect(cert.certhash.length).toBeGreaterThan(0);
  });

  test("produces a fresh certificate (and certhash) on every call", async () => {
    const first = await generateRelayCertificate();
    const second = await generateRelayCertificate();

    expect(first.certhash).not.toBe(second.certhash);
  });
});

// toTransportCertificate maps the peerkit-facing shape onto the field names the
// libp2p WebRTC transport expects, so no libp2p type leaks above the transport.
describe("toTransportCertificate", () => {
  test("maps peerkit fields onto the libp2p TransportCertificate shape", () => {
    const transportCert = toTransportCertificate({
      privateKeyPem: "PK",
      certificatePem: "CERT",
      certhash: "HASH",
    });

    expect(transportCert).toEqual({
      privateKey: "PK",
      pem: "CERT",
      certhash: "HASH",
    });
  });
});
