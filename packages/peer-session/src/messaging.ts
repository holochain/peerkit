import type { AgentId } from "@peerkit/api";
import type { AppMessageHandler, PeerkitNode } from "@peerkit/peerkit";

export async function sendTextMessage(
  node: PeerkitNode,
  toAgent: AgentId,
  text: string,
): Promise<void> {
  await node.send(toAgent, new TextEncoder().encode(text));
}

export function createTextMessageHandler(
  onMessage: (fromAgent: AgentId, text: string) => void,
): AppMessageHandler {
  return async (fromAgent, message) => {
    onMessage(fromAgent, new TextDecoder().decode(message));
  };
}
