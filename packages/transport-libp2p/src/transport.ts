import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
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
  ConnectedToRelayCallback,
  NodeAddress,
} from "@peerkit/interface";

export interface RelayOptions {
  addrs?: string[];
  id?: string;
  /**
   * Network access bytes sent in the counter-handshake response to connecting peers.
   */
  networkAccessBytes?: NetworkAccessBytes;
  /**
   * Callback when agent infos have been received
   */
  agentsReceivedCallback: AgentsReceivedCallback;
  /**
   * Handler for incoming network access streams
   */
  networkAccessHandler: NetworkAccessHandler;
}

export interface NodeOptions {
  addrs?: string[];
  id?: string;
  /**
   * Network access bytes sent to relays during bootstrap handshake and in counter-handshake responses.
   */
  networkAccessBytes?: NetworkAccessBytes;
  /**
   * Callback when connection to a relay has been completed
   */
  connectedToRelayCallback?: ConnectedToRelayCallback;
  /**
   * Call when agent infos have been received
   */
  agentsReceivedCallback: AgentsReceivedCallback;
  /**
   * Handler for incoming network access streams
   */
  networkAccessHandler: NetworkAccessHandler;
  /**
   * Handler for incoming message streams
   */
  messageHandler?: MessageHandler;
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
  private connectedToRelayCallback?: ConnectedToRelayCallback;

  // Keyed by NodeId string. true = granted, false = denied.
  // Both entries are sticky for the session.
  private nodeAccess: Map<string, boolean> = new Map();

  constructor(libp2p: Libp2p, options: NodeOptions | RelayOptions) {
    this.localNetworkAccessBytes =
      options?.networkAccessBytes ?? new Uint8Array([0]); // If set to new Uint8Array(0), .send doesn't send anything confuses the hell out of everyone
    this.handshakeTimeoutMs =
      (options &&
        "handshakeTimeoutMs" in options &&
        options.handshakeTimeoutMs) ||
      10_000;
    this.agentsReceivedCallback = options.agentsReceivedCallback;
    this.networkAccessHandler = options.networkAccessHandler;

    libp2p.handle(CURRENT_ACCESS_PROTOCOL, this.onAccessConnect);
    libp2p.handle(CURRENT_AGENTS_PROTOCOL, this.onAgentsConnect);
    if ("messageHandler" in options) {
      // Regular node that will handle messages. Relay nodes don't handle messages.
      libp2p.handle(CURRENT_MESSAGE_PROTOCOL, this.onMessageConnect);
      this.messageHandler = options.messageHandler;
    }

    if ("connectedToRelayCallback" in options) {
      this.connectedToRelayCallback = options.connectedToRelayCallback;
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
  static async createNode(options: NodeOptions): Promise<TransportLibp2p> {
    const libp2pNode = await createLibp2p({
      // Circuit relay transport enables connecting to peers through connected relays.
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), dcutr: dcutr() },
      addresses: {
        listen: options?.addrs ?? [
          "/p2p-circuit", // p2p-circuit enables listening for relayed connections
          "/ip4/0.0.0.0/tcp/0",
          "/ip6/::/tcp/0",
        ],
      },
    });
    await libp2pNode.start();
    const transport = new TransportLibp2p(libp2pNode, options);
    // Connect to all provided relays.
    if (options?.bootstrapRelays?.length) {
      await transport.connectToRelays(options.bootstrapRelays);
    }
    return transport;
  }

  /**
   * Create a relay node. Handles access and agents protocols; does not handle messages.
   */
  static async createRelay(options: RelayOptions): Promise<TransportLibp2p> {
    const libp2pNode = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // Circuit relay server enables relay functionality
      services: { relay: circuitRelayServer(), identify: identify() },
      addresses: {
        listen: options?.addrs ?? ["/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0"],
      },
    });
    await libp2pNode.start();
    return new TransportLibp2p(libp2pNode, options);
  }

  getNodeId(): NodeId {
    return this.libp2p.peerId.toString();
  }

  async connect(
    nodeAddress: NodeAddress,
    _bytes: NetworkAccessBytes,
  ): Promise<void> {
    await this.libp2p.dial(multiaddr(nodeAddress));
  }

  async sendAgents(nodeId: NodeId, data: Uint8Array): Promise<void> {
    this.logger.debug("Sending agents {*}", { nodeId });
    const libp2pPeerId = peerIdFromString(nodeId);
    const connections = this.libp2p.getConnections(libp2pPeerId);
    if (!connections[0]) {
      throw new Error(
        `No open connection to peer ${nodeId}. Ensure the peer is connected before calling sendAgents().`,
      );
    }
    const stream = await connections[0].newStream(CURRENT_AGENTS_PROTOCOL, {
      runOnLimitedConnection: true,
    });
    stream.send(encodeFrame(data));
    await stream.close();
  }

  async send(_nodeId: NodeId, _data: Uint8Array): Promise<void> {}

  isDirectConnection(nodeId: NodeId): boolean {
    return this.libp2p
      .getConnections(peerIdFromString(nodeId))
      .some((c) => c.direct);
  }

  async shutDown(): Promise<void> {
    return this.libp2p.stop();
  }

  private async connectToRelays(relays: RelayAddress[]) {
    // Connect to all relays in parallel
    await Promise.allSettled(
      relays.map((relay) =>
        this.connectToRelay(relay)
          .then((relayNodeId) => {
            this.logger.info("Connected to relay {*}", { relay });
            if (this.connectedToRelayCallback) {
              const connectedToRelayCallback = this.connectedToRelayCallback;
              // Register event listener for when the dialable relay address has been
              // received through the identify protocol.
              this.libp2p.addEventListener(
                "self:peer:update",
                (evt) => {
                  const relayAddress = evt.detail.peer.addresses.find(
                    (address) =>
                      address.multiaddr
                        .getComponents()
                        .some((c) => c.name === "p2p-circuit"),
                  );
                  if (relayAddress) {
                    connectedToRelayCallback(
                      relayAddress.multiaddr.toString(),
                      relayNodeId.toString(),
                    );
                  } else {
                    this.logger.error(
                      "Received peer update event but found no relay address.",
                    );
                  }
                },
                { once: true },
              );
            }
          })
          .catch((error) => {
            this.logger.error("Failed to connect to relay {*}", {
              relay: relay,
              reason: error,
            });
          }),
      ),
    );
  }

  private async connectToRelay(relay: RelayAddress): Promise<PeerId> {
    const addr = multiaddr(relay);
    this.logger.info("Connecting to relay {*}", { relay });
    const connection = await this.libp2p.dial(addr);

    // Perform access handshake, send network access bytes to relay.
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

    const nodeIdString = connection.remotePeer.toString();
    const accessGranted = await this.networkAccessHandler(
      connection.remotePeer.toString(),
      responseBytes,
    );
    this.nodeAccess.set(nodeIdString, accessGranted);
    if (accessGranted) {
      this.logger.info("Access granted to relay {*}", {
        peerId: connection.remotePeer,
      });
      return connection.remotePeer;
    } else {
      this.logger.warn("Access denied to relay. Closing connection. {*}", {
        peerId: connection.remotePeer,
      });
      await connection.close();
      throw new Error("Access denied to relay");
    }
  }

  // Handler for incoming network access streams
  private onAccessConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming ${CURRENT_ACCESS_PROTOCOL} stream {*}`, {
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

        this.logger.debug("Access message {*}", {
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
    this.logger.info(`Incoming ${CURRENT_AGENTS_PROTOCOL} stream {*}`, {
      remoteId: connection.remotePeer,
    });
    const nodeIdString = connection.remotePeer.toString();
    if (this.nodeAccess.get(nodeIdString) !== true) {
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
    this.logger.info(`Incoming ${CURRENT_MESSAGE_PROTOCOL} stream {*}`, {
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
