import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Stream } from "@libp2p/interface";
import { peerIdFromString as nodeIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createLibp2p } from "libp2p";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type {
  AgentsReceivedCallback,
  MessageHandler,
  NetworkAccessHandler,
  ITransport,
  NetworkAccessBytes,
  NodeId,
  RelayAddress,
} from "@peerkit/interface";

export interface RelayOptions {
  addrs?: string[];
  id?: string;
  /**
   * Network access bytes sent in the counter-handshake response to connecting peers.
   */
  networkAccessBytes?: NetworkAccessBytes;
}

export interface NodeOptions {
  addrs?: string[];
  id?: string;
  /**
   * Network access bytes sent to relays during bootstrap handshake and in counter-handshake responses.
   */
  networkAccessBytes?: NetworkAccessBytes;
  /**
   * Relay addresses to connect to at startup. Format: {@link @multiformats/multiaddr!Multiaddr}
   */
  bootstrapRelays?: RelayAddress[];
  /**
   * Timeout in milliseconds for the outbound access handshake response. Defaults to 10 000 ms.
   */
  handshakeTimeoutMs?: number;
}

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
  private localNetworkAccessBytes: NetworkAccessBytes;
  private handshakeTimeoutMs: number;
  private agentsReceivedCallback: AgentsReceivedCallback;
  private networkAccessHandler: NetworkAccessHandler;
  private messageHandler?: MessageHandler;

  // Keyed by NodeId string. true = granted, false = denied.
  // Both entries are sticky for the session.
  private nodeAccess: Map<string, boolean> = new Map();

  constructor(
    libp2p: Libp2p,
    agentsReceivedCallback: AgentsReceivedCallback,
    networkAccessHandler: NetworkAccessHandler,
    messageHandler?: MessageHandler,
    options?: NodeOptions | RelayOptions,
  ) {
    this.localNetworkAccessBytes =
      options?.networkAccessBytes ?? new Uint8Array([0]); // If set to new Uint8Array(0), .send doesn't send anything confuses the hell out of everyone
    this.handshakeTimeoutMs =
      (options &&
        "handshakeTimeoutMs" in options &&
        options.handshakeTimeoutMs) ||
      10_000;
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
      handshakeTimeoutMs: this.handshakeTimeoutMs,
    });
  }

  /**
   * Create a regular node. Handles all three protocols: access, agents, and messages.
   * The caller must invoke {@link sendAgents} explicitly to distribute agent-info
   * (e.g. after bootstrap or when local agent-info changes).
   */
  static async create(
    agentsReceivedCallback: AgentsReceivedCallback,
    networkAccessHandler: NetworkAccessHandler,
    messageHandler: MessageHandler,
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
      await transport.connectToRelays(options.bootstrapRelays);
    }
    return transport;
  }

  /**
   * Create a relay node. Handles access and agents protocols; does not handle messages.
   */
  static async createRelay(
    agentsReceivedCallback: AgentsReceivedCallback,
    networkAccessHandler: NetworkAccessHandler,
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
    return new TransportLibp2p(
      libp2pNode,
      agentsReceivedCallback,
      networkAccessHandler,
      undefined, // Relay nodes don't handle messages
      options,
    );
  }

  getNodeId(): NodeId {
    return this.libp2p.peerId.toString();
  }

  async connect(nodeId: NodeId, _bytes: NetworkAccessBytes): Promise<void> {
    await this.libp2p.dial(nodeIdFromString(nodeId));
  }

  async sendAgents(nodeId: NodeId, data: Uint8Array): Promise<void> {
    const libp2pPeerId = nodeIdFromString(nodeId);
    const connections = this.libp2p.getConnections(libp2pPeerId);
    if (!connections.length) {
      throw new Error(
        `No open connection to peer ${nodeId}. Ensure the peer is connected before calling sendAgents().`,
      );
    }
    const stream = await connections[0]!.newStream(CURRENT_AGENTS_PROTOCOL);
    stream.send(encodeFrame(data));
    await stream.close();
  }

  async send(_nodeId: NodeId, _data: Uint8Array): Promise<void> {}

  async shutDown(): Promise<void> {
    return this.libp2p.stop();
  }

  private async connectToRelays(relays: RelayAddress[]) {
    const results = await Promise.allSettled(
      relays.map((relay) => this.connectToRelay(relay)),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        this.logger.error("Failed to connect to relay {*}", {
          relay: relays[i],
          reason: result.reason,
        });
      }
    }
  }

  private async connectToRelay(relay: RelayAddress): Promise<void> {
    const addr = multiaddr(relay);
    this.logger.info("Connecting to relay {*}", { relay });
    const connection = await this.libp2p.dial(addr);

    // Perform access handshake
    const stream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
    stream.send(this.localNetworkAccessBytes);

    // Await access handshake response with a timeout.
    const responseBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Access handshake response timed out")),
        this.handshakeTimeoutMs,
      );
      stream.addEventListener(
        "message",
        (message) => {
          clearTimeout(timer);
          const data =
            message.data instanceof Uint8Array
              ? message.data
              : message.data.subarray();
          resolve(data);
        },
        { once: true },
      );
    });

    const peerKey = connection.remotePeer.toString();
    const accessGranted = await this.networkAccessHandler(
      connection.remotePeer.toString(),
      responseBytes,
    );
    this.nodeAccess.set(peerKey, accessGranted);
    if (accessGranted) {
      this.logger.info("Access granted {*}", {
        peerId: connection.remotePeer,
      });
    } else {
      this.logger.warn("Access denied by remote. Closing connection. {*}", {
        peerId: connection.remotePeer,
      });
      await connection.close();
    }
  }

  // Handler incoming network access streams
  private onAccessConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming access stream {*}`, {
      remoteId: connection.remotePeer,
    });
    stream.addEventListener(
      "message",
      async (message) => {
        const raw =
          message.data instanceof Uint8Array
            ? message.data
            : message.data.subarray();

        const peerKey = connection.remotePeer.toString();

        this.logger.debug("Network access message {*}", {
          remoteId: connection.remotePeer,
          access: this.nodeAccess.get(peerKey),
        });
        // Check if this peer has been denied access before
        if (this.nodeAccess.get(peerKey) === false) {
          this.logger.warn(
            "Previously rejected peer is trying to access network again. Closing connection. {*}",
            { remoteId: connection.remotePeer },
          );
          return await connection.close();
        }

        const accessGranted = await this.networkAccessHandler(
          connection.remotePeer.toString(),
          raw,
        );
        this.nodeAccess.set(peerKey, accessGranted);
        this.logger.info("Access {*}", {
          remoteId: connection.remotePeer,
          accessGranted,
        });
        if (!accessGranted) {
          this.logger.warn("Invalid network access bytes. Closing connection.");
          await connection.close();
          return;
        }
        stream.send(this.localNetworkAccessBytes);
      },
      { once: true },
    );
  };

  // Handler for incoming agents streams
  private onAgentsConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming agents stream {*}`, {
      remoteId: connection.remotePeer,
    });
    const peerKey = connection.remotePeer.toString();
    if (this.nodeAccess.get(peerKey) !== true) {
      this.logger.warn(
        "Remote peer tried to open an agents stream without being granted access. Closing connection. {*}",
        { remoteId: connection.remotePeer },
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
          { peerId: connection.remotePeer, byteLength: msg.byteLength },
        );
        await this.agentsReceivedCallback(
          connection.remotePeer.toString(),
          msg,
        );
      }
    });
  };

  // Handler for incoming message streams
  private onMessageConnect = async (stream: Stream, connection: Connection) => {
    if (!this.messageHandler) {
      throw new Error(
        "Handling message protocol without a message handler configured",
      );
    }
    // Assign to another variable to preserve that `messageHandler` is defined.
    const messageHandler = this.messageHandler;
    this.logger.info(`Incoming message stream {*}`, {
      remoteId: connection.remotePeer,
    });
    const peerKey = connection.remotePeer.toString();
    if (this.nodeAccess.get(peerKey) !== true) {
      this.logger.warn(
        "Remote peer tried to open a message stream without being granted access. Closing connection. {*}",
        { remoteId: connection.remotePeer },
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
          { peerId: connection.remotePeer, byteLength: msg.byteLength },
        );
        messageHandler(connection.remotePeer.toString(), msg);
      }
    });
  };
}
