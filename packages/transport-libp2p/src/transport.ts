import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { getLogger, type Logger } from "@logtape/logtape";
import { type Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createLibp2p } from "libp2p";
import { Connection } from "./connection.js";
import type {
  AgentId,
  IConnection,
  INewAddressHandler,
  ITransport,
  NetworkAccessPass,
  RelayConfig,
} from "./types/index.js";

/**
 * Configuration options for the Libp2p transport.
 */
export interface TransportLibp2pConfig {
  /** The address the node should bind to. */
  addrs?: string[];
  /** An identifier that is included as a log property. */
  id?: string;
}

/**
 * The official peerkit transport based on Libp2p.
 */
export class TransportLibp2p implements ITransport {
  private libp2p: Libp2p;
  private logger: Logger;
  private onNewAddressHandler?: INewAddressHandler;
  private listeningAddrs?: Multiaddr[];

  constructor(libp2p: Libp2p, options?: TransportLibp2pConfig) {
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

    this.libp2p.addEventListener("peer:identify", (event) => {
      this.logger.debug("{id} identify event {detail}", {
        detail: event.detail,
      });
      this.newAddress(event.detail.listenAddrs);
    });
    this.libp2p.addEventListener("transport:listening", (event) => {
      this.logger.info("transport listening event {event}", { event });
    });
  }

  static async create(options?: TransportLibp2pConfig) {
    const libp2pNode = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      addresses: {
        listen: options?.addrs ?? ["/ip4/127.0.0.1/tcp/0"],
      },
    });
    await libp2pNode.start();

    return new TransportLibp2p(libp2pNode, options);
  }

  async connect(
    addr: Multiaddr,
    pass: NetworkAccessPass,
  ): Promise<IConnection> {
    this.logger.debug("connecting {*}", { addr });
    await this.libp2p.dial(addr);
    return new Connection();
  }

  onNewAddress(handler: INewAddressHandler): void {
    this.onNewAddressHandler = handler;
  }

  async newAddress(addrs: Multiaddr[]) {
    this.logger.info("New listening addresses: {addr}", { addrs });
    this.listeningAddrs = addrs;
    if (this.onNewAddressHandler) {
      this.onNewAddressHandler(addrs);
    }
  }

  onConnect(handler: (pass: NetworkAccessPass) => boolean): void {
    handler(new Uint8Array());
  }

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
