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

/** Relay id used as a logging/metrics label when {@link RelayConfig.id} is omitted. */
export const DEFAULT_RELAY_ID = "peerkit-relay";

/** Log level applied when {@link RelayConfig.logLevel} is omitted. */
export const DEFAULT_LOG_LEVEL = "info";

export interface RelayConfig {
  /** Logging/metrics label for this relay. Defaults to {@link DEFAULT_RELAY_ID}. */
  readonly id?: string;
  /** Log level. Defaults to {@link DEFAULT_LOG_LEVEL}. */
  readonly logLevel?: string;
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
