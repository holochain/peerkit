import type { AgentId, IDataDistributionPolicy } from "@peerkit/api";
import { MockNode } from "@peerkit/test-utils";
import {
  AuthoredDataSync,
  FullReplicationStrategy as FullReplicationPolicy,
  MemoryBlobStore,
} from "../src/index.js";
import { IAuthoredDataSyncStore } from "../src/types/store.js";

// Re-export test utils
export { MockNode, MockStream, makeStreamPair } from "@peerkit/test-utils";

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
  const store = new MemoryBlobStore();
  const dataSync = new AuthoredDataSync(store, policy, 5_000);
  const node = new MockNode(agentId);
  dataSync.init(node);
  return { node, store, dataSync };
}
