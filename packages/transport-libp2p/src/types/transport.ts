import type { Multiaddr } from "@multiformats/multiaddr";
import type { AgentId, NetworkAccessBytes, RelayConfig } from "./agent.js";
import type { IConnection } from "./connection.js";

export type INewAddressHandler = (addrs: Multiaddr[]) => void;

export interface ITransport {
  /**
   * Establish a connection to a peer, presenting a network access pass.
   * */
  connect(addr: Multiaddr, pass: NetworkAccessBytes): Promise<IConnection>;

  /**
   * Hook called when the node observes a new address it can be contacted
   * at.
   */
  onNewAddress(handler: INewAddressHandler): void;

  /**
   * Hook called on each incoming connection with the peer's network access bytes.
   * Return true to accept, false to reject and drop the connection.
   */
  onConnect(handler: (bytes: NetworkAccessBytes) => boolean): void;

  /**
   * Send data to a peer. Each message uses a short-lived stream, avoiding
   * the need for manual message framing. Stream creation is cheap enough
   * for expected message rates (sub-minute to tens per second).
   */
  send(agentId: AgentId, data: Uint8Array): Promise<void>;

  /**
   * Configure this peer's willingness and resource limits for relaying traffic
   */
  setRelayConfig(config: RelayConfig): void;
}
