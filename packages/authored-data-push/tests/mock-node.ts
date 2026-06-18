import type { AgentId, IDataDistributionPolicy } from "@peerkit/api";
import type { IAuthoredDataSyncStore } from "@peerkit/api/authored-data";
import { MockNode } from "@peerkit/test-utils";
import { AuthoredDataPush } from "../src/index.js";
import { MemoryBlobStore } from "@peerkit/data-store";

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
  const store = new MemoryBlobStore(opts.policy, opts.maxBlobSize);
  const push = new AuthoredDataPush(store, opts.pushTimeoutMs);
  const node = new MockNode(agentId);
  push.init(node);
  return { node, store, push };
}
