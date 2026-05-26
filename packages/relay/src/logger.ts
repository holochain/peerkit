/**
 * @fileoverview Structured JSON logger backed by @logtape/logtape.
 *
 * Configures logtape once on first call. Routes both this relay's
 * category ("peerkit-relay") and peerkit internals ("peerkit") through
 * the same JSON sink, so peerkit logs are visible alongside ours.
 *
 * Child loggers carry subsystem names via `getChild("access")` etc.,
 * surfacing as `category` arrays in the JSON output.
 */

import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
  type Logger,
  type LogLevel,
} from "@logtape/logtape";

export type { Logger };

export interface LoggerOptions {
  /** Accepts pino-style "warn" or logtape "warning"; both map to logtape warning. */
  readonly level: string;
  readonly id: string;
}

let configured = false;

function toLogLevel(level: string): LogLevel {
  // Accept pino-style "warn" as an alias for logtape's "warning".
  const normalized = level === "warn" ? "warning" : level;
  if (!isLogLevel(normalized)) {
    throw new Error(
      `Invalid log level: ${level} (expected one of trace, debug, info, warn, warning, error, fatal)`,
    );
  }
  return normalized;
}

export function createLogger(options: LoggerOptions): Logger {
  if (!configured) {
    const level = toLogLevel(options.level);
    configureSync({
      reset: true,
      sinks: {
        console: getConsoleSink({ formatter: getJsonLinesFormatter() }),
      },
      loggers: [
        { category: "peerkit-relay", lowestLevel: level, sinks: ["console"] },
        { category: "peerkit", lowestLevel: level, sinks: ["console"] },
        {
          category: ["logtape", "meta"],
          lowestLevel: "warning",
          sinks: ["console"],
        },
      ],
    });
    configured = true;
  }
  return getLogger("peerkit-relay").with({ relayId: options.id });
}
