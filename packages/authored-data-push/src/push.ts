import { getLogger } from "@logtape/logtape";
import type { Blob } from "@peerkit/api/authored-data-pull";
import { decode, encode } from "cbor-x";

const logger = getLogger(["peerkit", "authored-data-push"]);

/**
 * The single message the push protocol sends: a batch of authored blobs.
 */
export type AuthoredDataPushMessage = {
  // authoredAt is the author-assigned timestamp and must be stored as-is
  entries: Array<{ blob: Blob; authoredAt: number }>;
};

export function encodePushMessage(msg: AuthoredDataPushMessage): Uint8Array {
  return encode(msg);
}

export function decodePushMessage(
  bytes: Uint8Array,
): AuthoredDataPushMessage | null {
  try {
    const decoded: AuthoredDataPushMessage = decode(bytes);
    if (Array.isArray(decoded.entries)) {
      return decoded;
    }
    logger.warn("Received invalid authored data push message: {decoded}", {
      decoded,
    });
    return null;
  } catch (error) {
    logger.warn("Error decoding authored data push message: {error}", {
      error,
    });
    return null;
  }
}
