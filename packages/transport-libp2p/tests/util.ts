import getPort from "get-port";
import { TransportLibp2p } from "../src/index.js";
import type {
  IAgentsReceivedCallback,
  IMessageHandler,
  INetworkAccessHandler,
} from "../src/types/transport.js";
import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";

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

/**
 * Creates a test relay transport
 *
 * @param id Optional string to identify the node in logs
 * @param agentsReceivedCallback Optional handler for receiving agents
 * @param networkAccessHandler Optional handler for network access checks. Defaults to denying all access
 * @param messageHandler Optional message handler
 * @returns A Peerkit transport and its listening address (for raw libp2p dials in tests)
 */
export const createRelay = async (
  id?: string,
  agentsReceivedCallback?: IAgentsReceivedCallback,
  networkAccessHandler?: INetworkAccessHandler,
) => {
  const port = await getPort({ port: [30_000, 40_000] });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  agentsReceivedCallback =
    agentsReceivedCallback ?? ((_fromAgent, _bytes) => Promise.resolve());
  networkAccessHandler =
    networkAccessHandler ?? ((_fromAgent, _bytes) => Promise.resolve(false));
  const relay = await TransportLibp2p.createRelay(
    agentsReceivedCallback,
    networkAccessHandler,
    { addrs: [address], id },
  );
  return { relay, address };
};

/**
 * Creates a test node transport
 *
 * @param id Optional string to identify the node in logs
 * @param agentsReceivedCallback Optional handler for receiving agents
 * @param networkAccessHandler Optional handler for network access checks. Defaults to denying all access
 * @param messageHandler Optional message handler
 * @returns A Peerkit transport and its listening address (for raw libp2p dials in tests)
 */
export const createNode = async (
  id?: string,
  agentsReceivedCallback?: IAgentsReceivedCallback,
  networkAccessHandler?: INetworkAccessHandler,
  messageHandler?: IMessageHandler,
) => {
  const port = await getPort({ port: [30_000, 40_000] });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  agentsReceivedCallback =
    agentsReceivedCallback ?? ((_fromAgent, _bytes) => Promise.resolve());
  networkAccessHandler =
    networkAccessHandler ?? ((_fromAgent, _bytes) => Promise.resolve(false));
  messageHandler =
    messageHandler ?? ((_fromAgent, _agentList) => Promise.resolve());
  const node = await TransportLibp2p.create(
    agentsReceivedCallback,
    networkAccessHandler,
    messageHandler,
    { addrs: [address], id },
  );
  return { node, address };
};
