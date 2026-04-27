import type { AgentId } from "./agent.js";

export type RelayAddress = string;

export interface RelayConfig {
  canRelay: boolean;
}

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
export type INetworkAccessHandler = (
  agentId: AgentId,
  bytes: NetworkAccessBytes,
) => boolean;

/**
 * Interface to handle incoming messages from a message stream.
 */
export type IMessageHandler = (fromAgent: AgentId, message: Uint8Array) => void;

/**
 * Callback to call when agents have been received from other nodes.
 */
export type IAgentsReceivedHandler = (
  fromAgent: AgentId,
  bytes: Uint8Array,
) => void;

/**
 * Interface that defines the methods a peerkit transport needs to implement.
 */
export interface ITransport {
  connect(agentId: AgentId): Promise<void>;
  send(agentId: AgentId, data: Uint8Array): Promise<void>;
  sendAgents(agentId: AgentId, data: Uint8Array): Promise<void>;
  setNetworkAccessHandler(handler: INetworkAccessHandler): void;
  setMessageHandler(handler: IMessageHandler): void;
  setAgentsReceivedHandler(handler: IAgentsReceivedHandler): void;
  setRelayConfig(config: RelayConfig): void;
  stop(): Promise<void>;
}
