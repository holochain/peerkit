export interface IConnection {
  isClosed(): boolean;

  send(data: Uint8Array): void;
}
