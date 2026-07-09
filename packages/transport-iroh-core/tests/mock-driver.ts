import type { NodeAddress, NodeId } from "@peerkit/api";
import type { IrohConnection, IrohDriver, IrohStream } from "../src/driver.js";

// An in-memory stand-in for the iroh driver, so the transport can be tested
// without the native binding. Endpoints find each other through a shared
// MockNetwork; connections and streams are wired as plain in-process pipes.
// The pull semantics (read returns a chunk or null at end, accept parks until
// something arrives or the endpoint closes) match the real driver.

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// One end of a two-way byte pipe. Writing hands bytes to the peer end's read
// side; finishing tells the peer end no more will come.
class MockStream implements IrohStream {
  private inbound: Uint8Array[] = [];
  private ended = false;
  private waiters: (() => void)[] = [];
  private peer!: MockStream;

  static pair(): [MockStream, MockStream] {
    const a = new MockStream();
    const b = new MockStream();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async write(data: Uint8Array): Promise<void> {
    // Copy so a later mutation of the caller's buffer can't change what the
    // peer reads.
    this.peer.deliver(data.slice());
  }

  async finishWrite(): Promise<void> {
    this.peer.end();
  }

  async read(): Promise<Uint8Array | null> {
    while (this.inbound.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inbound.shift() ?? null;
  }

  async readToEnd(sizeLimit: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) break;
      total += chunk.byteLength;
      if (total > sizeLimit) {
        throw new Error("readToEnd exceeded size limit");
      }
      chunks.push(chunk);
    }
    return concat(chunks, total);
  }

  async stopRead(): Promise<void> {
    this.inbound = [];
    this.end();
  }

  private deliver(data: Uint8Array): void {
    this.inbound.push(data);
    this.wake();
  }

  private end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

class MockConnection implements IrohConnection {
  private peer!: MockConnection;
  private incoming: MockStream[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  private constructor(private remote: NodeId) {}

  // Build both ends of a connection. `aId`/`bId` are the two node ids; the
  // returned sides each report the *other* node as their remote.
  static pair(aId: NodeId, bId: NodeId): [MockConnection, MockConnection] {
    const aSide = new MockConnection(bId);
    const bSide = new MockConnection(aId);
    aSide.peer = bSide;
    bSide.peer = aSide;
    return [aSide, bSide];
  }

  remoteNodeId(): NodeId {
    return this.remote;
  }

  isDirect(): boolean {
    return true;
  }

  async openStream(): Promise<IrohStream> {
    if (this.closed) throw new Error("connection closed");
    const [near, far] = MockStream.pair();
    this.peer.receiveStream(far);
    return near;
  }

  async acceptStream(): Promise<IrohStream> {
    while (this.incoming.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const stream = this.incoming.shift();
    if (!stream) throw new Error("connection closed");
    return stream;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    this.peer.closed = true;
    this.peer.wake();
  }

  private receiveStream(stream: MockStream): void {
    this.incoming.push(stream);
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** A set of endpoints that can reach each other by node id. */
export class MockNetwork {
  private endpoints = new Map<NodeId, MockDriver>();

  register(driver: MockDriver): void {
    this.endpoints.set(driver.getNodeId(), driver);
  }

  get(nodeId: NodeId): MockDriver | undefined {
    return this.endpoints.get(nodeId);
  }
}

export class MockDriver implements IrohDriver {
  private incoming: MockConnection[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private nodeId: NodeId,
    private network: MockNetwork,
  ) {
    network.register(this);
  }

  getNodeId(): NodeId {
    return this.nodeId;
  }

  // The mock uses the node id itself as the dialable address.
  getNodeAddress(): NodeAddress {
    return this.nodeId;
  }

  async connect(address: NodeAddress): Promise<IrohConnection> {
    const peer = this.network.get(address);
    if (!peer) throw new Error(`no endpoint at ${address}`);
    const [near, far] = MockConnection.pair(this.nodeId, peer.nodeId);
    peer.receiveConnection(far);
    return near;
  }

  async accept(): Promise<IrohConnection> {
    while (this.incoming.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const conn = this.incoming.shift();
    if (!conn) throw new Error("driver closed");
    return conn;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake();
  }

  private receiveConnection(conn: MockConnection): void {
    this.incoming.push(conn);
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Two registered drivers with a connection already established between them. */
export async function connectedDrivers(): Promise<{
  a: MockDriver;
  b: MockDriver;
  connA: IrohConnection;
  connB: IrohConnection;
}> {
  const network = new MockNetwork();
  const a = new MockDriver("mock-a", network);
  const b = new MockDriver("mock-b", network);
  const [connA, connB] = await Promise.all([
    a.connect(b.getNodeAddress()),
    b.accept(),
  ]);
  return { a, b, connA, connB };
}

/** A connected pair of streams, one end on each side of a mock connection. */
export async function connectedStreams(): Promise<[IrohStream, IrohStream]> {
  const { connA, connB } = await connectedDrivers();
  return Promise.all([connA.openStream(), connB.acceptStream()]);
}
