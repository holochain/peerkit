/**
 * @fileoverview Resolved relay configuration. Pure data; no I/O.
 */

import type { NetworkAccessBytes, NetworkAccessHandler } from "@peerkit/api";

export interface OtelConfig {
  readonly otlpEndpoint: string;
  readonly exportIntervalMs?: number;
  readonly headers?: Record<string, string>;
  readonly serviceVersion: string;
}

export interface RelayConfig {
  readonly id: string;
  readonly logLevel: string;
  readonly listenAddrs: readonly string[];
  readonly NetworkAccessBytes: NetworkAccessBytes;
  readonly networkAccessHandler: NetworkAccessHandler;
  readonly otel?: OtelConfig;
  readonly publicHost?: string;
}
