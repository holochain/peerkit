import { getLogger } from "@logtape/logtape";
import type { AgentId, NodeId } from "@peerkit/api";
import {
  PeerkitRelayBuilder,
  serializeAgentInfoList,
  type PeerkitRelay,
} from "@peerkit/peerkit";

const logger = getLogger(["peerkit", "peer-session"]);

export interface RelaySession {
  relay: PeerkitRelay;
  /** Full dial address peers can use to connect: `<listenAddr>/p2p/<peerId>` */
  dialAddr: string;
}

export async function startRelay(options: {
  listenAddr: string;
  onPeerConnected?: (nodeId: NodeId) => void;
  onAgentsReceived?: (agentIds: AgentId[]) => void;
}): Promise<RelaySession> {
  const builder = new PeerkitRelayBuilder(async () => true).withAddresses([
    options.listenAddr,
  ]);

  if (options.onPeerConnected) {
    builder.withPeerConnectedObserver(options.onPeerConnected);
  }

  // Late-binding ref: relay is assigned immediately after build() returns.
  // The observer only fires after the transport is running, which is after
  // build() completes, so relay is always defined when the observer executes.
  // eslint-disable-next-line prefer-const
  let relay: PeerkitRelay;
  builder.withAgentsReceivedObserver((agentIds) => {
    options.onAgentsReceived?.(agentIds);
    const agents = relay.agentStore.getAll();
    if (agents.length === 0) return;
    const bytes = serializeAgentInfoList(agents);
    for (const nodeId of relay.connectedPeers) {
      relay.transport.sendAgents(nodeId, bytes).catch((error) => {
        logger.error("Failed to broadcast agents to {nodeId}: {error}", {
          nodeId,
          error,
        });
      });
    }
  });

  relay = await builder.build();
  const dialAddr = `${options.listenAddr}/p2p/${relay.transport.getNodeId()}`;

  return { relay, dialAddr };
}
