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
import { setupTestLogger } from "@peerkit/test-utils";
import { TransportIroh } from "../src/transport.js";
import { MockDriver, MockNetwork } from "./mock-driver.js";

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;

beforeEach(async () => {
  await setupTestLogger();
  // initMetrics must run before any transport is constructed, since instruments
  // are created in the constructor.
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  await initMetrics({ serviceName: "transport-iroh-test", reader });
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
  const network = new MockNetwork();
  const node1 = new TransportIroh(new MockDriver("node1", network), {
    networkAccessHandler: async () => true,
    agentsReceivedCallback: async () => {},
    messageHandler: async (_from, message) => {
      received.push(message);
    },
  });
  const node2 = new TransportIroh(new MockDriver("node2", network), {
    networkAccessHandler: async () => true,
    agentsReceivedCallback: async () => {},
    messageHandler: async () => {},
  });

  await node2.connect(node1.getListenAddresses());
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
