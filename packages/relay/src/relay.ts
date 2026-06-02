/**
 * @fileoverview Bootstrap/relay node startup.
 *
 * Wraps PeerkitRelayBuilder from @peerkit/peerkit. The builder owns the
 * agents protocol: it cbor-decodes inbound agent-info, verifies each
 * record's signature, stores the verified records in the injected
 * IAgentStore, and replays the full store to every newly connected peer.
 * This module supplies the network-access policy and feeds the relay's
 * lifecycle observers into metrics and structured logs.
 */

import { PeerkitRelayBuilder } from "@peerkit/peerkit";
import type { IAgentStore, ITransport, NodeId } from "@peerkit/api";
import type { Logger } from "./logger.js";
import type { RelayConfig } from "./config.js";
import {
  recordAgentsReceived,
  recordAgentsReplayed,
  recordPeerConnected,
  recordPeerDisconnected,
} from "./metrics.js";

/** Dependencies injected into {@link startRelay}. */
export interface StartRelayDeps {
  readonly logger: Logger;
  readonly agentStore: IAgentStore;
}

/** Handle to a running relay node. */
export interface RunningRelay {
  readonly transport: ITransport;
  readonly nodeId: NodeId;
  /** Live peer count, sourced from the relay's connected-peers set. */
  peerCount(): number;
  shutdown(): Promise<void>;
}

/** Start a bootstrap/relay node from `config` and `deps`. */
export async function startRelay(
  config: RelayConfig,
  deps: StartRelayDeps,
): Promise<RunningRelay> {
  const { logger, agentStore } = deps;
  const agents = logger.getChild("agents");
  const lifecycle = logger.getChild("lifecycle");

  const builder = new PeerkitRelayBuilder(config.networkAccessHandler)
    .withId(config.id)
    .withAddresses([...config.listenAddrs])
    .withNetworkAccessBytes(config.networkAccessBytes)
    .withAgentStore(agentStore);

  if (config.publicIp) {
    builder.withPublicIp(config.publicIp);
  }

  const relay = await builder
    .withAgentsReceivedObserver((agentIds) => {
      recordAgentsReceived(agentIds.length);
      agents.info("agents received", {
        count: agentIds.length,
        stored: agentStore.getAll().length,
      });
    })
    .withPeerConnectedObserver((nodeId) => {
      recordPeerConnected();
      // The builder replays the full store to the new peer before invoking
      // this observer, so the live store size is the number just replayed.
      const replayed = agentStore.getAll().length;
      if (replayed > 0) {
        recordAgentsReplayed(replayed);
      }
      lifecycle.info("peer connected", { nodeId, replayed });
    })
    .withPeerDisconnectedObserver((nodeId) => {
      recordPeerDisconnected();
      lifecycle.info("peer disconnected", { nodeId });
    })
    .build();

  const nodeId = relay.transport.getNodeId();
  lifecycle.info("relay started", { nodeId, listenAddrs: config.listenAddrs });

  return {
    transport: relay.transport,
    nodeId,
    peerCount: () => relay.connectedPeers.size,
    shutdown: () => relay.shutDown(),
  };
}
