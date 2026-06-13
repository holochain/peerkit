import { getLogger, type Logger } from "@logtape/logtape";
import type {
  AgentId,
  Hash,
  IDataDistributionPolicy,
  INodeModule,
  IPeerkitNode,
  IStream,
} from "@peerkit/api";
import type {
  Blob,
  IAuthoredDataSyncStore,
} from "@peerkit/api/authored-data-pull";
import { BufferedStream } from "./buffered-stream.js";
import { FullReplicationPolicy } from "./distribution.js";
import {
  decodePullMessage,
  encodePullMessage,
  xorHashes,
  uint8ArraysEqual as xorSumHashMatches,
} from "./pull.js";

const AUTHORED_DATA_SYNC_PROTOCOL = "/peerkit/authored-data-pull/v1";
const PULL_TIMEOUT = 1000 * 5; // 5 seconds
const DEFAULT_PULL_INTERVAL_MS = 3 * 60 * 1_000; // Every 3 minutes
const DEFAULT_EPOCH_DURATION_MS = 24 * 60 * 60 * 1_000; // 1 day

export class AuthoredDataSync implements INodeModule {
  private isRunning: boolean;
  private core: IPeerkitNode | undefined;
  private pullTimer: ReturnType<typeof setInterval> | undefined;
  private readonly dataSyncStore: IAuthoredDataSyncStore;
  private readonly policy: IDataDistributionPolicy;
  private readonly pullIntervalMs: number;
  private readonly epochDurationMs: number;
  private readonly pullTimeoutMs: number;
  private readonly lastPullTime = new Map<AgentId, number>();
  private logger: Logger | undefined;

  constructor(
    dataSyncStore: IAuthoredDataSyncStore,
    strategy: IDataDistributionPolicy,
    pullIntervalMs: number,
    epochDurationMs?: number,
    pullTimeoutMs?: number,
  ) {
    this.isRunning = false;
    this.dataSyncStore = dataSyncStore;
    this.policy = strategy ?? new FullReplicationPolicy();
    this.pullIntervalMs = pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.epochDurationMs = epochDurationMs ?? DEFAULT_EPOCH_DURATION_MS;
    this.pullTimeoutMs = pullTimeoutMs ?? PULL_TIMEOUT;
  }

  init(core: IPeerkitNode): void {
    this.core = core;
    this.logger = getLogger(["peerkit", "authored-data-pull"]).with({
      agentId: core.ownAgentId,
    });
    core.registerStreamHandler(
      AUTHORED_DATA_SYNC_PROTOCOL,
      (_fromAgent, stream) => {
        void this.handleIncomingPullStream(stream);
      },
    );
    this.logger.info("AuthoredDataSync initialized");
  }

  /**
   * Author a blob: store it under ownAgentId via the store (which owns hashing
   * and the authoring clock) and return its hash.
   *
   * @param blob The blob to store
   */
  store(blob: Blob): Hash {
    return this.dataSyncStore.store(blob, this.core!.ownAgentId);
  }

  /**
   * Get a stored blob by its hash and author
   */
  get(hash: Hash, author: AgentId) {
    return this.dataSyncStore.get(hash, author);
  }

  /**
   * Run one pull round with every currently connected peer, in sequence.
   */
  async pullFromAllPeers(): Promise<void> {
    // Peers are visited most-stale-first, so attention is spread evenly.
    const peers = [...this.core!.getConnectedAgents()].sort(
      (a, b) =>
        (this.lastPullTime.get(a) ?? 0) - (this.lastPullTime.get(b) ?? 0),
    );
    for (const agentId of peers) {
      try {
        await this.pullFromPeer(agentId);
      } catch (error) {
        this.logger!.warn("Pull failure {*}", { agentId, error });
      }
    }
  }

  async start() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.pullAtInterval();

    this.logger!.info("Pull started {*}", {
      intervalMs: this.pullIntervalMs,
    });
  }

  private pullAtInterval = async () => {
    // In case this module has been stopped in the meantime
    if (!this.isRunning) {
      return;
    }
    await this.pullFromAllPeers();
    // In case this module has been stopped in the meantime
    if (!this.isRunning) {
      return;
    }
    this.pullTimer = setTimeout(this.pullAtInterval, this.pullIntervalMs);
  };

  async stop() {
    this.isRunning = false;
    if (this.pullTimer !== undefined) {
      clearTimeout(this.pullTimer);
      this.pullTimer = undefined;
      this.logger!.info("Pull stopped");
    }
  }

  /**
   * Request all authored blobs from the peer that this node  does not yet
   * hold.
   *
   * Requester side of the pull. See package docs for the full protocol sequence.
   */
  async pullFromPeer(remoteAgentId: AgentId): Promise<void> {
    const core = this.core!;
    const now = Date.now();
    const epochStart =
      Math.floor(now / this.epochDurationMs) * this.epochDurationMs;

    // Caution - Hand-written comment (despite the Claudy dash):
    // Look up the most recent blob this node holds from the peer. Its
    // `authoredAt` timestamp will be sent in the pull request.
    // If there is no blob by the peer in the store yet, the epoch start
    // serves as the bound.
    // The responder will return all blobs authored at or after that
    // `recentSince` timestamp, i.e. where `authoredAt >= recentSince`.
    const heldRecent = this.dataSyncStore
      .getByAuthorSince(remoteAgentId, epochStart)
      .filter((b) => this.policy.willStore(remoteAgentId, b.hash));
    const lastAuthored = heldRecent.at(-1)?.authoredAt;
    const recentSince = lastAuthored ?? epochStart;

    // Historical still uses the XOR summary, filtered to what the peer will
    // store so both sides compute a matching summary. The peer will otherwise
    // never compute a matching hash of all their data.
    const knownHist = this.dataSyncStore
      .getByAuthorBefore(remoteAgentId, epochStart)
      .filter((blob) => this.policy.willStore(remoteAgentId, blob.hash));

    this.logger!.debug("Opening pull stream to peer {*}", {
      agentId: remoteAgentId,
    });
    let stream;
    try {
      stream = await core.createStream(
        remoteAgentId,
        AUTHORED_DATA_SYNC_PROTOCOL,
      );
    } catch {
      this.logger!.warn("Failed to open pull stream to peer {*}", {
        agentId: remoteAgentId,
      });
      return;
    }

    const buffered = new BufferedStream(stream);

    stream.send(
      encodePullMessage({
        type: "request",
        requesterAgentId: core.ownAgentId,
        epochStart,
        recentSince,
        historicalSummary: xorHashes(knownHist.map((e) => e.hash)),
      }),
    );

    // Read blobs until the stream closes or pullTimeoutMs elapses with no
    // new message (e.g. a slow or misbehaving responder).
    let blobsReceived = 0;
    while (true) {
      // Set and clear timeouts for every awaited blob
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        // Keep record of the timer
        timeoutId = setTimeout(() => resolve("timeout"), this.pullTimeoutMs);
      });
      const result = await Promise.race([buffered.next(), timeoutPromise]);
      if (result !== "timeout" && timeoutId !== undefined) {
        // Blob has been received, clear timeout
        clearTimeout(timeoutId);
      }
      if (result === "timeout") {
        this.logger!.warn("Pull timed out waiting for blobs {*}", {
          agentId: remoteAgentId,
        });
        break;
      }
      if (result === null) {
        // Pull complete
        this.lastPullTime.set(remoteAgentId, Date.now());
        break;
      }
      const msg = decodePullMessage(result);
      if (msg === null || msg.type !== "blobs") continue;
      for (const { blob, authoredAt } of msg.entries) {
        // Blobs that are oversized or return false for the distribution
        // policy are skipped.
        if (
          this.dataSyncStore.accept(blob, remoteAgentId, authoredAt) !== null
        ) {
          blobsReceived++;
        }
      }
    }

    this.logger!.debug("Pull with peer complete {*}", {
      agentId: remoteAgentId,
      blobsReceived,
    });

    await this.closeStream(stream);
  }

  /** Responder side of the pull exchange. See package docs for the full protocol sequence. */
  private async handleIncomingPullStream(stream: IStream): Promise<void> {
    const core = this.core;
    if (core === undefined) return;
    const ownAgentId = core.ownAgentId;

    const buffered = new BufferedStream(stream);

    const requestBytes = await buffered.next();
    if (requestBytes === null) {
      this.logger!.warn("Received empty pull stream, closing");
      await this.closeStream(stream);
      return;
    }
    const request = decodePullMessage(requestBytes);
    if (request === null || request.type !== "request") {
      this.logger!.warn("Received invalid pull request message, closing");
      await this.closeStream(stream);
      return;
    }

    const initiatingAgentId = request.requesterAgentId;
    const epochStart = request.epochStart;
    this.logger!.debug("Incoming pull request from {*}", {
      initiatingAgentId,
    });

    // Recent: send all authored blobs since the timestamp the initiator
    // provided.
    const recentToSend = this.dataSyncStore
      .getByAuthorSince(ownAgentId, request.recentSince)
      .filter((b) => this.policy.willStore(ownAgentId, b.hash));

    // Historical: send all authored historical blobs.
    // Must consider the distribution policy, otherwise the XOR sum the
    // initiator sends can never match and all historical data would
    // be sent on every pull.
    const historicalBlobs = this.dataSyncStore
      .getByAuthorBefore(ownAgentId, epochStart)
      .filter((b) => this.policy.willStore(ownAgentId, b.hash));

    if (recentToSend.length > 0) {
      try {
        stream.send(
          encodePullMessage({
            type: "blobs",
            agentId: ownAgentId,
            segment: "recent",
            entries: recentToSend.map((e) => ({
              hash: e.hash,
              blob: e.blob,
              authoredAt: e.authoredAt,
            })),
          }),
        );
      } catch (error) {
        this.logger!.warn("Failed to send recent blobs to peer {*}", {
          agentId: initiatingAgentId,
          error,
        });
      }
    }

    // Historical: resend all historical blobs when XOR sum mismatches
    const sendHist = !xorSumHashMatches(
      xorHashes(historicalBlobs.map((blob) => blob.hash)),
      request.historicalSummary,
    );
    if (sendHist) {
      try {
        stream.send(
          encodePullMessage({
            type: "blobs",
            agentId: ownAgentId,
            segment: "historical",
            entries: historicalBlobs.map((e) => ({
              hash: e.hash,
              blob: e.blob,
              authoredAt: e.authoredAt,
            })),
          }),
        );
      } catch (error) {
        this.logger!.warn("Failed to send historical blobs to peer {*}", {
          agentId: initiatingAgentId,
          error,
        });
      }
    }

    this.logger!.debug("Responded to pull request {*}", {
      requesterAgentId: initiatingAgentId,
      recentSent: recentToSend.length,
      historicalSent: sendHist ? historicalBlobs.length : 0,
    });

    await this.closeStream(stream);
  }

  private async closeStream(stream: IStream) {
    try {
      await stream.close();
    } catch (error) {
      this.logger!.warn("Closing pull stream failed {*}", { error });
    }
  }
}
