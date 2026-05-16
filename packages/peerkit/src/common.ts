import type {
  AgentInfoSigned,
  AgentsReceivedCallback,
  IAgentStore,
  NodeId,
} from "@peerkit/api";
import { deserializeAgentInfoList } from "./serialize.js";
import type { Logger } from "@logtape/logtape";
import { verifyAgentInfo } from "./agent-info.js";

export type AgentsReceivedObserver = (
  fromNode: NodeId,
  agentInfos: AgentInfoSigned[],
) => void;

/**
 * Creates an {@link AgentsReceivedCallback} with a passed in logger and
 * agent store. If an observer is provided, it is called after valid agents have
 * been stored, receiving the node ID and the IDs of the stored agents.
 */
export const getAgentsReceivedCallback = (
  logger: Logger,
  agentStore: IAgentStore,
  observer?: AgentsReceivedObserver,
): AgentsReceivedCallback => {
  return async (fromNode, bytes) => {
    let agentList;
    try {
      agentList = deserializeAgentInfoList(bytes);
    } catch (error) {
      logger.warn("Failed to deserialize agent info bytes {*}", {
        fromNode,
        error,
      });
      return;
    }
    logger.info("Received agent info {*}", { fromNode, agentList });
    const verifiedAgentInfos = agentList.filter((agentInfo) => {
      const valid = verifyAgentInfo(agentInfo, logger);
      if (!valid) {
        logger.warn("Received an invalid agent info {*}", {
          fromNode,
          agentInfo,
        });
      }
      return valid;
    });
    if (verifiedAgentInfos.length) {
      agentStore.store(verifiedAgentInfos);
      observer?.(fromNode, verifiedAgentInfos);
    }
  };
};
