import type { NodeAddress, NodeId } from "@peerkit/api";
import type {
  IrohConnection,
  IrohDriver,
  IrohStream,
} from "@peerkit/transport-iroh-core";
import {
  PeerkitEndpoint,
  type PeerkitConn,
  type PeerkitStream,
} from "peerkit-iroh-native";

// Thin adapters from the core IrohDriver surface onto the native binding. The
// binding already speaks the same pull model, so each call maps one-to-one.

class NativeStream implements IrohStream {
  constructor(private readonly stream: PeerkitStream) {}

  write(data: Uint8Array): Promise<void> {
    // Wrap without copying: Buffer shares the Uint8Array's memory.
    return this.stream.write(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  finishWrite(): Promise<void> {
    return this.stream.finishWrite();
  }

  read(): Promise<Uint8Array | null> {
    return this.stream.read();
  }

  readToEnd(sizeLimit: number): Promise<Uint8Array> {
    return this.stream.readToEnd(sizeLimit);
  }

  stopRead(): Promise<void> {
    return this.stream.stopRead();
  }
}

class NativeConnection implements IrohConnection {
  constructor(private readonly conn: PeerkitConn) {}

  remoteNodeId(): NodeId {
    return this.conn.remoteId();
  }

  isDirect(): boolean {
    return this.conn.isDirect();
  }

  async openStream(): Promise<IrohStream> {
    return new NativeStream(await this.conn.openBi());
  }

  async acceptStream(): Promise<IrohStream> {
    return new NativeStream(await this.conn.acceptBi());
  }

  close(): void {
    this.conn.close();
  }
}

/** Options for the native iroh endpoint. */
export interface NativeDriverOptions {
  /**
   * Use n0's production relays and discovery (default `true`). Set `false` for a
   * direct-only, offline endpoint — e.g. in hermetic tests.
   */
  relay?: boolean;
}

/** An {@link IrohDriver} backed by the native iroh endpoint. */
export class NativeDriver implements IrohDriver {
  private constructor(private readonly endpoint: PeerkitEndpoint) {}

  static async create(options?: NativeDriverOptions): Promise<NativeDriver> {
    const endpoint = await PeerkitEndpoint.create({ relay: options?.relay });
    return new NativeDriver(endpoint);
  }

  getNodeId(): NodeId {
    return this.endpoint.nodeId();
  }

  getNodeAddress(): NodeAddress {
    return this.endpoint.addr();
  }

  async connect(address: NodeAddress): Promise<IrohConnection> {
    return new NativeConnection(await this.endpoint.connect(address));
  }

  async accept(): Promise<IrohConnection> {
    return new NativeConnection(await this.endpoint.accept());
  }

  close(): Promise<void> {
    return this.endpoint.close();
  }
}
