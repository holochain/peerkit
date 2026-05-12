import { DiagLogLevel, metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { installDiagLogger, uninstallDiagLogger } from "./diag.js";

export interface MetricsConfig {
  /** `service.name` resource attribute. Required. */
  serviceName: string;
  /** Optional `service.version` resource attribute. */
  serviceVersion?: string;
  /** OTLP/HTTP metrics endpoint. Default: `http://localhost:4318/v1/metrics`. */
  otlpEndpoint?: string;
  /** Export interval. Default: 60 000 ms. */
  exportIntervalMillis?: number;
  /** Export timeout. Default: 30 000 ms. */
  exportTimeoutMillis?: number;
  /** Extra OTLP request headers (auth, tenant, …). */
  headers?: Record<string, string>;
  /** Additional resource attributes. */
  resourceAttributes?: Record<string, string>;
  /**
   * Optional metric reader to use instead of the default OTLP/HTTP reader.
   * Primarily for tests with `InMemoryMetricExporter`.
   */
  reader?: MetricReader;
  /**
   * Minimum level of OpenTelemetry SDK diagnostic messages forwarded to the
   * `peerkit.metrics` logtape logger. Default: {@link DiagLogLevel.WARN}.
   * Lower (e.g. {@link DiagLogLevel.DEBUG}) is helpful when investigating
   * why metrics are not being exported.
   */
  diagLogLevel?: DiagLogLevel;
}

let activeProvider: MeterProvider | undefined;

/**
 * Initialise the global metrics pipeline.
 *
 * Builds a {@link MeterProvider} that exports to the configured OTLP endpoint
 * (or to a caller-supplied {@link MetricReader}) and registers it as the
 * global meter provider for `@opentelemetry/api`.
 *
 * Must be called at most once between {@link shutdownMetrics} calls; a second
 * call without prior shutdown rejects.
 */
export async function initMetrics(cfg: MetricsConfig): Promise<void> {
  if (activeProvider) {
    throw new Error(
      "Metrics already initialised. Call shutdownMetrics() before re-initialising.",
    );
  }

  installDiagLogger(cfg.diagLogLevel);

  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    ...(cfg.serviceVersion && { [ATTR_SERVICE_VERSION]: cfg.serviceVersion }),
    ...(cfg.resourceAttributes ?? {}),
  };
  const resource = resourceFromAttributes(resourceAttrs);

  const reader =
    cfg.reader ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: cfg.otlpEndpoint ?? "http://localhost:4318/v1/metrics",
        headers: cfg.headers,
        timeoutMillis: cfg.exportTimeoutMillis ?? 30_000,
      }),
      exportIntervalMillis: cfg.exportIntervalMillis ?? 60_000,
    });

  const provider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  activeProvider = provider;
}

/**
 * Flush pending metrics, shut the provider down, and restore the OpenTelemetry
 * default no-op meter provider.
 *
 * Safe to call when metrics have not been initialised.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!activeProvider) {
    return;
  }
  const provider = activeProvider;
  activeProvider = undefined;
  try {
    await provider.forceFlush();
  } finally {
    try {
      await provider.shutdown();
    } finally {
      metrics.disable();
      uninstallDiagLogger();
    }
  }
}
