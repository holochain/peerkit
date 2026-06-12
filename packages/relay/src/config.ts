/**
 * @fileoverview Resolved relay configuration. Pure data; no I/O.
 */

import type {
  NetworkAccessBytes,
  NetworkAccessHandler,
  RelayCertificate,
  RelayListenAddress,
} from "@peerkit/api";

export interface OtelConfig {
  readonly otlpEndpoint: string;
  readonly exportIntervalMs?: number;
  readonly headers?: Record<string, string>;
  readonly serviceVersion: string;
}

export interface RelayConfig {
  readonly id: string;
  readonly logLevel: string;
  readonly listenAddrs: readonly RelayListenAddress[];
  readonly networkAccessBytes: NetworkAccessBytes;
  readonly networkAccessHandler: NetworkAccessHandler;
  readonly otel?: OtelConfig;
  readonly publicIp?: string;
  /*
   * Certificate for the relay's secure listener. When omitted, an ephemeral
   * one is generated at start and the certificate hash changes on every
   * restart. Since the certificate hash is part of the relay address, supply a
   * persisted certificate to keep dialable addresses stable.
   */
  readonly certificate?: RelayCertificate;
}
