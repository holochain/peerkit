/**
 * @packageDocumentation
 *
 * Authored-data push for Peerkit.
 *
 * Push propagates newly authored blobs to connected peers immediately.
 *
 * ## Protocol
 *
 * Push subscribes to the store's callback for authored blobs and opens a
 * push stream to each connected peer:
 *
 * ```
 * Author → Peer  push  { entries }
 * Author closes stream
 * ```
 *
 * Push is a fire-and-forget mechanism. There is a single message and the
 * author is the sending peer. No hash is sent: the receiver hands each entry to
 * the store, which computes the canonical hash, applies the distribution
 * policy, and stores it under the sending peer's `AgentId` with the
 * author-assigned `authoredAt` preserved as-is.
 *
 * Reception normally ends when the author closes the stream. When the sender
 * is stalling, the receiver closes the stream if no message arrives
 * within an idle timeout.
 *
 * All messages are CBOR-encoded `AuthoredDataPushMessage` values. Framing is
 * provided by the underlying `IStream` abstraction. The protocol identifier
 * `/peerkit/authored-data-push/v1` is the sole version signal.
 */
export { AuthoredDataPush } from "./authored-data-push.js";
export { FullReplicationPolicy } from "./distribution.js";
