/**
 * @fileoverview Shared helpers for relay integration tests.
 *
 * Boots a real relay on a free loopback UDP port (WebRTC Direct), reads its
 * dialable multiaddr at runtime, and spawns peerkit nodes with captured
 * message/agent buffers and circuit-relay addresses.
 */

import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import { createNode } from "@peerkit/transport-libp2p-nodejs";
import type { TransportLibp2p } from "@peerkit/transport-libp2p-core";
import {
  AgentKeyPair,
  serializeAgentInfoCanonical,
  serializeAgentInfoList,
} from "@peerkit/peerkit";
import { MemoryAgentStore } from "@peerkit/agent-store";
import { MemoryAgentKeyStore } from "@peerkit/test-utils";
import type {
  AgentInfoSigned,
  IAgentStore,
  NetworkAccessBytes,
  NodeAddress,
  NodeId,
  RelayCertificate,
} from "@peerkit/api";
import { createLogger } from "../src/logger.js";
import { startRelay, type RunningRelay } from "../src/relay.js";

/** Default secret shared by helper-spawned relays and nodes. */
export const DEFAULT_SECRET = "integration-test";

/**
 * Derive deterministic {@link NetworkAccessBytes} from a shared secret.
 *
 * The relay package keeps this concern out of `src` (its `RelayConfig`
 * accepts raw `NetworkAccessBytes` + a handler), so tests own the
 * secret→bytes mapping. Relay and node must agree on the algorithm for the
 * access handshake to succeed; sha256 is arbitrary but shared by both sides.
 */
export function computeNetworkAccessBytes(secret: string): NetworkAccessBytes {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

/** Constant-length byte comparison used by the relay's access handler. */
function bytesEqual(a: NetworkAccessBytes, b: NetworkAccessBytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Test handle returned by {@link startTestRelay}. */
export interface TestRelay {
  readonly relay: RunningRelay;
  readonly store: IAgentStore;
  readonly multiaddr: string;
  readonly secret: string;
  shutdown(): Promise<void>;
}

/** Boots a relay bound to an OS-assigned loopback UDP port. */
export async function startTestRelay(
  opts: { secret?: string; certificate?: RelayCertificate } = {},
): Promise<TestRelay> {
  const secret = opts.secret ?? DEFAULT_SECRET;
  const store = new MemoryAgentStore();
  // The relay grants access only to peers presenting these exact bytes; it
  // also announces them so the dialing node's own handler can accept.
  const accessBytes = computeNetworkAccessBytes(secret);
  const relay = await startRelay(
    {
      id: "test-relay",
      logLevel: "warn",
      listenAddrs: ["127.0.0.1:0"],
      networkAccessBytes: accessBytes,
      networkAccessHandler: async (_nodeId, bytes) =>
        bytesEqual(bytes, accessBytes),
      certificate: opts.certificate,
    },
    {
      logger: createLogger({ level: "warn", id: "test" }),
      agentStore: store,
    },
  );
  // The relay listens on WebRTC Direct; its dialable address carries the
  // ephemeral certhash generated at start, so read it at runtime rather
  // than constructing it from the port.
  const addresses = relay.transport.getListenAddresses();
  const multiaddr = addresses.find((a) => a.includes("/webrtc-direct"));
  if (multiaddr === undefined) {
    store.destroy();
    throw new Error(
      `startTestRelay: relay has no webrtc-direct address; got: ${addresses.join(", ")}`,
    );
  }
  return {
    relay,
    store,
    multiaddr,
    secret,
    shutdown: async () => {
      try {
        await relay.shutdown();
      } finally {
        store.destroy();
      }
    },
  };
}

/**
 * Build a freshly signed {@link AgentInfoSigned} and its cbor wire bytes.
 *
 * The relay cbor-decodes inbound agent payloads and verifies each record's
 * Ed25519 signature before storing, so tests must send genuinely signed
 * records. Mirrors peerkit's own `buildOwnAgentInfo`, reconstructed from the
 * package's public exports.
 */
export async function makeSignedAgentInfo(
  opts: { expiresAt?: number; addresses?: string[] } = {},
): Promise<{ readonly info: AgentInfoSigned; readonly bytes: Uint8Array }> {
  const keyPair = await AgentKeyPair.load_or_create(new MemoryAgentKeyStore());
  const agentInfo = {
    agentId: keyPair.agentId(),
    addresses: opts.addresses ?? [],
    expiresAt: opts.expiresAt ?? Date.now() + 60_000,
  };
  const signature = keyPair.sign(serializeAgentInfoCanonical(agentInfo));
  const info: AgentInfoSigned = { ...agentInfo, signature };
  return { info, bytes: serializeAgentInfoList([info]) };
}

/** Captured inbound message frame on a node. */
export interface ReceivedMessage {
  readonly from: string;
  readonly bytes: Uint8Array;
}

/** Test handle returned by {@link startTestNode}. */
export interface TestNode {
  readonly node: TransportLibp2p;
  readonly nodeId: string;
  readonly received: ReceivedMessage[];
  readonly receivedAgents: ReceivedMessage[];
  /** Maps relayId → fully dialable `/…/p2p-circuit/p2p/<localId>` address. */
  readonly circuitAddrs: NodeAddress[];
  readonly connectedRelays: Set<NodeId>;
  waitForCircuitAddr(timeoutMs?: number): Promise<string[]>;
  shutdown(): Promise<void>;
}

/** Spawns a peerkit node with captured buffers and optional bootstrap relays. */
export async function startTestNode(
  opts: {
    secret?: string;
    accessBytes?: Uint8Array;
    bootstrapRelays?: readonly string[];
  } = {},
): Promise<TestNode> {
  const secret = opts.secret ?? DEFAULT_SECRET;
  const received: ReceivedMessage[] = [];
  const receivedAgents: ReceivedMessage[] = [];
  const circuitAddrs: NodeAddress[] = [];
  const connectedRelays = new Set<NodeId>();
  const node = await createNode({
    // `/p2p-circuit` accepts inbound relayed connections; `/webrtc` is the
    // node transport's direct-connection listener. The node dials the relay
    // outbound over WebRTC Direct, so it needs no listen address of its own.
    addrs: ["/p2p-circuit", "/webrtc"],
    networkAccessBytes: opts.accessBytes ?? computeNetworkAccessBytes(secret),
    networkAccessHandler: async () => true,
    peerConnectedCallback: async () => undefined,
    messageHandler: async (from, bytes) => {
      received.push({ from, bytes });
    },
    addressesChangedCallback: async (addresses, _transport) => {
      circuitAddrs.push(...addresses);
    },
    agentsReceivedCallback: async (from, bytes) => {
      receivedAgents.push({ from, bytes });
    },
    connectedToRelayCallback: async (relayNodeId) => {
      connectedRelays.add(relayNodeId);
    },
    bootstrapRelays: opts.bootstrapRelays
      ? [...opts.bootstrapRelays]
      : undefined,
  });
  return {
    node,
    nodeId: node.getNodeId(),
    received,
    receivedAgents,
    connectedRelays,
    circuitAddrs,
    waitForCircuitAddr: async (timeoutMs = 15_000) => {
      await vi.waitFor(
        () => {
          expect(circuitAddrs.length).not.toBe(0);
        },
        { timeout: timeoutMs },
      );
      return circuitAddrs;
    },
    shutdown: async () => {
      await node.shutDown();
    },
  };
}
