import type {
  NetworkAccessPass,
  PeerAddress,
  PeerId,
  RelayConfig,
} from "./agent.js";
import type { IConnection } from "./connection.js";

export interface ITransport {
  // Establish a connection to a peer, presenting a network access pass
  connect(peerId: PeerId, pass: NetworkAccessPass): Promise<IConnection>;

  // Accept incoming connections (not available in browsers)
  listen(): void;

  // Find peers via mDNS, bootstrap addresses, or DHT
  discover(): Promise<PeerAddress[]>;

  // Send data to a peer. Each message uses a short-lived stream, avoiding
  // the need for manual message framing. Stream creation is cheap enough
  // for expected message rates (sub-minute to tens per second).
  send(peerId: PeerId, data: Uint8Array): Promise<void>;

  // Configure this peer's willingness and resource limits for relaying traffic
  setRelayConfig(config: RelayConfig): void;

  // Hook called on each incoming connection with the peer's network access pass.
  // Return true to accept, false to reject and drop the connection.
  onConnect(
    handler: (peerId: PeerId, pass: NetworkAccessPass) => boolean,
  ): void;
}
