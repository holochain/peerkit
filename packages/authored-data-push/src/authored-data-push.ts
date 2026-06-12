import { getLogger, type Logger } from "@logtape/logtape";
import type { AgentId, INodeModule, IPeerkitNode, IStream } from "@peerkit/api";
import type {
  Blob,
  IAuthoredDataSyncStore,
} from "@peerkit/api/authored-data-sync";
import { BufferedStream } from "./buffered-stream.js";
import { decodePushMessage, encodePushMessage } from "./push.js";

const AUTHORED_DATA_PUSH_PROTOCOL = "/peerkit/authored-data-push/v1";
const DEFAULT_PUSH_TIMEOUT_MS = 5_000; // 5 seconds

type PushEntry = { blob: Blob; authoredAt: number };

/**
 * Pushes newly authored blobs to connected peers the moment they are authored
 *
 * The module is a pure distribution mechanism. Push subscribes to the store
 * and sends each new blob to every connected peer. Receivers hand blobs to
 * the store.
 */
export class AuthoredDataPush implements INodeModule {
  private core: IPeerkitNode | undefined;
  private readonly dataSyncStore: IAuthoredDataSyncStore;
  private readonly pushTimeoutMs: number;
  private unsubscribeAuthored: (() => void) | undefined;
  private logger: Logger | undefined;

  constructor(dataSyncStore: IAuthoredDataSyncStore, pushTimeoutMs?: number) {
    this.dataSyncStore = dataSyncStore;
    this.pushTimeoutMs = pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  }

  init(core: IPeerkitNode): void {
    this.core = core;
    this.logger = getLogger(["peerkit", "authored-data-push"]).with({
      agentId: core.ownAgentId,
    });
    core.registerStreamHandler(
      AUTHORED_DATA_PUSH_PROTOCOL,
      (fromAgent, stream) => {
        this.handleIncomingPushStream(fromAgent, stream).catch((error) => {
          this.logger!.warn("Push receive handler failed {*}", {
            agentId: fromAgent,
            error,
          });
        });
      },
    );
    // Propagate every locally authored blob to connected peers the moment it is
    // authored.
    this.unsubscribeAuthored = this.dataSyncStore.onAuthored(
      ({ blob, authoredAt }) => {
        void this.pushToAllPeers([{ blob, authoredAt }]);
      },
    );
    this.logger.info("AuthoredDataPush initialized");
  }

  async stop(): Promise<void> {
    this.unsubscribeAuthored?.();
    this.unsubscribeAuthored = undefined;
  }

  /**
   * Push the given entries to every currently connected peer
   *
   * Pushes are fire-and-forget deliveries made in parallel.
   */
  async pushToAllPeers(entries: PushEntry[]): Promise<void> {
    await Promise.all(
      this.core!.getConnectedAgents().map((agentId) =>
        this.pushToPeer(agentId, entries).catch((error) => {
          this.logger!.warn("Push failure {*}", { agentId, error });
        }),
      ),
    );
  }

  /**
   * Author side of the push: open a stream to the peer, send the entries, and
   * close. No reply is read.
   */
  async pushToPeer(
    remoteAgentId: AgentId,
    entries: PushEntry[],
  ): Promise<void> {
    let stream;
    try {
      stream = await this.core!.createStream(
        remoteAgentId,
        AUTHORED_DATA_PUSH_PROTOCOL,
      );
    } catch {
      this.logger!.warn("Failed to open push stream to peer {*}", {
        agentId: remoteAgentId,
      });
      return;
    }

    try {
      stream.send(encodePushMessage({ entries }));
    } catch (error) {
      this.logger!.warn("Failed to push to peer {*}", {
        agentId: remoteAgentId,
        error,
      });
    } finally {
      await this.closeStream(stream);
    }
  }

  /**
   * Receiver side of the push: read pushed blobs and hand them to the store
   * under the sending peer.
   */
  private async handleIncomingPushStream(
    fromAgent: AgentId,
    stream: IStream,
  ): Promise<void> {
    const buffered = new BufferedStream(stream);

    // Read pushed blobs until the author closes the stream, or pushTimeoutMs
    // elapses with no new message.
    let blobsStored = 0;
    while (true) {
      // Set and clear the idle timeout for every awaited message.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), this.pushTimeoutMs);
      });
      const result = await Promise.race([buffered.next(), timeoutPromise]);
      if (result !== "timeout" && timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (result === "timeout") {
        this.logger!.warn("Push receive timed out waiting for blobs {*}", {
          agentId: fromAgent,
        });
        break;
      }
      if (result === null) {
        // Stream closed by the author; nothing more to read.
        break;
      }
      const msg = decodePushMessage(result);
      if (msg === null) continue;
      for (const entry of msg.entries) {
        // Reject malformed entries
        if (
          !(entry?.blob instanceof Uint8Array) ||
          typeof entry.authoredAt !== "number"
        ) {
          this.logger!.warn("Skipping malformed push entry {*}", {
            agentId: fromAgent,
          });
          continue;
        }
        // Store the author's authoredAt as-is; never re-stamp locally. A null
        // return (policy declined or oversized) is a silent skip.
        if (
          this.dataSyncStore.accept(entry.blob, fromAgent, entry.authoredAt) !==
          null
        ) {
          blobsStored++;
        }
      }
    }

    // Close our end on exit. On a normal close the author already closed, so
    // this is a no-op; on timeout it aborts the stalled stream.
    await this.closeStream(stream);
    this.logger!.debug("Push from peer complete {*}", {
      agentId: fromAgent,
      blobsStored,
    });
  }

  private async closeStream(stream: IStream) {
    try {
      await stream.close();
    } catch (error) {
      this.logger!.warn("Closing push stream failed {*}", { error });
    }
  }
}
