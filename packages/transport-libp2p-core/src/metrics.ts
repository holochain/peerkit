import { metrics, type Attributes, type Counter } from "@opentelemetry/api";

export const SCOPE_NAME = "@peerkit/transport-libp2p-core";
export const SCOPE_VERSION = "0.1.0";

/**
 * Attribute set attached to every `peerkit.transport.bytes` data point.
 *
 * Extends OpenTelemetry's open-ended {@link Attributes} bag to also accept
 * arbitrary extra keys, but enforces the attributes that downstream
 * dashboards and aggregations rely on.
 */
export interface BytesAttributes extends Attributes {
  /**
   * Whether the bytes were transmitted to or received from the remote peer.
   *
   * - `"sent"` — bytes written by this node into a peerkit message stream.
   * - `"received"` — bytes delivered to this node from a peerkit message stream.
   */
  direction: "sent" | "received";
}

/**
 * Metric instruments owned by the libp2p transport.
 *
 * Instances are built lazily in {@link createTransportMetrics} so the global
 * `MeterProvider` registered by the application (e.g. via `@peerkit/metrics`'s
 * `initMetrics`) is in effect at construction time. The OpenTelemetry JS
 * metrics API (1.9) has no proxy meter provider, so an instrument captured
 * before the global provider is set binds permanently to the no-op meter.
 */
export interface TransportMetrics {
  /**
   * Counter of application-message bytes that flow through the
   * `/peerkit/message/v1` protocol, labelled by direction.
   *
   * Unit: bytes (`By`). Increments once per successful `send()` call on the
   * outbound side, and once per decoded message on the inbound side.
   */
  bytesTotal: Counter<BytesAttributes>;
}

/**
 * Build the transport's metric instruments.
 *
 * Must be called after the application has registered a global
 * `MeterProvider` (e.g. via `@peerkit/metrics`'s `initMetrics`) — instruments
 * created before that bind permanently to the no-op meter.
 */
export function createTransportMetrics(): TransportMetrics {
  const meter = metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  return {
    bytesTotal: meter.createCounter<BytesAttributes>(
      "peerkit.transport.bytes",
      {
        description:
          "Bytes sent or received over the peerkit message protocol, by direction",
        unit: "By",
      },
    ),
  };
}
