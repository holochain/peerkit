import type {
  AgentId,
  INodeModule,
  IPeerkitNode,
  IStream,
  PeerkitStreamEvents,
} from "@peerkit/api";

/**
 * Two linked MockStreams. Sending on one delivers a message event on the other,
 * closing one fires remoteClose on the other.
 */
export class MockStream implements IStream {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly remoteCloseListeners = new Set<
    PeerkitStreamEvents["remoteClose"]
  >();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private _isOpen = true;
  peer: MockStream | undefined;

  send(data: Uint8Array): void {
    if (!this._isOpen || this.peer === undefined || !this.peer._isOpen) return;
    for (const l of this.peer.messageListeners) l(data);
  }

  addEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void {
    if (type === "message")
      this.messageListeners.add(listener as (data: Uint8Array) => void);
    else if (type === "remoteClose")
      this.remoteCloseListeners.add(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    else this.closeListeners.add(listener as (error?: Error) => void);
  }

  removeEventListener<T extends keyof PeerkitStreamEvents>(
    type: T,
    listener: PeerkitStreamEvents[T],
  ): void {
    if (type === "message")
      this.messageListeners.delete(listener as (data: Uint8Array) => void);
    else if (type === "remoteClose")
      this.remoteCloseListeners.delete(
        listener as PeerkitStreamEvents["remoteClose"],
      );
    else this.closeListeners.delete(listener as (error?: Error) => void);
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  async close(): Promise<void> {
    if (!this._isOpen) return;
    this._isOpen = false;
    for (const l of this.closeListeners) l();
    if (this.peer !== undefined) {
      for (const l of this.peer.remoteCloseListeners)
        l(new Event("remoteClose"));
    }
  }
}

export function makeStreamPair(): [MockStream, MockStream] {
  const a = new MockStream();
  const b = new MockStream();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * Minimal IPeerkitNode implementation.
 *
 * createStream() creates a linked stream pair: returns one end to the caller
 * and synchronously invokes the peer's registered handler with the other end.
 * The handler is an async function that suspends at its first await, so
 * createStream() returns before the handler does any real work.
 */
export class MockNode implements IPeerkitNode {
  readonly ownAgentId: AgentId;
  private readonly peers = new Map<AgentId, MockNode>();
  readonly handlers = new Map<
    string,
    (fromAgent: AgentId, stream: IStream) => void
  >();

  constructor(agentId: AgentId) {
    this.ownAgentId = agentId;
  }

  /** Wire this node to another so each shows up in the other's connected list. */
  addPeer(peer: MockNode): void {
    this.peers.set(peer.ownAgentId, peer);
    peer.peers.set(this.ownAgentId, this);
  }

  getConnectedAgents(): AgentId[] {
    return Array.from(this.peers.keys());
  }

  async createStream(agentId: AgentId, protocol: string): Promise<IStream> {
    const peer = this.peers.get(agentId);
    if (peer === undefined) throw new Error(`Not connected to ${agentId}`);
    const handler = peer.handlers.get(protocol);
    if (handler === undefined)
      throw new Error(`No handler for ${protocol} on ${agentId}`);
    const [myEnd, theirEnd] = makeStreamPair();
    // Calling the handler synchronously is safe: it is an async function that
    // suspends at its first await (buffered.next()), allowing createStream to
    // return before the handler processes anything.
    handler(this.ownAgentId, theirEnd);
    return myEnd;
  }

  registerStreamHandler(
    protocol: string,
    handler: (fromAgent: AgentId, stream: IStream) => void,
  ): void {
    this.handlers.set(protocol, handler);
  }

  register(module: INodeModule): void {
    module.init(this);
    module.start?.();
  }
}
