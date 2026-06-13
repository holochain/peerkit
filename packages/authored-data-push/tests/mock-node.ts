import type { AgentId, IDataDistributionPolicy } from "@peerkit/api";
import type { IAuthoredDataSyncStore } from "@peerkit/api/authored-data-pull";
import { MemoryBlobStore } from "@peerkit/authored-data-pull";
import { MockNode } from "@peerkit/test-utils";
import { FullReplicationPolicy } from "../src/distribution.js";
import { AuthoredDataPush } from "../src/index.js";

// Re-export test utils
export { makeStreamPair, MockNode, MockStream } from "@peerkit/test-utils";

export interface MockPeer {
  node: MockNode;
  store: IAuthoredDataSyncStore;
  push: AuthoredDataPush;
}

/** Creates an AuthoredDataPush wired to a MockNode. */
export function createMockPeer(
  agentId: AgentId,
  opts: {
    policy?: IDataDistributionPolicy;
    maxBlobSize?: number;
    pushTimeoutMs?: number;
  } = {},
): MockPeer {
  const store = new MemoryBlobStore(
    opts.policy ?? new FullReplicationPolicy(),
    opts.maxBlobSize,
  );
  const push = new AuthoredDataPush(store, opts.pushTimeoutMs);
  const node = new MockNode(agentId);
  push.init(node);
  return { node, store, push };
}
