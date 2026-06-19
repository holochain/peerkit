/**
 * @fileoverview OpenTelemetry metrics bootstrap for the relay.
 *
 * Wraps @peerkit/metrics initMetrics so it runs before any peerkit
 * transport is constructed (transport binds instruments at construction
 * time; instruments created before the global MeterProvider is set
 * bind permanently to the no-op meter).
 */

import {
  metrics,
  type Attributes,
  type Counter,
  type ObservableGauge,
  type UpDownCounter,
} from "@opentelemetry/api";
import { initMetrics, shutdownMetrics } from "@peerkit/metrics";

/** OpenTelemetry instrumentation scope owned by this package. */
export const SCOPE_NAME = "@peerkit/relay";
export const SCOPE_VERSION = "0.1.0-alpha.14";

/**
 * Attribute set attached to every `peerkit.relay.access.checks` data point.
 *
 * Extends OpenTelemetry's open-ended {@link Attributes} bag but enforces the
 * `result` dimension that access-rate dashboards rely on.
 */
export interface AccessChecksAttributes extends Attributes {
  /** Outcome of the network-access handshake: granted or denied. */
  result: "granted" | "denied";
}

/** Options passed to {@link initRelayMetrics}. */
export interface InitRelayMetricsOptions {
  readonly enabled: boolean;
  readonly exportIntervalMs?: number;
  readonly headers?: Record<string, string>;
  readonly otlpEndpoint?: string;
  readonly relayId: string;
  readonly serviceVersion: string;
}

interface RelayInstruments {
  accessChecks: Counter<AccessChecksAttributes>;
  peersConnected: UpDownCounter;
  agentsStored: ObservableGauge;
  agentsReceived: Counter;
  agentsReplays: Counter;
}

let instruments: RelayInstruments | undefined;

/**
 * Late-bound source for the stored-agents gauge. The agent store is created
 * after metrics are initialized, so {@link initRelayMetrics} registers an
 * observable callback that reads through this provider on each collection.
 */
let agentCountProvider: (() => number) | undefined;

/**
 * Register the function the stored-agents gauge reads on each collection.
 * Pass `undefined` to detach (e.g. on shutdown).
 */
export function setAgentCountProvider(provider?: () => number): void {
  agentCountProvider = provider;
}

/**
 * Initialize the global MeterProvider and bind relay instruments.
 *
 * Must be called before constructing any peerkit transport so that the
 * instruments are bound to a real meter rather than the no-op meter.
 */
export async function initRelayMetrics(
  options: InitRelayMetricsOptions,
): Promise<void> {
  if (options.enabled) {
    await initMetrics({
      serviceName: options.relayId,
      serviceVersion: options.serviceVersion,
      otlpEndpoint: options.otlpEndpoint,
      exportIntervalMillis: options.exportIntervalMs,
      headers: options.headers,
    });
  }
  const meter = metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  const agentsStored = meter.createObservableGauge(
    "peerkit.relay.agents.stored",
    {
      description: "Agent-info records currently held in the relay's store",
      unit: "{agent}",
    },
  );
  agentsStored.addCallback((result) => {
    result.observe(agentCountProvider?.() ?? 0);
  });
  instruments = {
    accessChecks: meter.createCounter<AccessChecksAttributes>(
      "peerkit.relay.access.checks",
      {
        description: "Network-access handshake outcomes, by result",
        unit: "{check}",
      },
    ),
    peersConnected: meter.createUpDownCounter("peerkit.relay.peers.connected", {
      description: "Peers currently connected to the relay",
      unit: "{peer}",
    }),
    agentsStored,
    agentsReceived: meter.createCounter("peerkit.relay.agents.received", {
      description:
        "Verified agent-info records received from peers, counted on every " +
        "receipt. Not deduplicated: a record re-sent on a later bootstrap " +
        "exchange is counted again, so this measures inbound agent-info " +
        "throughput rather than the count of distinct agents known.",
      unit: "{agent}",
    }),
    agentsReplays: meter.createCounter("peerkit.relay.agents.replays", {
      description: "Agent-info entries replayed to connecting peers",
      unit: "{agent}",
    }),
  };
}

/**
 * Flush and shut down the global MeterProvider, then clear cached
 * instruments.
 */
export async function shutdownRelayMetrics(): Promise<void> {
  instruments = undefined;
  agentCountProvider = undefined;
  await shutdownMetrics();
}

/** Record one access check outcome. */
export function recordAccess(granted: boolean): void {
  instruments?.accessChecks.add(1, { result: granted ? "granted" : "denied" });
}

/** Increment the connected-peers gauge. */
export function recordPeerConnected(): void {
  instruments?.peersConnected.add(1);
}

/** Decrement the connected-peers gauge. */
export function recordPeerDisconnected(): void {
  instruments?.peersConnected.add(-1);
}

/**
 * Record that `count` verified agent-info records were received in a single
 * exchange. Call this once per inbound agent-info message with the number of
 * records that passed signature verification — including records for agents
 * already in the store. The counter is a throughput measure, not a distinct
 * count, so re-sends on repeated bootstrap exchanges are expected to add to it.
 */
export function recordAgentsReceived(count: number): void {
  instruments?.agentsReceived.add(count);
}

/** Record that `count` agent-info entries were replayed to a peer. */
export function recordAgentsReplayed(count: number): void {
  instruments?.agentsReplays.add(count);
}
