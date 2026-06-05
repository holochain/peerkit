import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  AgentId,
  Hash,
  IDataDistributionPolicy,
  INodeModule,
  IPeerkitNode,
  IStream,
} from "@peerkit/api";
import { getLogger, type Logger } from "@logtape/logtape";
import { BufferedStream } from "./buffered-stream.js";
import { FullReplicationPolicy } from "./distribution.js";
import {
  decodePullMessage,
  encodePullMessage,
  uint8ArraysEqual as xorSumHashMatches,
  xorHashes,
} from "./pull.js";
import type { IAuthoredDataSyncStore, Blob } from "./types/store.js";

const AUTHORED_DATA_SYNC_PROTOCOL = "/peerkit/authored-data-sync/v1";
const PULL_TIMEOUT = 1000 * 5; // 5 seconds
const DEFAULT_PULL_INTERVAL_MS = 3 * 60 * 1_000; // Every 3 minutes
const DEFAULT_EPOCH_DURATION_MS = 24 * 60 * 60 * 1_000; // 1 day
const DEFAULT_MAX_BLOB_SIZE = 1024 * 1024 * 20; // 20 MiB

export class AuthoredDataSync implements INodeModule {
  private isRunning: boolean;
  private core: IPeerkitNode | undefined;
  private pullTimer: ReturnType<typeof setInterval> | undefined;
  private readonly dataSyncStore: IAuthoredDataSyncStore;
  private readonly policy: IDataDistributionPolicy;
  private readonly pullIntervalMs: number;
  private readonly epochDurationMs: number;
  private readonly pullTimeoutMs: number;
  private readonly maxBlobSize: number;
  private readonly lastPullTime = new Map<AgentId, number>();
  private lastAuthoredAt = 0;
  private logger: Logger | undefined;

  constructor(
    dataSyncStore: IAuthoredDataSyncStore,
    strategy: IDataDistributionPolicy,
    pullIntervalMs: number,
    epochDurationMs?: number,
    pullTimeoutMs?: number,
    maxBlobSize?: number,
  ) {
    this.isRunning = false;
    this.dataSyncStore = dataSyncStore;
    this.policy = strategy ?? new FullReplicationPolicy();
    this.pullIntervalMs = pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.epochDurationMs = epochDurationMs ?? DEFAULT_EPOCH_DURATION_MS;
    this.maxBlobSize = maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
    this.pullTimeoutMs = pullTimeoutMs ?? PULL_TIMEOUT;
  }

  init(core: IPeerkitNode): void {
    this.core = core;
    this.logger = getLogger(["peerkit", "authored-data-sync"]).with({
      agentId: core.ownAgentId,
    });
    // Restore the authoring clock across restarts so newly authored blobs never
    // land below a last-known timestamp a peer already advanced past.
    this.lastAuthoredAt =
      this.dataSyncStore.getLastKnownByAuthor(core.ownAgentId)?.authoredAt ?? 0;
    core.registerStreamHandler(
      AUTHORED_DATA_SYNC_PROTOCOL,
      (_fromAgent, stream) => {
        void this.handleIncomingPullStream(stream);
      },
    );
    this.logger.info("AuthoredDataSync initialized");
  }

  /**
   * Hash the blob, store it under ownAgentId, and return the hash.
   *
   * @param blob The blob to store
   */
  store(blob: Blob) {
    if (blob.byteLength > this.maxBlobSize) {
      throw new Error(
        `Blob to be stored too large: ${blob.byteLength} > ${this.maxBlobSize}`,
      );
    }
    const hash = blake2s(blob);
    const authoredAt = this.nextAuthoredAt();
    this.dataSyncStore.put(hash, blob, this.core!.ownAgentId, authoredAt);
    this.logger!.trace("Stored blob {*}", { hash: bytesToHex(hash) });
    return hash;
  }

  /**
   * Get a stored blob by its hash and author
   */
  get(hash: Hash, author: AgentId) {
    return this.dataSyncStore.get(hash, author);
  }

  /**
   * Either the current timestamp or the last used authoredAt timestamp,
   * to guarantee monotonically increasing timestamps.
   */
  private nextAuthoredAt(): number {
    this.lastAuthoredAt = Math.max(Date.now(), this.lastAuthoredAt);
    return this.lastAuthoredAt;
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
      for (const { hash, blob, authoredAt } of msg.entries) {
        if (blob.byteLength > this.maxBlobSize) {
          this.logger!.warn("Received blob that exceeds max blob size {*}", {
            fromAgent: remoteAgentId,
            blobSize: blob.byteLength,
          });
          continue;
        }
        if (!this.policy.willStore(remoteAgentId, hash)) {
          continue;
        }
        if (!xorSumHashMatches(blake2s(blob), hash)) {
          this.logger!.warn("Received blob with invalid hash {*}", {
            agentId: remoteAgentId,
            hash: bytesToHex(hash),
          });
          continue;
        }
        // Store the author's authoredAt as-is; never re-stamp locally.
        this.dataSyncStore.put(hash, blob, remoteAgentId, authoredAt);
        blobsReceived++;
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

    // Recent: delta only. getByAuthorSince already returns ascending by
    // authoredAt, so a truncated send is a valid prefix. Because recentSince is
    // >= epochStart, this slice is exactly the recent segment at or above it —
    // no separate epoch filter needed.
    const recentToSend = this.dataSyncStore
      .getByAuthorSince(ownAgentId, request.recentSince)
      .filter((b) => this.policy.willStore(ownAgentId, b.hash));

    // Historical: full segment, for the XOR summary and resend-on-mismatch.
    // XOR summaries must be computed over the policy-filtered set, because the
    // initiator won't hold blobs that it won't store. Including them here would
    // cause a permanent mismatch and trigger redundant sends on every round.
    const historicalBlobs = this.dataSyncStore
      .getByAuthorBefore(ownAgentId, epochStart)
      .filter((b) => this.policy.willStore(ownAgentId, b.hash));

    if (recentToSend.length > 0) {
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
    }

    // Historical: unchanged XOR-summary reconciliation (resend whole segment on
    // mismatch).
    const sendHist = !xorSumHashMatches(
      xorHashes(historicalBlobs.map((blob) => blob.hash)),
      request.historicalSummary,
    );
    if (sendHist) {
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
