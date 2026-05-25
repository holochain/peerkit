import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { memory } from "@libp2p/memory";
import { ping } from "@libp2p/ping";
import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";
import type {
  AgentsReceivedCallback,
  ConnectedToRelayCallback,
  CustomStreamCreatedCallback,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  PeerConnectedCallback,
  PeerDisconnectedCallback,
} from "@peerkit/api";
import { createLibp2p } from "libp2p";
import { randomUUID } from "node:crypto";
import { TransportLibp2p } from "../src/index.js";

export const uniqueTxAddress = () => randomUUID();

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
  /**
   * Opt into the libp2p ping protocol on the relay. Defaults to `false`.
   */
  enablePing?: boolean;
}

/**
 * Creates a test relay transport
 */
export const createRelay = async (options: TestRelayOptions) => {
  const { id, networkAccessBytes, enablePing } = options;
  const address = `/memory/${uniqueTxAddress()}`;
  // This is mostly what the production relay is like, with the exception that
  // an in-memory transport is used.
  const libp2p = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Circuit relay server enables relay functionality.
    // applyDefaultLimit: false removes the 2-min / 128 KiB per-connection
    // caps so the relay can serve as a permanent data-channel fallback.
    // ping is opt-in (off by default) for external liveness/RTT health checks.
    services: {
      relay: circuitRelayServer({
        reservations: { applyDefaultLimit: false },
      }),
      identify: identify(),
      ...(enablePing ? { ping: ping() } : {}),
    },
    addresses: {
      listen: [address],
    },
  });

  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const peerConnectedCallback =
    options.peerConnectedCallback ?? (async (_nodeId, _transport) => {});
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => true);
  const relay = new TransportLibp2p(libp2p, {
    id,
    networkAccessBytes,
    agentsReceivedCallback,
    peerConnectedCallback,
    networkAccessHandler,
  });
  await libp2p.start();

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
   * Optional callback when peer disconnected
   */
  peerDisconnectedCallback?: PeerDisconnectedCallback;
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
   * Optional callbacks for when custom streams are created
   */
  customStreamCreatedCallbacks?: Record<string, CustomStreamCreatedCallback>;
  /**
   * Optional timeout for the outbound access handshake response
   */
  handshakeTimeoutMs?: number;
}

/**
 * Creates a test node transport
 */
export const createNode = async (options: TestNodeOptions) => {
  const address = `/memory/${uniqueTxAddress()}`;
  const { id, handshakeTimeoutMs } = options;
  const connectedToRelayCallback = options.connectedToRelayCallback;
  const agentsReceivedCallback =
    options.agentsReceivedCallback ?? (async (_fromPeer, _bytes) => {});
  const peerConnectedCallback =
    options.peerConnectedCallback ?? (async (_nodeId, _transport) => {});
  const peerDisconnectedCallback = options.peerDisconnectedCallback;
  const networkAccessHandler =
    options.networkAccessHandler ?? (async (_fromPeer, _bytes) => true);
  const networkAccessBytes = options.networkAccessBytes ?? new Uint8Array([0]);
  const messageHandler =
    options.messageHandler ?? (async (_fromPeer, _message, _transport) => {});
  const customStreamCreatedCallbacks = options.customStreamCreatedCallbacks;
  // This is mostly what the production node is like, with the exception that
  // an in-memory transport is used.
  const libp2p = await createLibp2p({
    // Defer listening so TransportLibp2p can register protocol handlers
    // (including /peerkit/access/v1) before any inbound connection arrives.
    start: false,
    // Circuit relay transport enables connecting to peers through connected relays.
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
    addresses: {
      listen: [address],
    },
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
  });

  const node = new TransportLibp2p(libp2p, {
    id,
    connectedToRelayCallback,
    agentsReceivedCallback,
    peerConnectedCallback,
    peerDisconnectedCallback,
    networkAccessHandler,
    networkAccessBytes,
    messageHandler,
    customStreamCreatedCallbacks: customStreamCreatedCallbacks,
    handshakeTimeoutMs,
  });
  await libp2p.start();
  // Connect to all provided relays.

  return { node, address };
};
