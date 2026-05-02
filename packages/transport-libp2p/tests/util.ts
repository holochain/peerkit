import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";
import getPort from "get-port";
import { TransportLibp2p } from "../src/index.js";
import type {
  AgentsReceivedCallback,
  MessageHandler,
  NetworkAccessHandler,
} from "@peerkit/interface";

export const setupTestLogger = async () => {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: getAnsiColorFormatter({
          format({ timestamp, level, category, message, record }) {
            let output = `${timestamp} ${level} ${category}`;
            if (typeof record.properties.id === "string") {
              output = output + ` ${record.properties.id}`;
            }
            output = output + `: ${message}`;
            return output;
          },
        }),
      }),
    },
    loggers: [
      {
        category: "peerkit",
        lowestLevel: "info",
        sinks: ["console"],
      },
    ],
  });
};

export const sleep = async (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Retry calling a function until a timeout elapses.
 *
 * When the function returns true, the promise will be resolved.
 * If the timeout elapses, the promise will be rejected.
 *
 * @param fn The function to call
 * @param timeoutMs The timeout to retry for. Defaults to 2000 ms
 * @param sleepMs How long to sleep between retries. Defaults to 100 ms
 */
export const retryFnUntilTimeout = async (
  fn: () => Promise<boolean>,
  timeoutMs?: number,
  sleepMs?: number,
) => {
  timeoutMs = timeoutMs ?? 2000;
  sleepMs = sleepMs ?? 100;
  const start = performance.now();
  for (;;) {
    const result = await fn();
    if (result === true) {
      return Promise.resolve();
    }
    if (performance.now() - start > timeoutMs) {
      return Promise.reject("retryFnUntilTimeout timed out");
    }
    await sleep(sleepMs);
  }
};

export interface TestRelayOptions {
  /**
   * Optional string to identify the node in logs
   */
  id?: string;
  /**
   * Optional handler for receiving agents
   */
  agentsReceivedCallback?: AgentsReceivedCallback;
  /**
   * Optional handler for network access checks. Defaults to denying all access
   */
  networkAccessHandler?: NetworkAccessHandler;
  /**
   * Optional network access bytes included in counter-handshake responses
   */
  networkAccessBytes?: Uint8Array;
}

/**
 * Creates a test relay transport
 */
export const createRelay = async (options: TestRelayOptions) => {
  const { id, networkAccessBytes } = options;
  const port = await getPort({ port: [30_000, 40_000] });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => false);
  const relay = await TransportLibp2p.createRelay({
    addrs: [address],
    id,
    networkAccessBytes,
    agentsReceivedCallback,
    networkAccessHandler,
  });
  return { relay, address };
};

export interface TestNodeOptions {
  /**
   * Optional string to identify the node in logs
   */
  id?: string;
  /**
   * Optional callback when receiving agents
   */
  agentsReceivedCallback?: AgentsReceivedCallback;
  /**
   * Optional handler for network access checks. Defaults to denying all access
   */
  networkAccessHandler?: NetworkAccessHandler;
  /**
   * Optional message handler
   */
  messageHandler?: MessageHandler;
  /**
   * Optional relay addresses to connect to at startup
   */
  bootstrapRelays?: string[];
  /**
   * Optional timeout for the outbound access handshake response
   */
  handshakeTimeoutMs?: number;
}

/**
 * Creates a test node transport
 */
export const createNode = async (options: TestNodeOptions) => {
  const port = await getPort({ port: [30_000, 40_000] });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  const { id, bootstrapRelays, handshakeTimeoutMs } = options;
  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => false);
  const messageHandler =
    options.messageHandler ?? (async (_fromPeer, _message) => {});
  const node = await TransportLibp2p.createNode({
    addrs: [address],
    id,
    agentsReceivedCallback,
    networkAccessHandler,
    messageHandler,
    bootstrapRelays,
    handshakeTimeoutMs,
  });
  return { node, address };
};
