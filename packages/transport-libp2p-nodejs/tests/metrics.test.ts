import { reset } from "@logtape/logtape";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type SumMetricData,
} from "@opentelemetry/sdk-metrics";
import { initMetrics, shutdownMetrics } from "@peerkit/metrics";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MessageHandler } from "@peerkit/api";
import { createNode, setupTestLogger } from "./util.js";

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;

beforeEach(async () => {
  await setupTestLogger();
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  await initMetrics({ serviceName: "transport-libp2p-test", reader });
});

afterEach(async () => {
  await shutdownMetrics();
  reset();
});

const collectBytesPoints = async () => {
  await reader.forceFlush();
  const all = exporter.getMetrics();
  exporter.reset();
  return all
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .filter(
      (m): m is SumMetricData =>
        m.descriptor.name === "peerkit.transport.bytes" &&
        m.dataPointType === DataPointType.SUM,
    )
    .flatMap((m) => m.dataPoints);
};

test("peerkit.transport.bytes records sent and received bytes", async () => {
  const received: Uint8Array[] = [];
  const messageHandler: MessageHandler = async (_from, message) => {
    received.push(message);
  };
  const { node: node1, address } = await createNode({
    id: "node1",
    messageHandler,
  });
  const { node: node2 } = await createNode({ id: "node2" });
  await node2.connect(address);

  const payload = new TextEncoder().encode("hello-metrics");
  await node2.send(node1.getNodeId(), payload);
  await vi.waitFor(() => expect(received.length).toBe(1));

  const points = await collectBytesPoints();
  const sent = points.find((p) => p.attributes.direction === "sent");
  const recv = points.find((p) => p.attributes.direction === "received");
  expect(sent?.value).toBe(payload.byteLength);
  expect(recv?.value).toBe(payload.byteLength);

  await node2.shutDown();
  await node1.shutDown();
});
