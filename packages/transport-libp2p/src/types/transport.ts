import type { AgentId } from "./agent.js";

/**
 * Byte sequence to prove access to a network has been granted
 */
export type NetworkAccessBytes = Uint8Array;

/**
 * Peerkit-native address for a relay node.
 *
 * Every transport implementation parses it according to its own convention.
 */
export type RelayAddress = string;

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
) => Promise<boolean>;

/**
 * Interface to handle incoming messages from a message stream.
 */
export type IMessageHandler = (
  fromAgent: AgentId,
  message: Uint8Array,
) => Promise<void>;

/**
 * Callback to call when agents have been received from other nodes.
 */
export type IAgentsReceivedCallback = (
  fromAgent: AgentId,
  bytes: Uint8Array,
) => Promise<void>;

/**
 * Interface that defines the methods a peerkit transport needs to implement.
 */
export interface ITransport {
  /**
   * Establish a connection to a known agent. The agent must have been
   * previously discovered via {@link sendAgents}; throws if unknown.
   */
  connect(agentId: AgentId, bytes: NetworkAccessBytes): Promise<void>;

  /**
   * Send an opaque application message to an agent.
   * The agent must be connected.
   */
  send(agentId: AgentId, data: Uint8Array): Promise<void>;

  /**
   * Send opaque agent-info bytes to an agent.
   * The agent must be connected and have been granted access.
   *
   * For relay nodes, the orchestrator calls this automatically in response to
   * incoming agent-info (e.g. to bootstrap newly connected peers).
   * For regular nodes, the caller is responsible for invoking it explicitly
   * (e.g. after bootstrap or on agent-info change).
   */
  sendAgents(agentId: AgentId, data: Uint8Array): Promise<void>;

  /**
   * Shut down the transport and all underlying connections.
   */
  stop(): Promise<void>;
}
