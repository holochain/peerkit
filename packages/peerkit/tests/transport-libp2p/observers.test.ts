import { reset } from "@logtape/logtape";
import type {
  NodeAddress,
  RelayDialAddress,
  RelayListenAddress,
} from "@peerkit/api";
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
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .build();

  // Pre-populate node 1's agent store so it has something to send when node 2
  // connects.
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

  await node2.transport.connect(node1DialAddr);

  // Observer must fire with node 1's agent ID as the advertised agent.
  await vi.waitFor(
    () => {
      expect(receivedAgentIds).toStrictEqual([node1.keyPair.agentId()]);
    },
    { timeout: 5_000 },
  );

  await node2.shutDown();
  await node1.shutDown();
});

test("withRelayConnectedObserver on node fires with the relay address", async () => {
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayListenAddr: RelayListenAddress = `0.0.0.0:${relayPort}`;
  const relayDialAddress: RelayDialAddress = `/ip4/127.0.0.1/tcp/${relayPort}/ws`;

  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayListenAddr])
    .build();

  const relayAddresses: string[] = [];
  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .withBootstrapRelays([relayDialAddress])
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
  const relayListenAddr = `0.0.0.0:${relayPort}`;
  const relayBootstrapAddr: RelayDialAddress = `/ip4/127.0.0.1/tcp/${relayPort}/ws`;

  const receivedAgentIds: string[] = [];
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayListenAddr])
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
    .withBootstrapRelays([relayBootstrapAddr])
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
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

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
    .withAddresses([node1DialAddr])
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  await node2.transport.connect(node1DialAddr);

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
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

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
    .withAddresses([node1DialAddr])
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

  await node2.transport.connect(node1DialAddr);
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

test("withPeerDisconnectedObserver on node fires with AgentId when peer disconnects", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  // node1 records connected and disconnected agent IDs so it can be asserted
  // the disconnect observer fires with the correct AgentId and cleans up
  // mappings.
  const connectedAgents: string[] = [];
  const disconnectedAgents: string[] = [];

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .withPeerConnectedObserver((fromAgent) => {
      connectedAgents.push(fromAgent);
    })
    .withPeerDisconnectedObserver((fromAgent) => {
      disconnectedAgents.push(fromAgent);
    })
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  await node2.transport.connect(node1DialAddr);

  // Wait for the access handshake to complete, so node1 has the AgentId mapping.
  await vi.waitFor(() => expect(connectedAgents).toHaveLength(1), {
    timeout: 5_000,
  });
  expect(connectedAgents[0]).toBe(node2.keyPair.agentId());

  // node2 closes the connection; node1's disconnect observer must fire.
  await node2.transport.disconnect(node1.transport.getNodeId());

  await vi.waitFor(() => expect(disconnectedAgents).toHaveLength(1), {
    timeout: 5_000,
  });
  // The observer reports node2's AgentId, not a transport-level NodeId.
  expect(disconnectedAgents[0]).toBe(node2.keyPair.agentId());

  await node2.shutDown();
  await node1.shutDown();
});

test("withPeerDisconnectedObserver on node fires with AgentId when peer shuts down abruptly", async () => {
  // Peer shuts down rather than a graceful disconnect().
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  const connectedAgents: string[] = [];
  const disconnectedAgents: string[] = [];

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .withPeerConnectedObserver((fromAgent) => {
      connectedAgents.push(fromAgent);
    })
    .withPeerDisconnectedObserver((fromAgent) => {
      disconnectedAgents.push(fromAgent);
    })
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  await node2.transport.connect(node1DialAddr);

  // Wait for the handshake so node1 has node2's AgentId in its maps.
  await vi.waitFor(() => expect(connectedAgents).toHaveLength(1), {
    timeout: 5_000,
  });

  // node2 vanishes: shutDown() aborts connections without a graceful close.
  const node2AgentId = node2.keyPair.agentId();
  await node2.shutDown();

  await vi.waitFor(() => expect(disconnectedAgents).toHaveLength(1), {
    timeout: 5_000,
  });
  expect(disconnectedAgents[0]).toBe(node2AgentId);

  await node1.shutDown();
});

test("withPeerDisconnectedObserver on node cleans up AgentId maps on disconnect", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .build();

  const disconnectedAgents: string[] = [];
  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .withPeerDisconnectedObserver((fromAgent) => {
      disconnectedAgents.push(fromAgent);
    })
    .build();

  await node2.transport.connect(node1DialAddr);

  // After disconnect, send() via the AgentId should throw because the mapping
  // has been pruned — a stale NodeId would otherwise silently fail later.
  await node1.transport.disconnect(node2.transport.getNodeId());

  await vi.waitFor(() => expect(disconnectedAgents).toHaveLength(1), {
    timeout: 5_000,
  });

  // The AgentId→NodeId mapping is gone, so node2.send() throws.
  await expect(
    node2.send(node1.keyPair.agentId(), new Uint8Array([1])),
  ).rejects.toThrow();

  await node2.shutDown();
  await node1.shutDown();
});

test("PeerkitRelayBuilder connectedPeers tracks connections and disconnections", async () => {
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayListenAddr = `0.0.0.0:${relayPort}`;
  const relayDialAddr: RelayDialAddress = `/ip4/127.0.0.1/tcp/${relayPort}/ws`;

  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayListenAddr])
    .build();

  const nodePort = await getPort({ port: portNumbers(30_000, 40_000) });
  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .withAddresses([`/ip4/127.0.0.1/tcp/${nodePort}/ws`])
    .build();

  await node.transport.connect(relayDialAddr);

  // The relay should record the node as connected after the handshake.
  await vi.waitFor(() => expect(relay.connectedPeers.size).toBe(1), {
    timeout: 5_000,
  });

  // Disconnect node from relay; relay's connectedPeers must be pruned.
  await node.transport.disconnect(relay.transport.getNodeId());

  await vi.waitFor(() => expect(relay.connectedPeers.size).toBe(0), {
    timeout: 5_000,
  });

  await node.shutDown();
  await relay.shutDown();
});

test("PeerkitRelayBuilder prunes a disconnected peer's agent info from the store", async () => {
  const relayPort = await getPort({ port: portNumbers(30_000, 40_000) });
  const relayListenAddr = `0.0.0.0:${relayPort}`;
  const relayDialAddr: RelayDialAddress = `/ip4/127.0.0.1/tcp/${relayPort}/ws`;

  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("relay")
    .withAddresses([relayListenAddr])
    .build();

  const node = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node")
    .withBootstrapRelays([relayDialAddr])
    .build();

  const agentId = node.keyPair.agentId();

  // The node advertises its own agent info to the relay on connect, so the
  // relay's store must contain it.
  await vi.waitFor(
    () =>
      expect(relay.agentStore.getAll().map((info) => info.agentId)).toContain(
        agentId,
      ),
    { timeout: 5_000 },
  );
  // When the node disconnects its circuit reservation is dropped, so the relay
  // must drop the now-undialable agent info instead of replaying it to new
  // peers — replaying it makes their dial fail with NO_RESERVATION.
  await node.transport.disconnect(relay.transport.getNodeId());

  await vi.waitFor(
    () =>
      expect(
        relay.agentStore.getAll().map((info) => info.agentId),
      ).not.toContain(agentId),
    { timeout: 5_000 },
  );

  await node.shutDown();
  await relay.shutDown();
});

test("access is denied when network access bytes are wrong even though AgentId is valid", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

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
    .withAddresses([node1DialAddr])
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

  await expect(node2.transport.connect(node1DialAddr)).rejects.toThrow();

  // node1's handler received the stripped app bytes, not the 32-byte AgentId
  // prefix, confirming that byte extraction and delegation work correctly.
  expect(receivedAppBytes).toHaveLength(1);
  expect(receivedAppBytes[0]).toHaveLength(1);
  expect(receivedAppBytes[0]?.[0]).toBe(INVALID_NAB);

  await node2.shutDown();
  await node1.shutDown();
});

test("PeerkitNode.isConnected reflects live connection state by AgentId", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  // Before any connection, neither node knows of the other as an AgentId.
  expect(node1.isConnected(node2.keyPair.agentId())).toBe(false);
  expect(node2.isConnected(node1.keyPair.agentId())).toBe(false);

  await node2.transport.connect(node1DialAddr);

  // The AgentId↔NodeId mapping is established during the access handshake, so
  // node2 can check by AgentId immediately after connect() resolves.
  expect(node2.isConnected(node1.keyPair.agentId())).toBe(true);
  // node1 learns node2's AgentId asynchronously via its access handler.
  await vi.waitFor(
    () => expect(node1.isConnected(node2.keyPair.agentId())).toBe(true),
    {
      timeout: 5_000,
    },
  );

  await node2.transport.disconnect(node1.transport.getNodeId());

  // After disconnect, both sides report false by AgentId.
  await vi.waitFor(
    () => expect(node1.isConnected(node2.keyPair.agentId())).toBe(false),
    {
      timeout: 5_000,
    },
  );
  expect(node2.isConnected(node1.keyPair.agentId())).toBe(false);

  await node2.shutDown();
  await node1.shutDown();
});

test("PeerkitNode.getConnectedAgents lists AgentIds of connected peers", async () => {
  const port = await getPort({ port: portNumbers(30_000, 40_000) });
  const node1DialAddr: NodeAddress = `/ip4/127.0.0.1/tcp/${port}/ws`;

  const node1 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node1")
    .withAddresses([node1DialAddr])
    .build();

  const node2 = await new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async () => {},
  })
    .withId("node2")
    .build();

  // No connection yet — both lists must be empty.
  expect(node1.getConnectedAgents()).toHaveLength(0);
  expect(node2.getConnectedAgents()).toHaveLength(0);

  await node2.transport.connect(node1DialAddr);

  // node2 knows node1's AgentId immediately after connect().
  expect(node2.getConnectedAgents()).toContain(node1.keyPair.agentId());
  // node1 learns node2's AgentId asynchronously via its access handler.
  await vi.waitFor(
    () => expect(node1.getConnectedAgents()).toContain(node2.keyPair.agentId()),
    { timeout: 5_000 },
  );

  await node2.transport.disconnect(node1.transport.getNodeId());

  // After disconnect, both lists must be empty again.
  await vi.waitFor(() => expect(node1.getConnectedAgents()).toHaveLength(0), {
    timeout: 5_000,
  });
  expect(node2.getConnectedAgents()).toHaveLength(0);

  await node2.shutDown();
  await node1.shutDown();
});
