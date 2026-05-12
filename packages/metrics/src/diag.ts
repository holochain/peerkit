import { getLogger } from "@logtape/logtape";
import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";

const logger = getLogger(["peerkit", "metrics"]);

/**
 * Bridge OpenTelemetry's `diag` channel to the peerkit logtape logger,
 * so exporter errors and SDK diagnostics surface through the standard
 * peerkit logging pipeline.
 *
 * `level` filters messages on the OTel side before they reach logtape:
 * - `ERROR` — only outright failures.
 * - `WARN` (default) — failures + retries / dropped data.
 * - `INFO` / `DEBUG` / `VERBOSE` — increasingly chatty; useful when
 *   diagnosing why metrics are not exporting.
 */
export function installDiagLogger(
  level: DiagLogLevel = DiagLogLevel.WARN,
): void {
  const diagLogger: DiagLogger = {
    error: (message, ...args) => logger.error(message, { args }),
    warn: (message, ...args) => logger.warn(message, { args }),
    info: (message, ...args) => logger.info(message, { args }),
    debug: (message, ...args) => logger.debug(message, { args }),
    verbose: (message, ...args) => logger.debug(message, { args }),
  };
  diag.setLogger(diagLogger, level);
}

/**
 * Restore the OpenTelemetry default diag logger.
 */
export function uninstallDiagLogger(): void {
  diag.disable();
}
