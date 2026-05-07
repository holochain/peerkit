import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";
import getPort, { portNumbers } from "get-port";
import { TransportLibp2p } from "../src/index.js";
import type {
  AgentsReceivedCallback,
  ConnectedToRelayCallback,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  PeerConnectedCallback,
} from "@peerkit/api";

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

/**
 * Sleep for the provided duration.
 *
 * @param durationMs Duration in milliseconds
 */
export const sleep = async (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export interface TestRelayOptions {
  /**
   * Optional string to identify the node in logs
   */
  id?: string;
  /**
   * Optional callback when receiving agents
   */
  agentsReceivedCallback?: AgentsReceivedCallback;
  /**
   * Optional callback when peer connected
   */
  peerConnectedCallback?: PeerConnectedCallback;
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
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const peerConnectedCallback =
    options.peerConnectedCallback ?? (async (_nodeId) => {});
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => true);
  const relay = await TransportLibp2p.createRelay({
    addrs: [address],
    id,
    networkAccessBytes,
    agentsReceivedCallback,
    peerConnectedCallback,
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
   * Optional callback when connected to a relay
   */
  connectedToRelayCallback?: ConnectedToRelayCallback;
  /**
   * Optional callback when receiving agents
   */
  agentsReceivedCallback?: AgentsReceivedCallback;
  /**
   * Optional callback when peer connected
   */
  peerConnectedCallback?: PeerConnectedCallback;
  /**
   * Optional handler for network access checks.
   *
   * Defaults to allowing all access.
   */
  networkAccessHandler?: NetworkAccessHandler;
  /**
   * Optional network access bytes
   */
  networkAccessBytes?: NetworkAccessBytes;
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
  const port = await getPort({ port: portNumbers(40_000, 50_000) });
  const address = `/ip4/0.0.0.0/tcp/${port}`;
  const { id, bootstrapRelays, handshakeTimeoutMs } = options;
  const connectedToRelayCallback =
    options.connectedToRelayCallback ?? undefined;
  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const peerConnectedCallback =
    options.peerConnectedCallback ?? (async (_nodeId) => {});
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => true);
  const networkAccessBytes = options.networkAccessBytes ?? new Uint8Array([0]);
  const messageHandler =
    options.messageHandler ?? (async (_fromPeer, _message) => {});
  const node = await TransportLibp2p.createNode({
    addrs: [address],
    id,
    connectedToRelayCallback,
    agentsReceivedCallback,
    peerConnectedCallback,
    networkAccessHandler,
    networkAccessBytes,
    messageHandler,
    bootstrapRelays,
    handshakeTimeoutMs,
  });
  return { node, address };
};
