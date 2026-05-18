import getPort, { portNumbers } from "get-port";
import { expect, vi } from "vitest";
import {
  startNode,
  startRelay,
  type NodeEventCallbacks,
  type NodeSession,
} from "../../src/index.js";

export async function startTestRelay() {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const listenAddr = `/ip4/127.0.0.1/tcp/${port}`;
  return startRelay({ listenAddr });
}

// Starts a node connected to dialAddr and resolves only after the node has
// registered with the relay (onRelayConnected fired), so the caller can
// immediately start a second node and be guaranteed the first is visible.
export async function startTestNode(
  dialAddr: string,
  callbacks?: Partial<NodeEventCallbacks>,
): Promise<NodeSession> {
  let relayConnected = false;
  const session = await startNode({
    bootstrapRelays: [dialAddr],
    callbacks: {
      onPeerConnected: callbacks?.onPeerConnected ?? (() => {}),
      onPeerDisconnected: callbacks?.onPeerDisconnected ?? (() => {}),
      onAgentsReceived: callbacks?.onAgentsReceived ?? (() => {}),
      onRelayConnected: (address) => {
        relayConnected = true;
        callbacks?.onRelayConnected?.(address);
      },
      onMessageReceived: callbacks?.onMessageReceived ?? (() => {}),
    },
  });
  await vi.waitFor(() => expect(relayConnected).toBe(true), {
    timeout: 10_000,
  });
  return session;
}
