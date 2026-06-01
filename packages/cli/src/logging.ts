import { parseLogLevel, type LogLevel } from "@logtape/logtape";

export const logLevel: LogLevel = process.env.PEERKIT_LOG
  ? parseLogLevel(process.env.PEERKIT_LOG)
  : "warning";
