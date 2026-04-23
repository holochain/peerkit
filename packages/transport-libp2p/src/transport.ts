import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import { type Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import type {
  Stream,
  Connection as Libp2pConnection,
  PeerId,
} from "@libp2p/interface";
import { createLibp2p } from "libp2p";
import { Connection } from "./connection.js";
import { FrameDecoder } from "./frame.js";
import { NetworkAccessHandshake } from "./proto/access.js";
import type {
  AgentId,
  INetworkAccessHandler,
  IConnection,
  IMessageHandler,
  NewAddressHandler,
  ITransport,
  NetworkAccessBytes,
  RelayConfig,
} from "./types/index.js";

/**
 * Configuration options for the Libp2p transport
 */
export interface TransportLibp2pConfig {
  /** The address the node should bind to */
  addrs?: string[];
  /** An identifier that is included as a log property */
  id?: string;
}

type PeerAccessMap = Map<PeerId, boolean>;

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
  private networkAccessHandler: INetworkAccessHandler;
  private messageHandler: IMessageHandler;
  private newAddressesHandler?: NewAddressHandler;
  // White list of peers that were granted access to the network.
  // This could also use the remote's address instead of the ID.
  private peerAccessMap: PeerAccessMap;

  constructor(
    libp2p: Libp2p,
    networkAccessHandler: INetworkAccessHandler,
    messageHandler: IMessageHandler,
    options?: TransportLibp2pConfig,
  ) {
    libp2p.addEventListener("peer:identify", (event) =>
      this.onNewAddresses(event.detail.listenAddrs),
    );

    // Handle streams with the access protocol.
    // This must happen first on new connections.
    libp2p.handle(CURRENT_ACCESS_PROTOCOL, this.onAccessConnect);

    // Handle streams with the message protocol.
    // After getting granted access, streams with this protocol are allowed.
    libp2p.handle(CURRENT_MESSAGE_PROTOCOL, this.onMessageConnect);

    this.libp2p = libp2p;

    // Instantiate a logger with properties to identify the node.
    // These properties can be included in log outputs at any time.
    this.logger = getLogger(["peerkit", "transport"]).with({
      peerId: libp2p.peerId,
      id: options?.id,
    });
    this.logger.info("Transport created {*}", {
      addresses: libp2p.getMultiaddrs(),
      id: options?.id,
    });

    this.networkAccessHandler = networkAccessHandler;
    this.messageHandler = messageHandler;

    this.peerAccessMap = new Map();
  }

  /**
   * Create a new Peerkit transport based on libp2p.
   *
   * The transport uses the TCP protocol for connections. Connections are
   * encrypted and multiplexed for use with multiple streams.
   *
   * The transport binds to an available port on the local host.
   *
   * @param networkAccessHandler Hook called when a remote provides Network
   * Access Bytes to prove access to the network. Return true to accept,
   * false to reject and drop the connection.
   * @param messageHandler Hook called on each incoming messsage.
   * @param options {@link TransportLibp2pConfig}
   * @returns An instance of a Peerkit transport
   */
  static async create(
    networkAccessHandler: INetworkAccessHandler,
    messageHandler: IMessageHandler,
    options?: TransportLibp2pConfig,
  ) {
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
      networkAccessHandler,
      messageHandler,
      options,
    );
  }

  async connect(
    addr: Multiaddr,
    agentId: AgentId,
    networkAccessBytes: NetworkAccessBytes,
  ): Promise<IConnection> {
    this.logger.debug("connecting {*}", { addr });
    const connection = await this.libp2p.dial(addr);

    // Send handshake with agent ID and network access bytes over access stream.
    const accessStream = await connection.newStream(CURRENT_ACCESS_PROTOCOL);
    accessStream.send(
      NetworkAccessHandshake.encode({ agentId, networkAccessBytes }),
    );
    await accessStream.close();

    // Open message stream to start exchanging messages with peer.
    const messageStream = await connection.newStream(CURRENT_MESSAGE_PROTOCOL);

    return new Connection(connection, messageStream);
  }

  setNewAddressesHandler(handler: NewAddressHandler): void {
    if (this.newAddressesHandler) {
      this.logger.warn("New address handler exists, overwriting it.");
    }
    this.newAddressesHandler = handler;
  }

  private async onNewAddresses(addrs: Multiaddr[]) {
    this.logger.info("New listening addresses: {addrs}", { addrs });
    if (this.newAddressesHandler) {
      this.newAddressesHandler(addrs);
    } else {
      this.logger.warn("No new addresses handler registered. Doing nothing.");
    }
  }

  /*
   * Handler that expects the Network Access Bytes as the first and only message.
   * Closes connection if access is denied.
   */
  // Method directly used as a callback, so an arrow class field must be used to
  // preserve the `this` reference.
  private onAccessConnect = async (
    stream: Stream,
    connection: Libp2pConnection,
  ) => {
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
          // Catch malformed handshake errors
          this.logger.error(
            "Failed to decode access handshake. Closing connection.",
          );
          await connection.close();
          return;
        }

        // Check if network access is granted and update access map.
        const accessGranted = this.networkAccessHandler(
          handshake.networkAccessBytes,
        );
        this.peerAccessMap.set(connection.remotePeer, accessGranted);
        this.logger.info("Access {*}", {
          remoteId: connection.remotePeer,
          accessGranted,
        });
        if (!accessGranted) {
          // Network access denied. Close connection.
          this.logger.warn("Invalid network access bytes. Closing connection.");
          await connection.close();
        }
      },
      { once: true },
    );
  };

  /*
   * Handler to exchange all messages with peers.
   *
   * If network access bytes have not been provided yet or access has been denied,
   * connection is closed.
   */
  // Method directly used as a callback, so an arrow class field must be used to
  // preserve the `this` reference.
  private onMessageConnect = async (
    stream: Stream,
    connection: Libp2pConnection,
  ) => {
    this.logger.info(`Incoming stream {*}`, {
      CURRENT_MESSAGE_PROTOCOL,
      remoteId: connection.remotePeer,
    });
    // Strictly this should check if `.get()` is `undefined`. The access check closes
    // connections so fast that the remote cannot open a message stream, so this case
    // can never happen.
    //
    // But it doesn't harm to handle all falsy values here.
    if (!this.peerAccessMap.get(connection.remotePeer)) {
      // Peer has not requested access to the network. Close connection.
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
        this.messageHandler(msg);
      }
    });
  };

  async send(agentId: AgentId, data: Uint8Array): Promise<void> {
    this.logger.trace("sending {*}", { agentId, data });
    return;
  }

  setRelayConfig(config: RelayConfig): void {
    this.logger.info("setting relay config {*}", { config });
  }

  async stop() {
    return this.libp2p.stop();
  }
}
