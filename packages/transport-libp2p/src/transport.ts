import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import type { Libp2p } from "libp2p";
import { createLibp2p } from "libp2p";
import { FrameDecoder } from "./frame.js";
import { NetworkAccessHandshake } from "./proto/access.js";
import type {
  AgentId,
  IAgentsReceivedCallback,
  IMessageHandler,
  INetworkAccessHandler,
  ITransport,
} from "./types/index.js";

export interface TransportOptions {
  addrs?: string[];
  id?: string;
}

// Stable string key for an AgentId (Uint8Array has no value equality in JS).
export const agentIdKey = (agentId: AgentId): string =>
  agentId.reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");

/**
 * Identifier for the current network access protocol in Peerkit.
 *
 * This protocol expects the network access bytes to be transmitted as
 * the only message. Based on validity of the bytes, access is granted
 * or denied.
 */
export const CURRENT_ACCESS_PROTOCOL = "/peerkit/access/v1";

/**
 * Identifier for the current messaging protocol in Peerkit.
 *
 * Once access has been granted through a stream with the access protocol,
 * a new stream with this protocol can be opened to start sending messages.
 */
export const CURRENT_MESSAGE_PROTOCOL = "/peerkit/message/v1";

/**
 * The official peerkit transport based on Libp2p.
 */
export class TransportLibp2p implements ITransport {
  private libp2p: Libp2p;
  private logger: Logger;
  private networkAccessHandler?: INetworkAccessHandler;
  private messageHandler?: IMessageHandler;
  private _agentsReceivedHandler?: IAgentsReceivedCallback;

  // AgentId-keyed state (populated in Phase 2).
  private peerToAgent: Map<PeerId, AgentId> = new Map();
  // true = granted, false = denied. Both entries are sticky for the session.
  private _agentAccess: Map<string, boolean> = new Map();

  // Kept for the message-gate until Phase 2 rewires access handling.
  private peerAccessMap: Map<PeerId, boolean> = new Map();

  constructor(
    libp2p: Libp2p,
    agentsReceivedCallback: IAgentsReceivedCallback,
    networkAccessHandler: INetworkAccessHandler,
    messageHandler?: IMessageHandler,
    options?: TransportOptions,
  ) {
    libp2p.handle(CURRENT_ACCESS_PROTOCOL, this.onAccessConnect);
    if (messageHandler) {
      // Regular node that will handle messages. Relay nodes don't handle messages.
      libp2p.handle(CURRENT_MESSAGE_PROTOCOL, this.onMessageConnect);
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
    options?: TransportOptions,
  ): Promise<TransportLibp2p> {
    const libp2pNode = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      addresses: {
        listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0"],
      },
    });
    await libp2pNode.start();
    return new TransportLibp2p(
      libp2pNode,
      agentsReceivedCallback,
      networkAccessHandler,
      messageHandler,
      options,
    );
  }

  static async createRelay(
    agentsReceivedCallback: IAgentsReceivedCallback,
    networkAccessHandler: INetworkAccessHandler,
    options?: TransportOptions,
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

  async connect(_agentId: AgentId): Promise<void> {
    // Phase 3
    throw new Error("Not implemented");
  }

  async send(_agentId: AgentId, _data: Uint8Array): Promise<void> {
    // Phase 3
  }

  async sendAgents(_agentId: AgentId, _data: Uint8Array): Promise<void> {
    // Phase 4
  }

  async stop(): Promise<void> {
    return this.libp2p.stop();
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

        const handler = this.networkAccessHandler;
        const accessGranted = handler
          ? handler(handshake.agentId, handshake.networkAccessBytes)
          : false;
        this.peerAccessMap.set(connection.remotePeer, accessGranted);
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
    if (!this.peerAccessMap.get(connection.remotePeer)) {
      this.logger.warn(
        "Remote peer tried to open a message stream without requesting access. Closing connection. {*}",
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
        // Phase 2 will supply the real AgentId from peerToAgent.
        const fromAgent =
          this.peerToAgent.get(connection.remotePeer) ?? new Uint8Array(0);
        messageHandler(fromAgent, msg);
      }
    });
  };
}
