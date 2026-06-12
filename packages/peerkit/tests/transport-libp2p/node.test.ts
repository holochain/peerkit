import { reset } from "@logtape/logtape";
import { setupTestLogger } from "@peerkit/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { signAgentInfo } from "../../src/agent-info.js";
import { PeerkitNodeBuilder } from "../../src/node.js";
import { webrtcDirectAddr } from "./webrtc-direct-addr.js";

beforeEach(setupTestLogger);

afterEach(reset);

test("Two nodes exchange agents bidirectionally", async () => {
  // Create node 1 listening on WebRTC Direct so node 2 can dial it directly.
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses(["/ip4/127.0.0.1/udp/0/webrtc-direct"])
    .build();
  // The dialable address carries the runtime certhash; read it after start.
  const node1DialAddr = webrtcDirectAddr(node1.transport);
  // Pre-populate node 1's agent store with its own signed agent info, so it
  // has something to send when node 2 connects.
  node1.agentStore.store([
    signAgentInfo(
      {
        agentId: node1.keyPair.agentId(),
        addresses: [node1DialAddr],
        expiresAt: Date.now() + 60_000,
      },
      node1.keyPair,
    ),
  ]);

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withAddresses(["/ip4/127.0.0.1/udp/0/webrtc-direct"])
    .build();
  const node2DialAddr = webrtcDirectAddr(node2.transport);
  // Pre-populate node 2's agent store so it also has something to send.
  node2.agentStore.store([
    signAgentInfo(
      {
        agentId: node2.keyPair.agentId(),
        addresses: [node2DialAddr],
        expiresAt: Date.now() + 60_000,
      },
      node2.keyPair,
    ),
  ]);

  // Node 2 dials node 1. Both sides fire peerConnectedCallback, so both
  // send their stored agents to the other.
  await node2.transport.connect(node1DialAddr);

  // Node 2 should receive node 1's agent info.
  await vi.waitFor(
    () => expect(node2.agentStore.get(node1.keyPair.agentId())).toBeTruthy(),
    { timeout: 5_000 },
  );
  // Node 1 should receive node 2's agent info.
  await vi.waitFor(
    () => expect(node1.agentStore.get(node2.keyPair.agentId())).toBeTruthy(),
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("PeerkitNode.send delivers a message addressed by AgentId", async () => {
  const receivedMessages: Array<{ fromAgent: string; text: string }> = [];

  // Node 1 records incoming messages with the sender's AgentId.
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async (fromAgent, data) => {
      receivedMessages.push({
        fromAgent,
        text: new TextDecoder().decode(data),
      });
    },
  })
    .withId("node1")
    .withAddresses(["/ip4/127.0.0.1/udp/0/webrtc-direct"])
    .build();
  // The dialable address carries the runtime certhash; read it after start.
  const node1DialAddr = webrtcDirectAddr(node1.transport);

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  await node2.transport.connect(node1DialAddr);

  // node2.send() resolves node1's AgentId to a NodeId internally — the caller
  // never needs to know the transport-level NodeId.
  await node2.send(node1.keyPair.agentId(), new TextEncoder().encode("hello"));

  await vi.waitFor(
    () => {
      expect(receivedMessages).toHaveLength(1);
      // Message arrives attributed to node2's AgentId, not its NodeId.
      expect(receivedMessages[0]?.fromAgent).toBe(node2.keyPair.agentId());
      expect(receivedMessages[0]?.text).toBe("hello");
    },
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("PeerkitNode.send throws when there is no connection to the agent", async () => {
  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .build();

  // An AgentId with no established connection has no NodeId mapping.
  const unknownAgentId = node.keyPair.agentId(); // own key — never connected to self
  await expect(node.send(unknownAgentId, new Uint8Array([1]))).rejects.toThrow(
    `No connection to agent ${unknownAgentId}`,
  );

  await node.shutDown();
});
