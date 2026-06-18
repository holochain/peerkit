import { getLogger } from "@logtape/logtape";
import type { AgentId, Hash } from "@peerkit/api";
import type { Blob } from "@peerkit/api/authored-data";
import { decode, encode } from "cbor-x";

const logger = getLogger(["peerkit", "authored-data-pull"]);

export type AuthoredDataSyncMessage =
  | {
      type: "request";
      requesterAgentId: AgentId;
      epochStart: number;
      // Inclusive lower bound for the recent segment: the responder replies with
      // recent blobs whose authoredAt >= this value.
      recentSince: number;
      // XOR summary of the historical segment hashes
      historicalSummary: Hash;
    }
  | {
      type: "blobs";
      agentId: AgentId;
      segment: "recent" | "historical";
      // authoredAt is the author-assigned timestamp and must
      // be stored as-is
      entries: Array<{ hash: Hash; blob: Blob; authoredAt: number }>;
    };

/** XOR all hashes together into a 32-byte summary. Empty set yields all-zeros. */
export function xorHashes(hashes: Uint8Array[]): Uint8Array {
  if (hashes.length === 0 || hashes[0] === undefined) {
    return new Uint8Array(32);
  }
  if (hashes[0].length !== 32) {
    throw new Error(`Expected 32-byte hash, got ${hashes[0].length}`);
  }
  const result = new Uint8Array(hashes[0]);
  for (let i = 1; i < hashes.length; i++) {
    const hash = hashes[i]!;
    if (hash.length !== 32) {
      throw new Error(`Expected 32-byte hash, got ${hash.length}`);
    }
    for (let i = 0; i < 32; i++) {
      result[i]! ^= hash[i]!;
    }
  }
  return result;
}

export function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function encodePullMessage(msg: AuthoredDataSyncMessage): Uint8Array {
  return encode(msg);
}

export function decodePullMessage(
  bytes: Uint8Array,
): AuthoredDataSyncMessage | null {
  try {
    const decoded: AuthoredDataSyncMessage = decode(bytes);
    const { type } = decoded;
    if (type === "request" || type === "blobs") {
      return decoded;
    }
    logger.warn("Received invalid authored data sync message: {decoded}", {
      decoded,
    });
    return null;
  } catch (error) {
    logger.warn("Error decoding authored data sync message: {error}", {
      error,
    });
    return null;
  }
}
