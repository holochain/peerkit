/**
 * @fileoverview Entry point. Wires CLI -> logger -> metrics ->
 * agent store -> relay -> HTTP server. Handles signals + shutdown.
 */

import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_RELAY_ID,
  type RelayConfig,
} from "./config.js";
import { createLogger } from "./logger.js";
import {
  initRelayMetrics,
  setAgentCountProvider,
  shutdownRelayMetrics,
} from "./metrics.js";
import { MemoryAgentStore } from "@peerkit/agent-store";
import { startRelay } from "./relay.js";

// Public API surface: callers construct a RelayConfig and either drive the
// full lifecycle with `run`, or embed a relay with `startRelay`.
export type { RelayConfig, OtelConfig } from "./config.js";
export { startRelay } from "./relay.js";
export type { RunningRelay, StartRelayDeps } from "./relay.js";
export {
  initRelayMetrics,
  shutdownRelayMetrics,
  setAgentCountProvider,
  type InitRelayMetricsOptions,
} from "./metrics.js";
export { createLogger, type Logger, type LoggerOptions } from "./logger.js";
// Re-exported so callers can persist a stable TLS certificate and
// feed it back through RelayConfig.certificate without depending on the
// transport package directly.
export type { RelayCertificate } from "@peerkit/api";
export { generateRelayCertificate } from "@peerkit/peerkit";

export async function run(config: RelayConfig): Promise<void> {
  const id = config.id ?? DEFAULT_RELAY_ID;
  const logLevel = config.logLevel ?? DEFAULT_LOG_LEVEL;
  const logger = createLogger({ level: logLevel, id });
  logger.info("starting relay", {
    logLevel,
    listenAddrs: config.listenAddrs,
    publicIp: config.publicIp,
    otelEnabled: config.otel !== undefined,
  });

  let metricsInitialized = false;
  let agentStore: MemoryAgentStore | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;

  try {
    logger.info("initializing metrics", {
      otelEnabled: config.otel !== undefined,
      otlpEndpoint: config.otel?.otlpEndpoint,
      exportIntervalMs: config.otel?.exportIntervalMs,
    });
    await initRelayMetrics({
      enabled: config.otel !== undefined,
      relayId: id,
      otlpEndpoint: config.otel?.otlpEndpoint,
      exportIntervalMs: config.otel?.exportIntervalMs,
      headers: config.otel?.headers,
      serviceVersion: config.otel?.serviceVersion ?? "unknown",
    });
    metricsInitialized = true;
    logger.info("metrics initialized");

    logger.info("creating agent store");
    // MemoryAgentStore evicts purely by each record's own expiresAt; the
    // relay imposes no TTL or entry cap of its own.
    agentStore = new MemoryAgentStore();
    setAgentCountProvider(() => agentStore?.getAll().length ?? 0);

    logger.info("starting relay", { listenAddrs: config.listenAddrs });
    relay = await startRelay(config, { logger, agentStore });
    logger.info("relay started", { nodeId: relay.nodeId });

    const startedAt = new Date().toISOString();
    const startedRelay = relay;

    logger.info("relay ready", {
      nodeId: startedRelay.nodeId,
      multiaddrs: startedRelay.transport.getListenAddresses(),
      startedAt,
    });
  } catch (error: unknown) {
    logger.error("startup failed, rolling back initialized resources", {
      err: { message: error instanceof Error ? error.message : String(error) },
    });
    await rollback({
      logger,
      relay,
      agentStore,
      metricsInitialized,
    });
    throw error;
  }

  // All three must be defined here: the try block either assigns them
  // all or rethrows. Narrow for the closure below.
  if (relay === undefined || agentStore === undefined) {
    throw new Error("internal: post-startup resources missing");
  }
  const startedRelay = relay;
  const startedStore = agentStore;

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn("shutdown already in progress, ignoring signal", { signal });
      return;
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });

    const errors: unknown[] = [];

    logger.info("shutting down relay");
    try {
      await startedRelay.shutdown();
      logger.info("relay shut down");
    } catch (err: unknown) {
      errors.push(err);
      logger.error("failed shutting down relay", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    logger.info("disposing agent store");
    try {
      startedStore.destroy();
    } catch (err: unknown) {
      errors.push(err);
      logger.error("failed disposing agent store", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    logger.info("shutting down metrics");
    try {
      await shutdownRelayMetrics();
    } catch (err: unknown) {
      errors.push(err);
      logger.error("failed shutting down metrics", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    logger.info("shutdown complete, exiting", { errorCount: errors.length });
    process.exit(errors.length === 0 ? 0 : 1);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

interface RollbackArgs {
  readonly logger: ReturnType<typeof createLogger>;
  readonly relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  readonly agentStore: MemoryAgentStore | undefined;
  readonly metricsInitialized: boolean;
}

async function rollback(args: RollbackArgs): Promise<void> {
  const { logger, relay, agentStore, metricsInitialized } = args;

  if (relay !== undefined) {
    try {
      await relay.shutdown();
    } catch (err: unknown) {
      logger.error("rollback: failed shutting down relay", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  if (agentStore !== undefined) {
    try {
      agentStore.destroy();
    } catch (err: unknown) {
      logger.error("rollback: failed disposing agent store", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  if (metricsInitialized) {
    try {
      await shutdownRelayMetrics();
    } catch (err: unknown) {
      logger.error("rollback: failed shutting down metrics", {
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
