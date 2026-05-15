import type {
  Connection,
  PeerId,
  Stream,
  StreamMessageEvent,
} from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { getLogger, type Logger } from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type {
  AgentsReceivedCallback,
  MessageHandler,
  NetworkAccessHandler,
  ITransport,
  IStream,
  NetworkAccessBytes,
  NodeId,
  RelayAddress,
  ConnectedToRelayCallback,
  NodeAddress,
  PeerConnectedCallback,
  CustomStreamCreatedCallback,
} from "@peerkit/api";
import { CustomStream } from "./custom-stream.js";
import { createTransportMetrics, type TransportMetrics } from "./metrics.js";

/**
 * Options shared by node and relay constructions.
 */
export interface TransportOptionsBase {
  /**
   * Optional human-readable identifier attached to log records.
   */
  id?: string;
  /**
   * Network access bytes sent in handshake responses (and outbound handshakes
   * for nodes).
   *
   * Defaults to `new Uint8Array([0])` — an empty array breaks the
   * counter-handshake because `.send()` would be a no-op.
   */
  networkAccessBytes?: NetworkAccessBytes;
  /**
   * Handler invoked for every incoming access handshake. Returns true to grant
   * access, false to deny. Denials are sticky for the session.
   */
  networkAccessHandler: NetworkAccessHandler;
  /**
   * Called when an inbound peer completes the access handshake. Fire-and-forget.
   */
  peerConnectedCallback: PeerConnectedCallback;
  /**
   * Called when agent-info bytes have been received from a peer.
   */
  agentsReceivedCallback: AgentsReceivedCallback;
}

/**
 * Options for relay-mode transports. Relays do not handle messages.
 */
export type RelayOptions = TransportOptionsBase;

/**
 * Options for regular node transports. Nodes handle access, agents, and messages.
 */
export interface NodeOptions extends TransportOptionsBase {
  /**
   * Handler for incoming application messages.
   */
  messageHandler: MessageHandler;
  /**
   * Callbacks for custom protocol streams.
   *
   * The connection to peers is multi-plexed. Data streams can be opened
   * and closed at runtime. Any kind of data can be sent over a stream,
   * defined by a protocol.
   *
   * Callbacks must be registered when constructing the transport and cannot
   * be added or removed dynamically.
   *
   * Call {@link TransportLibp2p.createStream} to create a stream for a
   * specific protocol and peer. On the remote side, the corresponding
   * callback will be executed.
   */
  customStreamCreatedCallbacks?: Record<string, CustomStreamCreatedCallback>;
  /**
   * Called when the bootstrap connection to a relay is complete.
   */
  connectedToRelayCallback?: ConnectedToRelayCallback;
  /**
   * Timeout in milliseconds for the outbound access handshake response.
   * Defaults to 10_000 ms.
   */
  handshakeTimeoutMs?: number;
}

/**
 * Identifier for the current network access protocol in peerkit.
 *
 * **Stream lifecycle**: opened by the initiator on every new connection.
 * A request/response exchange, concluded by an ACK byte by the initiator:
 * 1. Initiator sends its `NetworkAccessBytes`.
 * 2. Responder evaluates them and sends back its own `NetworkAccessBytes`.
 *    It registers another listener to receive the final ACK byte and
 *    then closes its write end.
 * 3. Initiator receives the response and evaluates it. If valid, it sends
 *    the ACK byte and then closes its write end.
 *
 * The stream is fully reclaimed once both ends close. The connection remains open.
 *
 * Network access bytes must not exceed 256 KiB in size.
 */
export const CURRENT_ACCESS_PROTOCOL = "/peerkit/access/v1";

/**
 * Identifier for the current agents protocol in peerkit.
 *
 * **Stream lifecycle**: opened by whichever side wants to send agent infos.
 * One-directional per exchange:
 * 1. Sender sends a single framed payload, then closes its write end.
 * 2. Receiver never writes back, so it closes its write end immediately on open.
 *
 * A new stream is opened for each {@link ITransport.sendAgents} call.
 */
export const CURRENT_AGENTS_PROTOCOL = "/peerkit/agents/v1";

/**
 * Identifier for the current messaging protocol in peerkit.
 *
 * **Stream lifecycle**: opened by the first peer to send a message on a given
 * connection. Bidirectional and long-lived:
 * 1. Opener sends a framed message and registers a reply listener on the same stream.
 * 2. Both peers write to the same stream for the lifetime of the connection.
 *
 * The stream is reused across messages; it is not closed after each send.
 * Only available on nodes, relays do not register this protocol.
 */
export const CURRENT_MESSAGE_PROTOCOL = "/peerkit/message/v1";

const ACCESS_HANDSHAKE_COMPLETE_ACK_BYTE = 1;

/**
 * Platform-agnostic libp2p transport for peerkit.
 *
 * Owns the protocol logic (access handshake, agents, messages) on top of a
 * caller-supplied Libp2p instance. Platform-specific packages (e.g.
 * `@peerkit/transport-libp2p-nodejs`) build the libp2p instance with the
 * appropriate transports/services and pass it in.
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
  private peerConnectedCallback?: PeerConnectedCallback;
  private readonly metrics: TransportMetrics;

  // Keyed by NodeId string. true = granted, false = denied.
  // Both entries are sticky for the session.
  private nodeAccess: Map<string, boolean> = new Map();

  constructor(libp2p: Libp2p, options: NodeOptions | RelayOptions) {
    this.localNetworkAccessBytes =
      options?.networkAccessBytes ?? new Uint8Array([0]); // If set to new Uint8Array(0), .send doesn't send anything, which confuses the hell out of everyone
    this.handshakeTimeoutMs =
      (options &&
        "handshakeTimeoutMs" in options &&
        options.handshakeTimeoutMs) ||
      10_000;
    this.agentsReceivedCallback = options.agentsReceivedCallback;
    this.networkAccessHandler = options.networkAccessHandler;

    // Initialize libp2p and logger before registering protocol handlers, so
    // arrow-field callbacks (onAccessConnect, onAgentsConnect, onMessageConnect)
    // can rely on this.logger even if the caller passed an already-started libp2p.
    this.libp2p = libp2p;
    this.logger = getLogger(["peerkit", "transport"]).with({
      peerId: libp2p.peerId,
      id: options?.id,
    });

    libp2p.handle(CURRENT_ACCESS_PROTOCOL, this.onAccessConnect);
    libp2p.handle(CURRENT_AGENTS_PROTOCOL, this.onAgentsConnect);
    if ("messageHandler" in options) {
      // Regular node that will handle messages. Relay nodes don't handle messages.
      libp2p.handle(CURRENT_MESSAGE_PROTOCOL, this.onMessageConnect);
      this.messageHandler = options.messageHandler;
    }

    // Register custom stream callbacks
    if (
      "customStreamCreatedCallbacks" in options &&
      options.customStreamCreatedCallbacks
    ) {
      for (const [protocol, customStreamCreatedCallback] of Object.entries(
        options.customStreamCreatedCallbacks,
      )) {
        libp2p.handle(protocol, async (stream, connection) => {
          this.logger.info(`Incoming custom stream {*}`, {
            remoteId: connection.remotePeer,
            protocol,
          });
          // Make sure that access has been granted before. If not,
          // `accessCheck` will throw and not call the callback.
          await this.accessCheck(protocol, connection);
          const customStream = new CustomStream(stream);
          customStreamCreatedCallback(customStream);
        });
      }
    }

    if ("connectedToRelayCallback" in options) {
      this.connectedToRelayCallback = options.connectedToRelayCallback;
    }
    if ("peerConnectedCallback" in options) {
      this.peerConnectedCallback = options.peerConnectedCallback;
    }

    this.metrics = createTransportMetrics();
    this.logger.info("Transport created {*}", {
      addresses: libp2p.getMultiaddrs(),
      id: options?.id,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
    });
  }

  getNodeId(): NodeId {
    return this.libp2p.peerId.toString();
  }

  async connect(nodeAddress: NodeAddress): Promise<void> {
    this.logger.info("Connecting to node {*}", { nodeAddress });
    const connection = await this.libp2p.dial(multiaddr(nodeAddress));

    await this.performNetworkAccessHandshake(connection);

    // Connection to peer established, run callback.
    // A failed access check by either side will close the connection.
    if (this.peerConnectedCallback) {
      this.peerConnectedCallback(connection.remotePeer.toString()).catch(
        (error) => {
          this.logger.error("PeerConnectedCallback produced an error {*}", {
            error,
          });
        },
      );
    }
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
    const stream = await connections[0].newStream(CURRENT_AGENTS_PROTOCOL);
    stream.send(encodeFrame(data));
    await stream.close();
  }

  async send(nodeId: NodeId, data: Uint8Array): Promise<void> {
    const connections = this.libp2p.getConnections(peerIdFromString(nodeId));
    if (connections.length === 0 || !connections[0]) {
      this.logger.error("No open connection to node when trying to send {*}", {
        nodeId,
      });
      throw new Error("No open connection when trying to send");
    }
    // Prefer a direct connection; fall back to a relayed one.
    const connection = connections.find((c) => c.direct) ?? connections[0];
    let stream = connection.streams.find(
      (stream) => stream.protocol === CURRENT_MESSAGE_PROTOCOL,
    );
    if (!stream || stream.status !== "open") {
      stream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);
      // Register a listener so the remote end can write back on this stream.
      if (this.messageHandler) {
        const messageHandler = this.messageHandler;
        const decoder = new FrameDecoder();
        const nodeId = connection.remotePeer.toString();
        stream.addEventListener("message", async (message) => {
          const chunk = message.data.subarray();
          for (const msg of decoder.feed(chunk)) {
            this.metrics.bytesTotal.add(msg.byteLength, {
              direction: "received",
            });
            await messageHandler(nodeId, msg);
          }
        });
      }
    }
    stream.send(encodeFrame(data));
    this.metrics.bytesTotal.add(data.byteLength, {
      direction: "sent",
    });
  }

  isDirectConnection(nodeId: NodeId): boolean {
    return this.libp2p
      .getConnections(peerIdFromString(nodeId))
      .some((c) => c.direct);
  }

  async disconnect(nodeId: NodeId): Promise<void> {
    const connections = this.libp2p.getConnections(peerIdFromString(nodeId));
    if (!connections.length) {
      throw new Error(
        `No open connection to peer ${nodeId}. Ensure the peer is connected before calling disconnect().`,
      );
    }
    const results = await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn(`Disconnecting failed {*}`, {
          nodeId,
          error: result.reason,
        });
      }
    }
  }

  async createStream(nodeId: NodeId, protocol: string): Promise<IStream> {
    const connections = this.libp2p.getConnections(peerIdFromString(nodeId));
    if (connections.length === 0 || !connections[0]) {
      this.logger.error("No open connection to node when trying to send {*}", {
        nodeId,
      });
      throw new Error("No open connection when trying to send");
    }

    // Prefer a direct connection; fall back to a relayed one.
    const connection = connections.find((c) => c.direct) ?? connections[0];
    const stream = await connection.newStream(protocol);
    const customStream = new CustomStream(stream);
    return customStream;
  }

  async shutDown(): Promise<void> {
    return this.libp2p.stop();
  }

  /**
   * Connect to a list of relay addresses in parallel. Failures are logged but
   * do not throw. On success, {@link ConnectedToRelayCallback} fires once the
   * dialable relay-circuit address has been received.
   *
   * Fire-and-forget. Platform factories typically call this during bootstrap.
   */
  async connectToRelays(relays: RelayAddress[]): Promise<void> {
    const localPeerId = this.libp2p.peerId.toString();
    // Connect to all relays in parallel
    await Promise.allSettled(
      relays.map((relay) =>
        this.connectToRelay(relay)
          .then((relayNodeId) => {
            this.logger.info("Connected to relay {*}", { relay, relayNodeId });
            if (this.connectedToRelayCallback) {
              const connectedToRelayCallback = this.connectedToRelayCallback;
              const relayId = relayNodeId.toString();
              // Register event listener for when the dialable relay address has been
              // received through the identify protocol.
              this.libp2p.addEventListener(
                "self:peer:update",
                (evt) => {
                  const relayAddress = evt.detail.peer.addresses.find(
                    (address) =>
                      address.multiaddr
                        .toString()
                        .includes(`/p2p/${relayId}/p2p-circuit`),
                  );
                  if (relayAddress) {
                    // Append the local peer ID so the address is fully dialable:
                    // /…/p2p/<relayId>/p2p-circuit/p2p/<localId>
                    connectedToRelayCallback(
                      `${relayAddress.multiaddr.toString()}/p2p/${localPeerId}`,
                      relayId,
                    ).catch((error) => {
                      this.logger.error(
                        "ConnectedToRelayCallback produced an error {*}",
                        { error },
                      );
                    });
                  } else {
                    this.logger.error(
                      "Received peer update event but found no relay address.",
                    );
                  }
                },
                {
                  once: true,
                },
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

    const relayPeerId = await this.performNetworkAccessHandshake(connection);
    return relayPeerId;
  }

  private async performNetworkAccessHandshake(
    connection: Connection,
  ): Promise<PeerId> {
    // Initiate access handshake
    const stream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);

    // Send network access bytes to remote.
    stream.send(this.localNetworkAccessBytes);

    // Await remote's network access bytes with a timeout.
    const responseBytes = await new Promise<Uint8Array>((resolve, reject) => {
      // Close stream and throw error after handshake timed out.
      const timer = setTimeout(async () => {
        stream
          .close()
          .catch((error) =>
            this.logger.info(
              `Error when closing ${CURRENT_ACCESS_PROTOCOL} stream after handshake timeout {*}`,
              { error },
            ),
          );
        reject(new Error("Access handshake response timed out"));
      }, this.handshakeTimeoutMs);

      // Throw error when remote denies access.
      stream.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          stream
            .close()
            .catch((error) =>
              this.logger.info(
                `Error when closing ${CURRENT_ACCESS_PROTOCOL} stream after remote denied access {*}`,
                { error },
              ),
            );
          reject(new Error("Access denied by remote"));
        },
        { once: true },
      );

      // Remote sends their network access bytes.
      stream.addEventListener(
        "message",
        (message) => {
          clearTimeout(timer);
          resolve(message.data.subarray());
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
      this.logger.info("Access granted to remote {*}", {
        peerId: connection.remotePeer,
      });
      // connection.close() gracefully closes all streams, making
      // the remoteCloseWrite event indistinguishable from a grant-path
      // stream close. An explicit ACK message avoids the false positive.

      // Sending ACK byte to confirm access
      stream.send(new Uint8Array([ACCESS_HANDSHAKE_COMPLETE_ACK_BYTE]));
      await stream.close();
      return connection.remotePeer;
    } else {
      this.logger.warn("Access denied to remote. Closing connection. {*}", {
        peerId: connection.remotePeer,
      });
      await connection.close();
      throw new Error("Access denied to remote");
    }
  }

  // Handler for incoming network access streams, when a remote initiates the
  // network access handshake.
  private onAccessConnect = async (stream: Stream, connection: Connection) => {
    this.logger.info(`Incoming ${CURRENT_ACCESS_PROTOCOL} stream {*}`, {
      remoteId: connection.remotePeer,
    });
    stream.addEventListener(
      "message",
      async (message) => {
        const networkAccessBytes = message.data.subarray();
        const remoteNodeId = connection.remotePeer.toString();

        this.logger.debug(
          `Incoming message on stream ${CURRENT_ACCESS_PROTOCOL} {*}`,
          {
            remoteId: connection.remotePeer,
            access: this.nodeAccess.get(remoteNodeId),
          },
        );
        // Check if this peer has been denied access before
        if (this.nodeAccess.get(remoteNodeId) === false) {
          this.logger.warn(
            "Previously denied peer is trying to access network again. Closing connection. {*}",
            { remoteId: connection.remotePeer },
          );
          await connection.close();
          return;
        }

        const accessGranted = await this.networkAccessHandler(
          remoteNodeId,
          networkAccessBytes,
        );
        this.nodeAccess.set(remoteNodeId, accessGranted);
        this.logger.info("Access {*}", {
          remoteId: connection.remotePeer,
          accessGranted,
        });
        if (!accessGranted) {
          this.logger.warn("Invalid network access bytes. Closing connection.");
          await connection.close();
          return;
        }

        // Register an event listener that notifies about the completed handshake.
        if (this.peerConnectedCallback) {
          const peerConnectedCallback = this.peerConnectedCallback;
          // Listening for the remoteCloseWrite event here is not
          // reliable, as it is indistinguishable from a grant-path
          // stream close. An explicit ACK message brings clarity.
          stream.addEventListener(
            "message",
            async (message) => {
              const ackMessage = message.data.subarray();
              // Check if ACK byte matches
              if (
                ackMessage.length === 1 &&
                ackMessage[0] === ACCESS_HANDSHAKE_COMPLETE_ACK_BYTE
              ) {
                peerConnectedCallback(remoteNodeId).catch((error) => {
                  this.logger.error(
                    "PeerConnectedCallback produced an error {*}",
                    { error },
                  );
                });
              } else {
                this.logger.error(
                  "Unexpected access handshake acknowledge message {*}",
                  { remoteNodeId, message },
                );
                await connection.close();
              }
            },
            { once: true },
          );
        }

        stream.send(this.localNetworkAccessBytes);
        // Both ends of a stream must be closed for it to be fully released.
        await stream.close();
      },
      { once: true },
    );
  };

  // Handler for incoming agents streams
  private onAgentsConnect = async (stream: Stream, connection: Connection) => {
    await this.accessCheck(CURRENT_AGENTS_PROTOCOL, connection);

    const decoder = new FrameDecoder();
    const onMessage = async (message: StreamMessageEvent) => {
      const chunk = message.data.subarray();
      // Either this is already the complete message or the partial message
      // is buffered in the decoder and will be completed with one of the
      // following message events.
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
    };
    stream.addEventListener("message", onMessage);
    // Close this end of the stream when the remote has closed their end stream.
    stream.addEventListener("remoteCloseWrite", async () => {
      // Both ends of a stream must be closed for it to be fully released.
      await stream.close();
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

    await this.accessCheck(CURRENT_MESSAGE_PROTOCOL, connection);

    const decoder = new FrameDecoder();
    stream.addEventListener("message", async (message) => {
      const chunk = message.data.subarray();
      const remoteNodeId = connection.remotePeer.toString();
      for (const msg of decoder.feed(chunk)) {
        this.logger.debug(
          `Incoming message on stream ${CURRENT_MESSAGE_PROTOCOL} {*}`,
          { peerId: connection.remotePeer, byteLength: msg.byteLength },
        );
        this.metrics.bytesTotal.add(msg.byteLength, {
          direction: "received",
        });
        await messageHandler(remoteNodeId, msg);
      }
    });
  };

  private accessCheck = async (protocol: string, connection: Connection) => {
    this.logger.info(`Incoming ${protocol} stream {*}`, {
      remoteId: connection.remotePeer,
    });
    const nodeIdString = connection.remotePeer.toString();
    if (this.nodeAccess.get(nodeIdString) !== true) {
      this.logger.warn(
        `Remote peer tried to open a ${protocol} stream without being granted access. Closing connection. {*}`,
        { remoteId: connection.remotePeer },
      );
      await connection.close();
      throw new Error(
        `Remote peer tried to open a ${protocol} stream without being granted access`,
      );
    }
  };
}
