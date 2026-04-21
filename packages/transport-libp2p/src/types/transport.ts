import type { Multiaddr } from "@multiformats/multiaddr";
import type { AgentId, RelayConfig } from "./agent.js";
import type { IConnection } from "./connection.js";

/**
 * Interface of a handler for new listening addresses.
 */
export type INewAddressHandler = (addrs: Multiaddr[]) => void;

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;

/**
 * Interface to handle incoming access streams.
 *
 * An access stream uses the {@link CURRENT_ACCESS_PROTOCOL} and expects
 * the Network Access Bytes as the first and only message, to check if
 * a peer has access to the network or not.
 */
export type INetworkAccessHandler = (bytes: NetworkAccessBytes) => boolean;

/**
 * Interface to handle incoming messages from a message stream.
 */
export type IMessageHandler = (message: Uint8Array) => void;

export interface ITransport {
  /**
   * Establish a connection to a peer, presenting a network access pass.
   * */
  connect(addr: Multiaddr, pass: NetworkAccessBytes): Promise<IConnection>;

  /**
   * Hook called when the node observes a new address it can be contacted
   * at.
   */
  setNewAddressesHandler(handler: INewAddressHandler): void;

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
