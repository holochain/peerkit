import type { AgentId, IDataDistributionPolicy } from "@peerkit/api";
import { IAuthoredDataSyncStore } from "@peerkit/api/authored-data-sync";
import { MockNode } from "@peerkit/test-utils";
import { AuthoredDataSync } from "../src/index.js";
import { FullReplicationPolicy } from "./util.js";
import { MemoryBlobStore } from "@peerkit/data-store";

// Re-export test utils
export { makeStreamPair, MockNode, MockStream } from "@peerkit/test-utils";

export interface MockPeer {
  node: MockNode;
  store: IAuthoredDataSyncStore;
  dataSync: AuthoredDataSync;
}

/** Creates an AuthoredDataSync wired to a MockNode, without starting the pull timer. */
export function createMockPeer(
  agentId: AgentId,
  policy: IDataDistributionPolicy = new FullReplicationPolicy(),
): MockPeer {
  const store = new MemoryBlobStore(policy);
  const dataSync = new AuthoredDataSync(store, policy, 5_000);
  const node = new MockNode(agentId);
  dataSync.init(node);
  return { node, store, dataSync };
}
