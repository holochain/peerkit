import type { ITransport } from "@peerkit/api";
import type { CreateRelayOptions } from "@peerkit/transport-libp2p";
import { expect, test, vi } from "vitest";

import { PeerkitRelayBuilder } from "../src/relay.js";

// A minimal stub transport: build() only reads getNodeId/shutDown, and the
// injected factory lets us capture the options the builder forwards.
function stubTransport(): ITransport {
  return {
    getNodeId: () => "stub-node",
    shutDown: vi.fn(async () => {}),
  } as unknown as ITransport;
}

// withCertificate forwards the caller-supplied certificate to the relay
// transport so its WebRTC Direct certhash stays stable across restarts.
test("build() forwards the certificate to the transport factory", async () => {
  let captured: CreateRelayOptions | undefined;
  const certificate = {
    privateKeyPem: "PK",
    certificatePem: "CERT",
    certhash: "HASH",
  };

  await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withCertificate(certificate)
    .withTransportFactory(async (options) => {
      captured = options;
      return stubTransport();
    })
    .build();

  expect(captured?.certificate).toEqual(certificate);
});

// Without withCertificate, no certificate is forwarded and libp2p falls back to
// generating an ephemeral one at start.
test("build() forwards no certificate when none is configured", async () => {
  let captured: CreateRelayOptions | undefined;

  await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withTransportFactory(async (options) => {
      captured = options;
      return stubTransport();
    })
    .build();

  expect(captured?.certificate).toBeUndefined();
});
