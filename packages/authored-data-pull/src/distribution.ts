import type { AgentId, Hash, IDataDistributionPolicy } from "@peerkit/api";

/**
 * Built-in default: FullReplicationStrategy (always returns true).
 */
export class FullReplicationPolicy implements IDataDistributionPolicy {
  willStore(_peerId: AgentId, _blobHash: Hash): boolean {
    return true;
  }
}
