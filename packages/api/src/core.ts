import type { AgentId } from "./agent.js";
import type { IStream } from "./transport.js";

/**
 * Contract for a module that can be attached to a {@link IPeerkitNode}
 *
 * The node calls init() when registering the module, then start() to
 * begin activity. stop() terminates activity gracefully on shutdown.
 */
export interface INodeModule {
  /**
   * Called by the node immediately after registration to wire up the module.
   */
  init(node: IPeerkitNode): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * Interface that the peerkit node exposes to modules
 *
 * Modules depend on this interface only, so that they can be distributed
 * without a dependency on the peerkit package.
 */
export interface IPeerkitNode {
  /**
   * The local node's stable agent identity.
   */
  readonly ownAgentId: AgentId;

  /**
   * Return the AgentIds of all currently connected peers.
   */
  getConnectedAgents(): AgentId[];

  /**
   * Open an outgoing stream to a connected agent on the given protocol.
   *
   * Throws if the agent is not connected.
   */
  createStream(agentId: AgentId, protocol: string): Promise<IStream>;

  /**
   * Register a handler for incoming streams on the given protocol.
   *
   * Called once per incoming stream, after the access check has passed.
   */
  registerStreamHandler(
    protocol: string,
    handler: (fromAgent: AgentId, stream: IStream) => void,
  ): void;

  /**
   * Attach a module to this node.
   *
   * Calls module.init(this) to wire it up, then module.start() if defined.
   * Multiple modules can be registered.
   */
  register(module: INodeModule): void;
}
