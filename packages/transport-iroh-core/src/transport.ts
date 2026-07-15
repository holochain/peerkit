import { getLogger, type Logger } from "@logtape/logtape";
import type {
  CustomStreamCreatedCallback,
  IStream,
  ITransport,
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
import type { IrohConnection, IrohDriver, IrohStream } from "./driver.js";
import { readMessages, writeMessage } from "./messages.js";

/**
 * Current peerkit network access protocol.
 *
 * The initiator opens a stream, names this protocol in the preamble, and sends
 * its access bytes. The responder replies with its own access bytes if it
 * grants access, then waits for an ack confirming the initiator granted access
 * too. Either side denying closes the whole connection.
 */
export const CURRENT_ACCESS_PROTOCOL = "/peerkit/access/v1";

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
  private readonly peerConnectedCallback?: PeerConnectedCallback;
  private readonly peerDisconnectedCallback?: PeerDisconnectedCallback;
  private readonly handshakeTimeoutMs: number;

  // Live connections keyed by the remote node id.
  private readonly connections = new Map<NodeId, IrohConnection>();
  // Access decisions keyed by remote node id. true = granted, false = denied.
  // Sticky for the session, so a denied peer is turned away without asking again.
  private readonly nodeAccess = new Map<NodeId, boolean>();
  // Stream handlers keyed by protocol id, chosen by each stream's preamble.
  private readonly streamHandlers = new Map<string, StreamHandler>();

  constructor(driver: IrohDriver, options: IrohTransportOptions) {
    this.driver = driver;
    this.localNetworkAccessBytes =
      options.networkAccessBytes ?? new Uint8Array([0]);
    this.networkAccessHandler = options.networkAccessHandler;
    this.peerConnectedCallback = options.peerConnectedCallback;
    this.peerDisconnectedCallback = options.peerDisconnectedCallback;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.logger = getLogger(["peerkit", "transport"]).with({
      nodeId: driver.getNodeId(),
      id: options.id,
    });

    this.streamHandlers.set(CURRENT_ACCESS_PROTOCOL, this.handleAccessStream);

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
    const connection = this.connections.get(nodeId);
    if (!connection) {
      throw new Error(
        `No open connection to peer ${nodeId}. Ensure the peer is connected before calling disconnect().`,
      );
    }
    connection.close();
    this.deregisterConnection(nodeId);
  }

  async shutDown(): Promise<void> {
    await this.driver.close();
  }

  // The agents, message and custom-stream protocols are not built yet.
  async sendAgents(): Promise<void> {
    throw new Error("sendAgents is not implemented yet");
  }
  async send(): Promise<void> {
    throw new Error("send is not implemented yet");
  }
  async createStream(): Promise<IStream> {
    throw new Error("createStream is not implemented yet");
  }
  registerStreamHandler(
    _protocol: string,
    _handler: CustomStreamCreatedCallback,
  ): void {
    throw new Error("registerStreamHandler is not implemented yet");
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

  // Initiates the access handshake on a freshly dialed connection.
  private async performAccessHandshake(
    connection: IrohConnection,
  ): Promise<void> {
    const remote = connection.remoteNodeId();
    const stream = await connection.openStream();

    // Preamble names the protocol; the shared handshake then runs on the stream.
    await writeMessage(stream, textEncoder.encode(CURRENT_ACCESS_PROTOCOL));
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

  private registerConnection(connection: IrohConnection): void {
    this.connections.set(connection.remoteNodeId(), connection);
  }

  private deregisterConnection(remote: NodeId): void {
    if (!this.connections.delete(remote)) return;
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
