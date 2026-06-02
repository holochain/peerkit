import { getLogger } from "@logtape/logtape";
import type { AgentId, NodeId, RelayListenAddress } from "@peerkit/api";
import {
  PeerkitRelayBuilder,
  serializeAgentInfoList,
  type PeerkitRelay,
} from "@peerkit/peerkit";

const logger = getLogger(["peerkit", "peer-session"]);

export interface RelaySession {
  relay: PeerkitRelay;
  /** Full dial address peers can use to connect to this relay. */
  dialAddr: string;
  /** Stop the broadcast timer and shut down the relay transport. */
  shutdown(): Promise<void>;
}

export async function startRelay(options: {
  listenAddr: RelayListenAddress;
  /**
   * The public IP of the relay when it is behind NAT.
   * The transport announces this IP so peers can reach the relay.
   * The relay still binds locally to `listenAddr`.
   */
  publicIp?: string;
  onPeerConnected?: (nodeId: NodeId) => void;
  onAgentsReceived?: (agentIds: AgentId[]) => void;
}): Promise<RelaySession> {
  const builder = new PeerkitRelayBuilder(async () => true).withAddresses([
    options.listenAddr,
  ]);

  if (options.publicIp) {
    builder.withPublicIp(options.publicIp);
  }

  if (options.onPeerConnected) {
    builder.withPeerConnectedObserver(options.onPeerConnected);
  }

  // Late-binding ref: relay is assigned immediately after build() returns.
  // The observer only fires after the transport is running, which is after
  // build() completes, so relay is always defined when the observer executes.
  // eslint-disable-next-line prefer-const
  let relay: PeerkitRelay;
  // When a new agent connects and sends its agent info, broadcast it to all
  // connected peers.
  builder.withAgentsReceivedObserver((agentIds) => {
    options.onAgentsReceived?.(agentIds);
    broadcastAllAgentInfos(relay);
  });

  relay = await builder.build();
  // The transport exposes its actual listen addresses after startup.
  // Use the first one as the dial address peers use to bootstrap.
  const dialAddr = relay.transport.getListenAddresses()[0];
  if (!dialAddr) {
    throw new Error("Relay transport reported no listen addresses after start");
  }

  // Broadcast all stored agents periodically so peers that joined after a
  // node's last publish still receive fresh info well before TTL expiry.
  const BROADCAST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const broadcastTimer = setInterval(
    () => broadcastAllAgentInfos(relay),
    BROADCAST_INTERVAL_MS,
  );
  // Do not let the interval prevent the process from termination.
  (
    broadcastTimer as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();

  return {
    relay,
    dialAddr,
    async shutdown(): Promise<void> {
      clearInterval(broadcastTimer);
      await relay.shutDown();
    },
  };
}

function broadcastAllAgentInfos(relay: PeerkitRelay) {
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
}
