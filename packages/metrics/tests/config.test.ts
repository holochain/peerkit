import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { metrics } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "vitest";
import { initMetrics, shutdownMetrics } from "../src/index.js";

const makeReader = () => {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  return { exporter, reader };
};

describe("initMetrics", () => {
  afterEach(async () => {
    await shutdownMetrics();
  });

  test("records a counter that the configured reader observes", async () => {
    const { exporter, reader } = makeReader();
    await initMetrics({ serviceName: "test-service", reader });

    const counter = metrics.getMeter("test").createCounter("test.counter");
    counter.add(7, { kind: "unit" });

    await reader.forceFlush();
    const collected = exporter.getMetrics();
    const found = collected
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === "test.counter");
    expect(found).toBeDefined();
    expect(found?.dataPoints[0]?.value).toBe(7);
  });

  test("calling initMetrics twice without shutdown rejects", async () => {
    const { reader: r1 } = makeReader();
    const { reader: r2 } = makeReader();
    await initMetrics({ serviceName: "svc", reader: r1 });
    await expect(
      initMetrics({ serviceName: "svc", reader: r2 }),
    ).rejects.toThrow(/already initialised/i);
  });

  test("shutdownMetrics reverts the global provider to the OTel no-op", async () => {
    const { reader } = makeReader();
    await initMetrics({ serviceName: "svc", reader });
    const beforeProvider = metrics.getMeterProvider();
    await shutdownMetrics();
    const afterProvider = metrics.getMeterProvider();
    expect(afterProvider).not.toBe(beforeProvider);
  });

  test("shutdownMetrics is safe to call when not initialised", async () => {
    await expect(shutdownMetrics()).resolves.toBeUndefined();
  });
});
