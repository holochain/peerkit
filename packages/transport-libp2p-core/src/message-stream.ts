import type { Stream, StreamCloseEvent } from "@libp2p/interface";

/**
 * Serializes writes to a libp2p message stream and waits for its write buffer
 * to drain when a send applies backpressure.
 */
export class MessageStream {
  private sendTail: Promise<void> = Promise.resolve();

  constructor(private readonly stream: Stream) {}

  send(data: Uint8Array): Promise<void> {
    const operation = this.sendTail.then(
      () => this.sendAndWaitForDrain(data),
      () => this.sendAndWaitForDrain(data),
    );
    this.sendTail = operation.catch(() => undefined);
    return operation;
  }

  private async sendAndWaitForDrain(data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.stream.removeEventListener("drain", onDrain);
        this.stream.removeEventListener("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (event: StreamCloseEvent): void => {
        cleanup();
        reject(event.error ?? new Error("Message stream closed before drain"));
      };

      this.stream.addEventListener("drain", onDrain);
      this.stream.addEventListener("close", onClose);

      try {
        if (this.stream.send(data)) {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}
