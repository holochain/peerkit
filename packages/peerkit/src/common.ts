import type { AgentsReceivedCallback, IAgentStore } from "@peerkit/api";
import { deserializeAgentInfoList } from "./serialize.js";
import type { Logger } from "@logtape/logtape";
import { verifyAgentInfo } from "./agent-info.js";

/**
 * Creates an {@link AgentsReceivedCallback} with a passed in logger and
 * agent store.
 */
export const getAgentsReceivedCallback = (
  logger: Logger,
  agentStore: IAgentStore,
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
    agentStore.store(verifiedAgentInfos);
  };
};
