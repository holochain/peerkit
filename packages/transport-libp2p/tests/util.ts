import getPort from "get-port";
import { TransportLibp2p } from "../src/index.js";
import type {
  IMessageHandler,
  INetworkAccessHandler,
} from "../src/types/transport.js";

export const sleep = async (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Retry calling a function until a timeout elapses.
 *
 * When the function returns true, the promise will be resolved.
 * If the timeout elapses, the promise will be rejected.
 *
 * @param fn The function to call
 * @param timeoutMs The timeout to retry for. Defaults to 1000 ms
 * @param sleepMs How long to sleep between retries. Defaults to 100 ms
 */
export const retryFnUntilTimeout = async (
  fn: () => Promise<boolean>,
  timeoutMs?: number,
  sleepMs?: number,
) => {
  timeoutMs = timeoutMs ?? 1000;
  sleepMs = sleepMs ?? 100;
  const start = performance.now();
  for (;;) {
    const result = await fn();
    if (result === true) {
      return Promise.resolve();
    }
    if (performance.now() - start > timeoutMs) {
      return Promise.reject("timeout");
    }
    await sleep(sleepMs);
  }
};

/**
 * Creates a test transport (regular node).
 *
 * @param id Optional string to identify the node in logs
 * @param networkAccessHandler Optional handler for network access checks. Defaults to denying all access
 * @param messageHandler Optional message handler
 * @returns A Peerkit transport and its listening address (for raw libp2p dials in tests)
 */
export const createTransport = async (
  id?: string,
  networkAccessHandler?: INetworkAccessHandler,
  messageHandler?: IMessageHandler,
) => {
  const port = await getPort({ port: [30_000, 40_000] });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  const node = await TransportLibp2p.create({ addrs: [address], id });
  node.setNetworkAccessHandler(
    networkAccessHandler ?? ((_agentId, _bytes) => false),
  );
  if (messageHandler) {
    node.setMessageHandler(messageHandler);
  }
  return { node, address };
};
