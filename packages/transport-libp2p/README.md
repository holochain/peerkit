# @peerkit/transport-libp2p

libp2p-based transport for Peerkit. Implements `ITransport` on top of TCP + Noise + yamux + identify, with circuit relay support.

## Two construction modes

### Node

Participates in the network as a peer. Handles all three protocols: access, agent-info, and application messages.

```ts
const transport = await TransportLibp2p.createNode(
  agentsReceivedCallback,
  networkAccessHandler,
  networkAccessBytes: myAccessBytes,
  messageHandler,
  addrs: ["/ip4/0.0.0.0/tcp/0"],
  bootstrapRelays: ["/ip4/1.2.3.4/tcp/9000"],
);
```

### Relay

Serves as bootstrap service, enables peer connections and acts as a fallback when direct peer connections aren't successful. Does not handle application messages. Peers that attempt to open a message stream receive a protocol-unsupported error.

```ts
const relay = await TransportLibp2p.createRelay(
  agentsReceivedCallback,
  networkAccessHandler,
  addrs: ["/ip4/0.0.0.0/tcp/9000"],
);
```

## NodeId-only public API

All runtime methods are keyed by `NodeId` (an opaque string — the libp2p peer ID in multibase encoding). No libp2p types (`Connection`, `Multiaddr`) cross the public boundary. Mapping between peerkit `AgentId` and `NodeId` is the responsibility of the layer above the transport.

Each transport instance exposes its own peer ID via `transport.getNodeId`.

## Access gating

Every incoming connection must complete an access handshake on `/peerkit/access/v1` before opening any other stream. The `INetworkAccessHandler` decides whether to grant or deny access. Denied peers are remembered for the session and rejected immediately on reconnect without re-running the handler.

## `RelayAddress` format

For this transport, a `RelayAddress` is a multiaddr string (e.g. `/ip4/1.2.3.4/tcp/9000`). Other transport implementations parse it according to their own conventions.
