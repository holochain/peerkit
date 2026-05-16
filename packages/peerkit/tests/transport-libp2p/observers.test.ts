import { reset } from "@logtape/logtape";
import type { RelayAddress } from "@peerkit/api";
import { createNode } from "@peerkit/transport-libp2p";
import getPort, { portNumbers } from "get-port";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { signAgentInfo } from "../../src/agent-info.js";
import { PeerkitNodeBuilder } from "../../src/node.js";
import { PeerkitRelayBuilder } from "../../src/relay.js";
import { setupTestLogger } from "./util.js";

beforeEach(setupTestLogger);

afterEach(reset);

test("withAgentsReceivedObserver on node fires with agent IDs when agents arrive", async () => {
  // Node 1 listens on a known port.
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const address = `/ip4/127.0.0.1/tcp/${port}`;

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([address])
    .build();

  // Pre-populate node 1's agent store so it has something to send when node 2
  // connects.
  node1.agentStore.store([
    signAgentInfo(
      {
        agentId: node1.keyPair.agentId(),
        addresses: [address],
        expiresAt: Date.now() + 60_000,
      },
      node1.keyPair,
    ),
  ]);

  const receivedAgentIds: string[] = [];
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withAgentsReceivedObserver((agentIds) => {
      receivedAgentIds.push(...agentIds);
    })
    .build();

  await node2.transport.connect(address);

  // Observer must fire with node 1's agent ID.
  await vi.waitFor(
    () => expect(receivedAgentIds).toStrictEqual([node1.keyPair.agentId()]),
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("withRelayConnectedObserver on node fires with the relay address", async () => {
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayAddress: RelayAddress = `/ip4/0.0.0.0/tcp/${relayPort}`;

  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayAddress])
    .build();

  const relayAddresses: string[] = [];
  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .withBootstrapRelays([relayAddress])
    .withRelayConnectedObserver((address) => {
      relayAddresses.push(address);
    })
    .build();

  // Observer fires once the node has a circuit address through the relay.
  await vi.waitFor(() => expect(relayAddresses).toHaveLength(1), {
    timeout: 5_000,
  });

  await node.shutDown();
  await relay.shutDown();
});

test("withAgentsReceivedObserver on relay fires when a node sends agent info", async () => {
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayAddress: RelayAddress = `/ip4/0.0.0.0/tcp/${relayPort}`;

  const receivedAgentIds: string[] = [];
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayAddress])
    .withAgentsReceivedObserver((agentIds) => {
      receivedAgentIds.push(...agentIds);
    })
    .build();

  // The node sends its own agent info to the relay on connection,
  // so the relay's observer must fire.
  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .withBootstrapRelays([relayAddress])
    .build();

  await vi.waitFor(
    () => expect(receivedAgentIds).toStrictEqual([node.keyPair.agentId()]),
    { timeout: 5_000 },
  );

  await node.shutDown();
  await relay.shutDown();
});

test("message handler has the sender's AgentId", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1Address = `/ip4/127.0.0.1/tcp/${port}`;

  const receivedMessages: Array<{ fromAgent: string; text: string }> = [];

  // Node 1 records every incoming message together with the reported AgentId.
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
    .withAddresses([node1Address])
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  await node2.transport.connect(node1Address);

  // The AgentId↔NodeId mapping is established during the access handshake,
  // so the message handler receives the correct AgentId without any delay.
  await node2.transport.send(
    node1.transport.getNodeId(),
    new TextEncoder().encode("hello"),
  );

  await vi.waitFor(
    () => {
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]?.fromAgent).toBe(node2.keyPair.agentId());
      expect(receivedMessages[0]?.text).toBe("hello");
    },
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("message is dropped when peer does not send an AgentId prefix and access is granted", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1Address = `/ip4/127.0.0.1/tcp/${port}`;

  // Track when the transport-level message handler fires on node1 so we know
  // the message arrived and was processed and dropped by the internal handler
  // before asserting the app handler was not called.
  let transportMessageHandlerCalled = false;
  const appMessageHandler = vi.fn().mockResolvedValue(undefined);
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: appMessageHandler,
  })
    .withId("node1")
    .withAddresses([node1Address])
    .withTransportFactory(async (options) => {
      const original = options.messageHandler;
      return createNode({
        ...options,
        messageHandler: async (fromNode, data, transport) => {
          transportMessageHandlerCalled = true;
          await original(fromNode, data, transport);
        },
      });
    })
    .build();

  // node2 overrides networkAccessBytes to fewer than 32 bytes, so node1
  // cannot extract an AgentId from the access handshake.
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withTransportFactory(async (options) => {
      return createNode({
        ...options,
        networkAccessBytes: new Uint8Array([0]),
      });
    })
    .build();

  await node2.transport.connect(node1Address);
  await node2.transport.send(
    node1.transport.getNodeId(),
    new TextEncoder().encode("hello"),
  );

  // Wait for the message to arrive at the transport level, then assert it was
  // not forwarded to the app handler.
  await vi.waitFor(() => expect(transportMessageHandlerCalled).toBe(true), {
    timeout: 5_000,
  });
  expect(appMessageHandler).to.not.toHaveBeenCalled();

  await node2.shutDown();
  await node1.shutDown();
});

test("access is denied when network access bytes are wrong even though AgentId is valid", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1Address = `/ip4/127.0.0.1/tcp/${port}`;

  const VALID_NAB = 0xab;
  const INVALID_NAB = 0xcd;
  const receivedAppBytes: Uint8Array[] = [];

  // node1 expects a specific token in the app-level access bytes.
  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async (_nodeId, bytes) => {
      receivedAppBytes.push(bytes);
      return bytes[0] === VALID_NAB;
    },
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1Address])
    .build();

  // node2 sends wrong app bytes. PeerkitNodeBuilder still prepends the
  // 32-byte AgentId prefix, so the AgentId is valid — only the app bytes fail.
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withNetworkAccessBytes(new Uint8Array([INVALID_NAB]))
    .build();

  await expect(node2.transport.connect(node1Address)).rejects.toThrow();

  // node1's handler received the stripped app bytes, not the 32-byte AgentId
  // prefix, confirming that byte extraction and delegation work correctly.
  expect(receivedAppBytes).toHaveLength(1);
  expect(receivedAppBytes[0]).toHaveLength(1);
  expect(receivedAppBytes[0]?.[0]).toBe(INVALID_NAB);

  await node2.shutDown();
  await node1.shutDown();
});
