import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createLibp2p } from "libp2p";
import { encodeFrame, FrameDecoder } from "./frame.js";
import { NetworkAccessHandshake } from "./proto/access.js";
import type {
  AgentId,
  IAgentsReceivedCallback,
  IMessageHandler,
  INetworkAccessHandler,
  ITransport,
  NetworkAccessBytes,
  RelayAddress,
} from "./types/index.js";

export interface RelayOptions {
  addrs?: string[];
  id?: string;
}

export interface NodeOptions {
  addrs?: string[];
  id?: string;
  /**
   * Relay addresses to connect to at startup. Format: {@link @multiformats/multiaddr!Multiaddr}
   */
  bootstrapRelays?: RelayAddress[];
  /**
   * Network access bytes sent to relays during bootstrap handshake
   */
  networkAccessBytes?: NetworkAccessBytes;
}

// Stable string key for an AgentId (Uint8Array has no value equality in JS).
const agentIdToKey = (agentId: AgentId) =>
  agentId.reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");

/**
 * Identifier for the current network access protocol in peerkit.
 *
 * This protocol expects the network access bytes to be transmitted as
 * the only message. Based on validity of the bytes, access is granted
 * or denied.
 */
export const CURRENT_ACCESS_PROTOCOL = "/peerkit/access/v1";

/**
 * Identifier for the current agents protocol in peerkit.
 *
 * This protocol is used to exchange agent information between connected
 * peers after access has been granted.
 */
export const CURRENT_AGENTS_PROTOCOL = "/peerkit/agents/v1";

/**
 * Identifier for the current messaging protocol in peerkit.
 *
 * This protocol is used to exchange messages between connected
 * peers after access has been granted.
 */
export const CURRENT_MESSAGE_PROTOCOL = "/peerkit/message/v1";

/**
 * The official peerkit transport based on Libp2p.
 */
export class TransportLibp2p implements ITransport {
  private libp2p: Libp2p;
  private logger: Logger;
  private agentsReceivedCallback: IAgentsReceivedCallback;
  private networkAccessHandler: INetworkAccessHandler;
  private messageHandler?: IMessageHandler;

  // Map of peerkit agent ID to libp2p peer ID.
  private peerToAgent: Map<PeerId, AgentId> = new Map();
  // Reverse map for lookups of libp2p peer from agent ID.
  private agentToPeer: Map<string, PeerId> = new Map();
  // Map is keyed by a string, because objects are compared by reference, not by value.
  // true = granted, false = denied. Both entries are sticky for the session.
  private agentAccess: Map<string, boolean> = new Map();

  constructor(
    libp2p: Libp2p,
    agentsReceivedCallback: IAgentsReceivedCallback,
    networkAccessHandler: INetworkAccessHandler,
    messageHandler?: IMessageHandler,
    options?: NodeOptions | RelayOptions,
  ) {
    this.agentsReceivedCallback = agentsReceivedCallback;
    this.networkAccessHandler = networkAccessHandler;

    libp2p.handle(CURRENT_ACCESS_PROTOCOL, this.onAccessConnect);
    libp2p.handle(CURRENT_AGENTS_PROTOCOL, this.onAgentsConnect);
    if (messageHandler) {
      // Regular node that will handle messages. Relay nodes don't handle messages.
      libp2p.handle(CURRENT_MESSAGE_PROTOCOL, this.onMessageConnect);
      this.messageHandler = messageHandler;
    }

    this.libp2p = libp2p;
    this.logger = getLogger(["peerkit", "transport"]).with({
      peerId: libp2p.peerId,
      id: options?.id,
    });
    this.logger.info("Transport created {*}", {
      addresses: libp2p.getMultiaddrs(),
      id: options?.id,
    });
  }

  static async create(
    agentsReceivedCallback: IAgentsReceivedCallback,
    networkAccessHandler: INetworkAccessHandler,
    messageHandler: IMessageHandler,
    options?: NodeOptions,
  ): Promise<TransportLibp2p> {
    const libp2pNode = await createLibp2p({
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      addresses: {
        listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0"],
      },
    });
    await libp2pNode.start();
    const transport = new TransportLibp2p(
      libp2pNode,
      agentsReceivedCallback,
      networkAccessHandler,
      messageHandler,
      options,
    );
    if (options?.bootstrapRelays?.length) {
      await transport.connectToRelays(
        options.bootstrapRelays,
        options.networkAccessBytes ?? new Uint8Array(0),
      );
    }
    return transport;
  }

  static async createRelay(
    agentsReceivedCallback: IAgentsReceivedCallback,
    networkAccessHandler: INetworkAccessHandler,
    options?: RelayOptions,
  ): Promise<TransportLibp2p> {
    const libp2pNode = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { relay: circuitRelayServer(), identify: identify() },
      addresses: {
        listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0"],
      },
    });
    await libp2pNode.start();
    // Relay nodes don't handle messages
    return new TransportLibp2p(
      libp2pNode,
      agentsReceivedCallback,
      networkAccessHandler,
      undefined,
      options,
    );
  }

  async connect(agentId: AgentId, _bytes: NetworkAccessBytes): Promise<void> {
    const key = agentIdToKey(agentId);
    const peerId = this.agentToPeer.get(key);
    if (!peerId) {
      throw new Error(
        "Agent not known to this transport. Ensure the agent has been discovered via the agents channel before calling connect().",
      );
    }
    await this.libp2p.dial(peerId);
  }

  async send(_agentId: AgentId, _data: Uint8Array): Promise<void> {}

  async sendAgents(agentId: AgentId, data: Uint8Array): Promise<void> {
    const key = agentIdToKey(agentId);
    const peerId = this.agentToPeer.get(key);
    if (!peerId) {
      throw new Error(
        "Agent not known to this transport. Ensure the agent has been discovered before calling sendAgents().",
      );
    }
    const connections = this.libp2p.getConnections(peerId);
    if (!connections.length) {
      this.logger.error("sendAgents: No open connection to agent {*}", {
        agentId,
        peerId,
      });
    }
    const stream = await connections[0]!.newStream(CURRENT_AGENTS_PROTOCOL);
    stream.send(encodeFrame(data));
    await stream.close();
  }

  async stop(): Promise<void> {
    return this.libp2p.stop();
  }

  private async connectToRelays(
    relays: RelayAddress[],
    networkAccessBytes: NetworkAccessBytes,
  ) {
    return await Promise.all(
      relays.map((relay) => this.connectToRelay(relay, networkAccessBytes)),
    );
  }

  private async connectToRelay(
    relay: RelayAddress,
    networkAccessBytes: NetworkAccessBytes,
  ): Promise<void> {
    const addr = multiaddr(relay);
    this.logger.info("Connecting to relay {*}", { relay });
    const connection = await this.libp2p.dial(addr);
    const stream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
    stream.send(
      NetworkAccessHandshake.encode({
        // Relay nodes receive a placeholder AgentId of all-zeros
        // until the real local AgentId is wired up.
        agentId: new Uint8Array(32),
        networkAccessBytes,
      }),
    );
    await stream.close();
    this.logger.info("Access handshake sent to relay {*}", { relay });
  }

  private onAccessConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming stream {*}`, {
      CURRENT_ACCESS_PROTOCOL,
      remoteId: connection.remotePeer,
    });
    stream.addEventListener(
      "message",
      async (message) => {
        this.logger.info(`Incoming message {*}`, {
          remoteId: connection.remotePeer,
          CURRENT_ACCESS_PROTOCOL,
        });
        const raw =
          message.data instanceof Uint8Array
            ? message.data
            : message.data.subarray();

        let handshake: NetworkAccessHandshake;
        try {
          handshake = NetworkAccessHandshake.decode(raw);
        } catch {
          this.logger.error(
            "Failed to decode access handshake. Closing connection.",
          );
          await connection.close();
          return;
        }
        const agentIdKey = agentIdToKey(handshake.agentId);

        this.logger.debug("Network access message {*}", {
          agentId: handshake.agentId,
          access: this.agentAccess.get(agentIdKey),
        });
        // Check if this agent has been denied access before
        if (this.agentAccess.get(agentIdKey) === false) {
          this.logger.warn(
            "Previously rejected agent is trying to access network again. Closing connection without network access check. {*}",
            { agentId: handshake.agentId },
          );
          return await connection.close();
        }

        const accessGranted = await this.networkAccessHandler(
          handshake.agentId,
          handshake.networkAccessBytes,
        );
        this.agentAccess.set(agentIdKey, accessGranted);
        if (accessGranted) {
          this.peerToAgent.set(connection.remotePeer, handshake.agentId);
          this.agentToPeer.set(agentIdKey, connection.remotePeer);
        }
        this.logger.info("Access {*}", {
          remoteId: connection.remotePeer,
          accessGranted,
        });
        if (!accessGranted) {
          this.logger.warn("Invalid network access bytes. Closing connection.");
          await connection.close();
        }
      },
      { once: true },
    );
  };

  private onAgentsConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming stream {*}`, {
      CURRENT_AGENTS_PROTOCOL,
      remoteId: connection.remotePeer,
    });
    const agentId = this.peerToAgent.get(connection.remotePeer);
    if (!agentId || this.agentAccess.get(agentIdToKey(agentId)) !== true) {
      this.logger.warn(
        "Remote peer tried to open an agents stream without being granted access. Closing connection. {*}",
        { remotePeerId: connection.remotePeer },
      );
      await connection.close();
      return;
    }

    const decoder = new FrameDecoder();
    stream.addEventListener("message", async (message) => {
      const chunk =
        message.data instanceof Uint8Array
          ? message.data
          : message.data.subarray();
      for (const msg of decoder.feed(chunk)) {
        this.logger.debug(
          `Incoming message on stream ${CURRENT_AGENTS_PROTOCOL} {*}`,
          { byteLength: msg.byteLength },
        );
        await this.agentsReceivedCallback(agentId, msg);
      }
    });
  };

  private onMessageConnect = async (stream: Stream, connection: Connection) => {
    if (!this.messageHandler) {
      throw new Error(
        "Handling message protocol without a message handler configured",
      );
    }
    // Assign to another variable to preserve that `messageHandler` is defined.
    const messageHandler = this.messageHandler;
    this.logger.info(`Incoming stream {*}`, {
      CURRENT_MESSAGE_PROTOCOL,
      remoteId: connection.remotePeer,
    });
    const agentId = this.peerToAgent.get(connection.remotePeer);
    if (!agentId || this.agentAccess.get(agentIdToKey(agentId)) !== true) {
      this.logger.warn(
        "Remote peer tried to open a message stream without being granted access. Closing connection. {*}",
        { remotePeerId: connection.remotePeer },
      );
      await connection.close();
      return;
    }

    const decoder = new FrameDecoder();
    stream.addEventListener("message", async (message) => {
      const chunk =
        message.data instanceof Uint8Array
          ? message.data
          : message.data.subarray();
      for (const msg of decoder.feed(chunk)) {
        this.logger.debug(
          `Incoming message on stream ${CURRENT_MESSAGE_PROTOCOL} {*}`,
          { byteLength: msg.byteLength },
        );
        messageHandler(agentId, msg);
      }
    });
  };
}
