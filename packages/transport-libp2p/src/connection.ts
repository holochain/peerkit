import type { IConnection } from "./types/connection.js";
import type { Stream, Connection as Libp2pConnection } from "@libp2p/interface";

export class Connection implements IConnection {
  private connection: Libp2pConnection;
  private stream: Stream;

  constructor(connection: Libp2pConnection, stream: Stream) {
    this.connection = connection;
    this.stream = stream;
  }

  isClosed() {
    return this.connection.status === "closed";
  }

  send(_data: Uint8Array): void {
    throw new Error("not implemented");
  }
}
