import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import { type Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import type { Stream, Connection as Libp2pConnection } from "@libp2p/interface";
import { createLibp2p } from "libp2p";
import { Connection } from "./connection.js";
import type {
  AgentId,
  IConnection,
  INewAddressHandler,
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

type IConnectHandler = (bytes: NetworkAccessBytes) => boolean;

const ACCESS_PROTOCOL = "/peerkit/access/0.1.0";

/**
 * The official peerkit transport based on Libp2p.
 */
export class TransportLibp2p implements ITransport {
  private libp2p: Libp2p;
  private logger: Logger;
  private newAddressesHandler?: INewAddressHandler;
  private networkAccessHandler?: IConnectHandler;

  constructor(libp2p: Libp2p, options?: TransportLibp2pConfig) {
    libp2p.addEventListener("peer:identify", (event) =>
      this.onNewAddresses(event.detail.listenAddrs),
    );

    // Handle incoming connections with the access protocol first.
    libp2p.handle(ACCESS_PROTOCOL, this.onConnect);

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
  }

  static async create(options?: TransportLibp2pConfig) {
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

    return new TransportLibp2p(libp2pNode, options);
  }

  async connect(
    addr: Multiaddr,
    bytes: NetworkAccessBytes,
  ): Promise<IConnection> {
    this.logger.debug("connecting {*}", { addr });
    const connection = await this.libp2p.dial(addr);
    const stream = await connection.newStream(ACCESS_PROTOCOL);
    stream.send(bytes);
    return new Connection(connection, stream);
  }

  setNewAddressesHandler(handler: INewAddressHandler): void {
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

  setNetworkAccessHandler(handler: IConnectHandler): void {
    this.networkAccessHandler = handler;
  }

  // Method directly used as a callback, so an arrow class field must be used to
  // preserve the `this` reference.
  private onConnect = async (stream: Stream, connection: Libp2pConnection) => {
    this.logger.info("Incoming stream {*}", {
      stream,
      connection,
      ACCESS_PROTOCOL,
    });
    stream.addEventListener("message", async (message) => {
      this.logger.info("Incoming message {*}", { message });
      if (this.networkAccessHandler) {
        const bytes =
          message.data instanceof Uint8Array
            ? message.data
            : message.data.subarray(); // In case the incoming bytes are an array of chunks of bytes.
        // Check if network access is granted.
        if (!this.networkAccessHandler(bytes)) {
          // Network access denied. Close connection.
          this.logger.warn("Invalid network access bytes. Closing connection.");
          await connection.close();
        }
      } else {
        // No network connection handler set. Close connection.
        this.logger.error(
          "No connection handler set. If connections should be unrestricted, set a connection handler that always returns `true`. Closing connection.",
        );
        await connection.close();
      }
    });
  };

  async send(agentId: AgentId, data: Uint8Array): Promise<void> {
    this.logger.trace("sending {*}", { agentId, data });
    return;
  }

  setRelayConfig(config: RelayConfig): void {
    this.logger.debug("setting relay config {*}", { config });
  }

  async stop() {
    return this.libp2p.stop();
  }
}
