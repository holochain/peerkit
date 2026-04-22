import type { IConnection } from "./types/connection.js";
import type { Stream, Connection as Libp2pConnection } from "@libp2p/interface";
import { encodeFrame } from "./frame.js";

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

  send(data: Uint8Array): void {
    this.stream.send(encodeFrame(data));
  }
}
