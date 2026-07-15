import { getLogger, type Logger } from "@logtape/logtape";
import type {
  AgentsReceivedCallback,
  CustomStreamCreatedCallback,
  IStream,
  ITransport,
  MessageHandler,
  NetworkAccessBytes,
  NetworkAccessHandler,
  NodeAddress,
  NodeId,
  PeerConnectedCallback,
  PeerDisconnectedCallback,
} from "@peerkit/api";
import {
  type HandshakeChannel,
  runInitiatorHandshake,
  runResponderHandshake,
} from "@peerkit/transport-shared";
import { CustomStream } from "./custom-stream.js";
import type { IrohConnection, IrohDriver, IrohStream } from "./driver.js";
import { readMessages, writeMessage } from "./messages.js";
import { createTransportMetrics, type TransportMetrics } from "./metrics.js";

/**
 * Current peerkit network access protocol.
 *
 * The initiator opens a stream, names this protocol in the preamble, and sends
 * its access bytes. The responder replies with its own access bytes if it
 * grants access, then waits for an ack confirming the initiator granted access
 * too. Either side denying closes the whole connection.
 */
export const CURRENT_ACCESS_PROTOCOL = "/peerkit/access/v1";

/**
 * Current peerkit agents protocol.
 *
 * The sender opens a stream, names this protocol in the preamble, writes one
 * framed agent-info payload, and closes its write end. The receiver reads the
 * payload and hands it to its {@link AgentsReceivedCallback}.
 */
export const CURRENT_AGENTS_PROTOCOL = "/peerkit/agents/v1";

/**
 * Current peerkit message protocol.
 *
 * The first peer to send opens one stream, named by the preamble. It is
 * long-lived and shared for the connection's lifetime: both peers write framed
 * messages on it and read the other's via their {@link MessageHandler}. Relays
 * do not handle messages, so they do not register this protocol.
 */
export const CURRENT_MESSAGE_PROTOCOL = "/peerkit/message/v1";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Handles the body of an incoming stream after its protocol preamble has been
// read. `reader` continues from the first message after the preamble.
type StreamHandler = (
  connection: IrohConnection,
  stream: IrohStream,
  reader: AsyncGenerator<Uint8Array>,
) => Promise<void>;

export interface IrohTransportOptions {
  /** Optional human-readable identifier attached to log records. */
  id?: string;
  /**
   * Access bytes this node sends in the handshake. Defaults to
   * `new Uint8Array([0])` — an empty array would be sent as nothing and break
   * the exchange.
   */
  networkAccessBytes?: NetworkAccessBytes;
  /**
   * Decides whether an incoming peer is granted access. A denial is remembered
   * for the session and the peer is turned away on reconnect without asking again.
   */
  networkAccessHandler: NetworkAccessHandler;
  /** Called with agent-info bytes received from a peer. */
  agentsReceivedCallback: AgentsReceivedCallback;
  /**
   * Called with application messages received from a peer. Omit on relays, which
   * do not handle messages.
   */
  messageHandler?: MessageHandler;
  /** Called once a peer has completed the access handshake. Fire-and-forget. */
  peerConnectedCallback?: PeerConnectedCallback;
  /** Called when a peer disconnects. Fire-and-forget. */
  peerDisconnectedCallback?: PeerDisconnectedCallback;
  /**
   * How long to wait for the peer's handshake response, in milliseconds.
   * Defaults to 10000.
   */
  handshakeTimeoutMs?: number;
}

/**
 * Peerkit transport over iroh.
 *
 * Sits on an {@link IrohDriver} — the native binding on each platform — and adds
 * the peerkit protocols. All peerkit traffic shares one iroh connection; each
 * protocol runs on its own bi-stream, named by a framed preamble the acceptor
 * reads to route the stream. The access handshake gates every connection: until
 * it passes, no other stream is allowed.
 */
export class TransportIroh implements ITransport {
  private readonly driver: IrohDriver;
  private readonly logger: Logger;
  private readonly localNetworkAccessBytes: NetworkAccessBytes;
  private readonly networkAccessHandler: NetworkAccessHandler;
  private readonly agentsReceivedCallback: AgentsReceivedCallback;
  private readonly messageHandler?: MessageHandler;
  private readonly peerConnectedCallback?: PeerConnectedCallback;
  private readonly peerDisconnectedCallback?: PeerDisconnectedCallback;
  private readonly handshakeTimeoutMs: number;
  private readonly metrics: TransportMetrics;

  // Live connections keyed by the remote node id.
  private readonly connections = new Map<NodeId, IrohConnection>();
  // Access decisions keyed by remote node id. true = granted, false = denied.
  // Sticky for the session, so a denied peer is turned away without asking again.
  private readonly nodeAccess = new Map<NodeId, boolean>();
  // Stream handlers keyed by protocol id, chosen by each stream's preamble.
  private readonly streamHandlers = new Map<string, StreamHandler>();
  // The long-lived message stream per peer, shared for sending and receiving.
  private readonly messageStreams = new Map<NodeId, IrohStream>();

  constructor(driver: IrohDriver, options: IrohTransportOptions) {
    this.driver = driver;
    this.localNetworkAccessBytes =
      options.networkAccessBytes ?? new Uint8Array([0]);
    this.networkAccessHandler = options.networkAccessHandler;
    this.agentsReceivedCallback = options.agentsReceivedCallback;
    this.messageHandler = options.messageHandler;
    this.peerConnectedCallback = options.peerConnectedCallback;
    this.peerDisconnectedCallback = options.peerDisconnectedCallback;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    // Built here, not at module scope, so the app's MeterProvider is in effect.
    this.metrics = createTransportMetrics();
    this.logger = getLogger(["peerkit", "transport"]).with({
      nodeId: driver.getNodeId(),
      id: options.id,
    });

    this.streamHandlers.set(CURRENT_ACCESS_PROTOCOL, this.handleAccessStream);
    this.streamHandlers.set(CURRENT_AGENTS_PROTOCOL, this.handleAgentsStream);
    // Relays do not handle messages, so only register the protocol when a
    // message handler is configured.
    if (this.messageHandler) {
      this.streamHandlers.set(
        CURRENT_MESSAGE_PROTOCOL,
        this.handleMessageStream,
      );
    }

    void this.acceptConnections();
    this.logger.info("Transport created {*}", { nodeId: driver.getNodeId() });
  }

  getNodeId(): NodeId {
    return this.driver.getNodeId();
  }

  getListenAddresses(): string[] {
    return [this.driver.getNodeAddress()];
  }

  async connect(nodeAddresses: NodeAddress[]): Promise<void> {
    if (nodeAddresses.length === 0) {
      throw new Error("connect called with an empty list of addresses");
    }
    const connection = await this.dial(nodeAddresses);
    const remote = connection.remoteNodeId();
    this.registerConnection(connection);
    // Accept streams the peer opens back to us over the same connection.
    void this.acceptStreams(connection);

    await this.performAccessHandshake(connection);
    this.firePeerConnected(remote);
  }

  isConnected(nodeId: NodeId): boolean {
    return this.connections.has(nodeId);
  }

  getConnectedPeers(): NodeId[] {
    return [...this.connections.keys()];
  }

  isDirectConnection(nodeId: NodeId): boolean {
    return this.connections.get(nodeId)?.isDirect() ?? false;
  }

  async disconnect(nodeId: NodeId): Promise<void> {
    const connection = this.requireConnection(nodeId, "disconnect");
    connection.close();
    this.deregisterConnection(nodeId);
  }

  async shutDown(): Promise<void> {
    await this.driver.close();
  }

  async sendAgents(nodeId: NodeId, agents: Uint8Array): Promise<void> {
    const connection = this.requireConnection(nodeId, "sendAgents");
    // One stream per call: announce the protocol, write the payload, close.
    const stream = await this.openProtocolStream(
      connection,
      CURRENT_AGENTS_PROTOCOL,
    );
    await writeMessage(stream, agents);
    await stream.finishWrite();
  }

  async send(nodeId: NodeId, message: Uint8Array): Promise<void> {
    const connection = this.requireConnection(nodeId, "send");
    const stream = await this.messageStream(connection);
    await writeMessage(stream, message);
    this.metrics.bytesTotal.add(message.byteLength, { direction: "sent" });
  }

  async createStream(nodeId: NodeId, protocol: string): Promise<IStream> {
    const connection = this.requireConnection(nodeId, "createStream");
    const stream = await this.openProtocolStream(connection, protocol);
    return new CustomStream(stream, readMessages(stream));
  }

  registerStreamHandler(
    protocol: string,
    handler: CustomStreamCreatedCallback,
  ): void {
    // The dispatch loop already gates on access before calling this.
    this.streamHandlers.set(protocol, async (connection, stream, reader) => {
      handler(connection.remoteNodeId(), new CustomStream(stream, reader));
    });
  }

  // Accept inbound connections until the driver is closed.
  private async acceptConnections(): Promise<void> {
    for (;;) {
      let connection: IrohConnection;
      try {
        connection = await this.driver.accept();
      } catch (error) {
        this.logger.debug("Stopped accepting connections {*}", { error });
        return;
      }
      this.registerConnection(connection);
      void this.acceptStreams(connection);
    }
  }

  // Accept streams on one connection until it closes.
  private async acceptStreams(connection: IrohConnection): Promise<void> {
    const remote = connection.remoteNodeId();
    try {
      for (;;) {
        const stream = await connection.acceptStream();
        void this.handleIncomingStream(connection, stream);
      }
    } catch (error) {
      this.logger.debug("Connection closed {*}", { remote, error });
      this.deregisterConnection(remote);
    }
  }

  // Read a stream's protocol preamble, gate on access, and route it.
  private async handleIncomingStream(
    connection: IrohConnection,
    stream: IrohStream,
  ): Promise<void> {
    const remote = connection.remoteNodeId();
    try {
      const reader = readMessages(stream);
      const preamble = await reader.next();
      if (preamble.done) return; // empty stream, nothing to route
      const protocol = textDecoder.decode(preamble.value);

      // Only the access handshake may run before access is granted.
      if (
        protocol !== CURRENT_ACCESS_PROTOCOL &&
        this.nodeAccess.get(remote) !== true
      ) {
        this.logger.warn(
          "Peer opened a stream before being granted access. Closing connection. {*}",
          { protocol, remote },
        );
        connection.close();
        return;
      }

      const handler = this.streamHandlers.get(protocol);
      if (!handler) {
        this.logger.warn("No handler for protocol. Ignoring stream. {*}", {
          protocol,
          remote,
        });
        await stream.stopRead();
        return;
      }
      await handler(connection, stream, reader);
    } catch (error) {
      this.logger.error("Failed to handle incoming stream {*}", {
        remote,
        error,
      });
    }
  }

  // Responds to an incoming access handshake, running the shared handshake over
  // this stream.
  private handleAccessStream: StreamHandler = async (
    connection,
    stream,
    reader,
  ) => {
    const remote = connection.remoteNodeId();
    this.logger.info("Incoming access handshake {*}", { remote });

    // Turn away a peer we have already denied, without asking the handler again.
    if (this.nodeAccess.get(remote) === false) {
      this.logger.warn(
        "Previously denied peer tried again. Closing connection. {*}",
        { remote },
      );
      connection.close();
      return;
    }

    try {
      const granted = await runResponderHandshake(
        this.accessChannel(stream, reader),
        this.handshakeParams(remote),
      );
      if (!granted) {
        this.logger.warn("Access not granted. Closing connection. {*}", {
          remote,
        });
        connection.close();
        return;
      }
      this.logger.info("Access granted {*}", { remote });
      this.firePeerConnected(remote);
    } catch (error) {
      this.logger.warn("Access handshake failed. Closing connection. {*}", {
        remote,
        error,
      });
      connection.close();
    }
  };

  // Reads agent-info payloads from an incoming agents stream until the peer
  // finishes sending.
  private handleAgentsStream: StreamHandler = async (
    connection,
    stream,
    reader,
  ) => {
    const remote = connection.remoteNodeId();
    for await (const message of reader) {
      this.logger.debug("Incoming agents message {*}", {
        remote,
        byteLength: message.byteLength,
      });
      await this.agentsReceivedCallback(remote, message);
    }
    // We never write back, so close our unused write end.
    await stream.finishWrite();
  };

  // Handles an incoming message stream the peer opened. The same stream carries
  // both directions, so we keep it for our own sends too.
  private handleMessageStream: StreamHandler = async (
    connection,
    stream,
    reader,
  ) => {
    const remote = connection.remoteNodeId();
    if (!this.messageStreams.has(remote)) {
      this.messageStreams.set(remote, stream);
    }
    await this.readMessageStream(remote, stream, reader);
  };

  // Initiates the access handshake on a freshly dialed connection.
  private async performAccessHandshake(
    connection: IrohConnection,
  ): Promise<void> {
    const remote = connection.remoteNodeId();
    // Preamble names the protocol; the shared handshake then runs on the stream.
    const stream = await this.openProtocolStream(
      connection,
      CURRENT_ACCESS_PROTOCOL,
    );
    const reader = readMessages(stream);

    let granted: boolean;
    try {
      granted = await runInitiatorHandshake(
        this.accessChannel(stream, reader),
        this.handshakeParams(remote),
      );
    } catch (error) {
      connection.close();
      throw error;
    }
    if (!granted) {
      connection.close();
      throw new Error("Access denied to remote");
    }
    this.logger.info("Access handshake complete {*}", { remote });
  }

  // A handshake channel over one iroh bi-stream: send/receive framed messages,
  // close by finishing our write end.
  private accessChannel(
    stream: IrohStream,
    reader: AsyncGenerator<Uint8Array>,
  ): HandshakeChannel {
    return {
      send: (bytes) => writeMessage(stream, bytes),
      receive: async () => {
        const result = await reader.next();
        return result.done ? null : result.value;
      },
      closeStream: () => stream.finishWrite(),
    };
  }

  private handshakeParams(remote: NodeId) {
    return {
      localAccessBytes: this.localNetworkAccessBytes,
      // Record the decision so a denial is sticky for the session.
      evaluate: async (bytes: Uint8Array) => {
        const granted = await this.networkAccessHandler(remote, bytes);
        this.nodeAccess.set(remote, granted);
        return granted;
      },
      timeoutMs: this.handshakeTimeoutMs,
    };
  }

  // Try each address in turn, returning the first connection that succeeds.
  private async dial(nodeAddresses: NodeAddress[]): Promise<IrohConnection> {
    let lastError: unknown;
    for (const address of nodeAddresses) {
      try {
        return await this.driver.connect(address);
      } catch (error) {
        lastError = error;
        this.logger.warn("Dialing address failed {*}", { address, error });
      }
    }
    throw new Error("Connection failed", { cause: lastError });
  }

  private requireConnection(nodeId: NodeId, action: string): IrohConnection {
    const connection = this.connections.get(nodeId);
    if (!connection) {
      throw new Error(
        `No open connection to peer ${nodeId}. Ensure the peer is connected before calling ${action}().`,
      );
    }
    return connection;
  }

  // Open a stream and announce its protocol in the preamble the acceptor reads.
  private async openProtocolStream(
    connection: IrohConnection,
    protocol: string,
  ): Promise<IrohStream> {
    const stream = await connection.openStream();
    await writeMessage(stream, textEncoder.encode(protocol));
    return stream;
  }

  // The message stream for a peer: reuse the open one, or open it and start
  // reading the replies the peer writes back on it.
  private async messageStream(connection: IrohConnection): Promise<IrohStream> {
    const remote = connection.remoteNodeId();
    const existing = this.messageStreams.get(remote);
    if (existing) return existing;

    const stream = await this.openProtocolStream(
      connection,
      CURRENT_MESSAGE_PROTOCOL,
    );
    this.messageStreams.set(remote, stream);
    if (this.messageHandler) {
      void this.readMessageStream(remote, stream, readMessages(stream));
    }
    return stream;
  }

  // Deliver every message read from a message stream to the message handler,
  // until the stream ends.
  private async readMessageStream(
    remote: NodeId,
    stream: IrohStream,
    reader: AsyncGenerator<Uint8Array>,
  ): Promise<void> {
    const messageHandler = this.messageHandler;
    if (!messageHandler) return;
    try {
      for await (const message of reader) {
        this.logger.debug("Incoming message {*}", {
          remote,
          byteLength: message.byteLength,
        });
        this.metrics.bytesTotal.add(message.byteLength, {
          direction: "received",
        });
        await messageHandler(remote, message, this);
      }
    } catch (error) {
      this.logger.debug("Message stream ended {*}", { remote, error });
    } finally {
      if (this.messageStreams.get(remote) === stream) {
        this.messageStreams.delete(remote);
      }
    }
  }

  private registerConnection(connection: IrohConnection): void {
    this.connections.set(connection.remoteNodeId(), connection);
  }

  private deregisterConnection(remote: NodeId): void {
    if (!this.connections.delete(remote)) return;
    this.messageStreams.delete(remote);
    this.logger.info("Peer disconnected {*}", { remote });
    this.peerDisconnectedCallback?.(remote).catch((error) => {
      this.logger.error("PeerDisconnectedCallback produced an error {*}", {
        error,
      });
    });
  }

  private firePeerConnected(remote: NodeId): void {
    this.peerConnectedCallback?.(remote, this).catch((error) => {
      this.logger.error("PeerConnectedCallback produced an error {*}", {
        error,
      });
    });
  }
}
