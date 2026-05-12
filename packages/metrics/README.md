# @peerkit/metrics

App-side OpenTelemetry SDK bootstrap for peerkit. Configures a global OTel
`MeterProvider` that exports metrics over OTLP/HTTP, and bridges OTel
diagnostics into the `peerkit.metrics` logtape logger.

This package is consumed **only by applications**. Library packages (e.g.
`@peerkit/transport-libp2p-core`) depend on `@opentelemetry/api` directly
and call `metrics.getMeter(...)` to obtain their meter, per the
[OpenTelemetry library guidelines][otel-lib]. They do not depend on the
SDK, and do not depend on this package.

[otel-lib]: https://opentelemetry.io/docs/specs/otel/library-guidelines/#api-and-minimal-implementation

## Install

```bash
npm install @peerkit/metrics
```

## Usage

```ts
import { initMetrics, shutdownMetrics } from "@peerkit/metrics";

await initMetrics({
  serviceName: "my-peerkit-app",
  serviceVersion: "1.0.0",
  otlpEndpoint: "http://localhost:4318/v1/metrics",
});

// On shutdown:
await shutdownMetrics();
```

If `initMetrics` is never called, library instruments bind to OpenTelemetry's
no-op meter — they still work but record nothing, at zero cost.

## Configuration

| Option                 | Default                                   | Description                               |
| ---------------------- | ----------------------------------------- | ----------------------------------------- |
| `serviceName`          | _required_                                | `service.name` resource attribute         |
| `serviceVersion`       | _unset_                                   | `service.version` resource attribute      |
| `otlpEndpoint`         | `http://localhost:4318/v1/metrics`        | OTLP/HTTP metrics endpoint                |
| `exportIntervalMillis` | `60000`                                   | Periodic export interval                  |
| `exportTimeoutMillis`  | `30000`                                   | Per-export timeout                        |
| `headers`              | `{}`                                      | Extra OTLP request headers (auth, tenant) |
| `resourceAttributes`   | `{}`                                      | Additional OTel resource attributes       |
| `reader`               | OTLP/HTTP `PeriodicExportingMetricReader` | Override reader (mainly for tests)        |

Exporter diagnostics are routed to the `peerkit.metrics` logtape logger.
