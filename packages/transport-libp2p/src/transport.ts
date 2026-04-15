import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import type { Libp2p } from "libp2p";
import { createLibp2p } from "libp2p";
import type {
  IConnection,
  ITransport,
  NetworkAccessPass,
  PeerAddress,
  PeerId,
  RelayConfig,
} from "./types/index.js";
import { getLogger, type Logger } from "@logtape/logtape";
import { Connection } from "./connection.js";

/**
 * The official peerkit transport based on libp2p.
 */
export class TransportLibp2p implements ITransport {
  private libp2p: Libp2p;
  private logger: Logger;

  constructor(libp2p: Libp2p) {
    this.libp2p = libp2p;
    this.logger = getLogger(["peerkit", "transport", libp2p.peerId.toString()]);
    this.logger.debug("Transport created");
  }

  static async create() {
    const libp2pNode = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
    });
    await libp2pNode.start();

    return new TransportLibp2p(libp2pNode);
  }

  async connect(
    _peerId: PeerId,
    _pass: NetworkAccessPass,
  ): Promise<IConnection> {
    return new Connection();
  }

  listen(): void {}

  onConnect(
    _handler: (peerId: PeerId, pass: NetworkAccessPass) => boolean,
  ): void {}

  async send(_peerId: PeerId, _data: Uint8Array): Promise<void> {
    return;
  }

  async discover(): Promise<PeerAddress[]> {
    return [];
  }

  setRelayConfig(_config: RelayConfig): void {}
}
