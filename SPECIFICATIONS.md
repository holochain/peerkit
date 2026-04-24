# Specification

## 1. What is Peerkit aiming to accomplish?

Peerkit is a peer-to-peer (P2P) data synchronization library. Its purpose is to enable developers to add decentralized data sharing to their applications without server infrastructure, where groups of users have full control over their data and their participation.

Peerkit is not a runtime or an all-or-nothing framework. It is a library that can be integrated into existing applications. An app may use Peerkit to synchronize only a subset of its data, while the rest of the app uses conventional storage, APIs, or other backends. Peerkit only manages the data that is specified through its storage hooks. This makes adoption incremental: developers can add P2P capabilities to one feature of an existing app without rewriting the rest.

### Problem statement

People lack agency over their digital tools. This manifests when:

- Infrastructure fails (an excavator breaks a fibre line, a device goes offline)
- A company discontinues a product or removes a feature
- A platform monetizes a group's relational and knowledge wealth against their interests
- A state actor collaborates with an application provider to compromise a group's safety

Existing P2P frameworks have not solved this problem at scale, or provide mainly low-level features to this end.

### Vision

Peerkit enables groups to credibly say "this is ours" about their digital tools. "Credibly" means a group realistically has agency: they can use, operate, and modify their tools with only a basic level of tech savvy.

For developers, choosing P2P should not be a painful choice. A developer new to Peerkit should be able to follow documentation and build a functioning app within hours.

### Definition of success

- A developer new to Peerkit can build a functioning app within hours (e.g. at a hackathon).
- Clear, detailed technical documentation uses consistent terminology, enabling developers to communicate effectively with maintainers.
- The framework has no fundamental limitations that would prevent maintainers from recommending it for serious production use cases.
- Solid API documentation and compliance tests make it possible for developers to replace modules with correctly implemented alternatives of their own.
- Apps written with the framework can run on all desktop devices running Linux, macOS or Windows, mobile devices running Android or iOS and in web browsers.
- Everything required to develop an application end-to-end is demonstrated as part of launching v1 and documented for developers.
- Apps built with the framework can be scaled to simultaneous usage by 100s of thousands of users, given a reasonable developer-provided distribution and storage algorithm.

## 2. Added value over existing frameworks

### Positioning relative to low-level P2P libraries

Low-level libraries like libp2p provide networking primitives: transport, encryption, peer discovery, and connection management. iroh goes further — beyond its core connectivity layer (QUIC-based transport, key-based addressing, NAT traversal with relay fallback), it also offers composable protocols including gossip (iroh-gossip for pub-sub overlay networks), content-addressed blob transfer (iroh-blobs), an eventually-consistent key-value store (iroh-docs), and a Willow protocol implementation (iroh-willow, in development). Despite this broader feature set, both remain building blocks rather than application frameworks. A developer using libp2p or iroh directly must still solve:

- How to structure, store, and query application data in a way that fits their domain
- How to validate data and maintain consistency across peers
- How to manage access control, membership, and privacy
- How to handle scalability as the network grows

Peerkit sits above these libraries and provides an opinionated-by-default but modular framework that addresses all of the above, while using libp2p (or iroh if we find that libp2p is problematic in production usage) for the networking substrate. Where iroh's built-in protocols (gossip, blobs, docs) overlap with Peerkit's layers, Peerkit may leverage them as implementations rather than rebuilding equivalent functionality.

### Positioning relative to p2panda

p2panda provides a similar layer of abstraction (structured data, gossip, access control) but is written in Rust, has limited documentation, unclear maturity, and its storage layer (SQLite) doesn't build to browser WASM. Peerkit differentiates by:

- Being a TypeScript framework, accessible to a much larger developer ecosystem
- Targeting browser, mobile, and desktop from day one
- Providing comprehensive documentation and tooling
- Focusing on scalability as a first-class concern

### Unique value proposition

1. **Accessibility**: TypeScript framework with great documentation. Beginner developers can build apps quickly and easily.
2. **Universal platform support**: Runs on Linux, macOS, Windows, Android, iOS, and browsers (at minimum in lite/leecher mode).
3. **Scalability as a design principle**: No "get all" methods on unbounded collections, no "notify everyone" networking concepts. The framework is designed from the ground up to scale to 10,000+ users.
4. **Security and privacy built in**: Open networks require explicitly disabling security controls, not the other way around. Agents control who can connect, read, write, and see their data.
5. **Modularity without fragmentation**: A layered architecture with dependency injection allows swapping implementations at any layer, while providing quality defaults that work out of the box.
6. **Data flexibility**: Not append-only at the protocol level. Supports destructive edits for scalability and privacy. Agnostic to data format or uses human-readable, easily exportable formats.
7. **Compliance-tested module boundaries**: Published specifications and compliance test suites allow third parties to build compatible implementations.

## 3. Primary goals

- **Fun to use** and easy to understand conceptually
- **Usable by beginner devs**, powerful for advanced devs
- **Safe defaults**: when using the highest-level APIs, it is hard to write an app that breaks basic usability. Lower-level APIs offer more power with fewer guardrails.
- **Runs everywhere**: browser (at least lite mode), desktop (Linux, macOS, Windows), and mobile (Android, iOS)
- **Local-first**: data sovereignty, supports easily portable data formats
- **Not append-only** at the protocol level
- **Flexible**: about discovery, connectivity, and data model, with quality defaults
- **Secure by default**: encryption of data, security built in with reasonably safe defaults
- **Well-documented**: extensive documentation for app devs and system developers
- **Supports an ecosystem**: extensible with libraries/plugins, comes with specifications for interoperability
- **Scalable**: effortless scalability to 10,000+ users
- **Group sovereignty**: groups can say "this is ours" -- they have the power to keep the lights on, modify their tools, and manage membership

## 4. Primary constraints

- **Platforms**: runs fully on Linux, macOS, Windows, Android, and iOS. Runs on Chromium at least in leecher mode over a relayed connection.
- **Language**: users MAY write apps in JavaScript/TypeScript. Framework itself is TypeScript.
- **Minimal out-of-band data**: ideally only the address and entrance secrets for the app space are required to use an app. Self-descriptive data.
- **Modularity**: must be agnostic to or allow swapping of data distribution strategy, data/state model, storage implementation, and transport medium.
- **Privacy and security**: assume adversaries are present. Privacy and security built in at the network layer.
- **Resource-conscious**: should run on old smartphones with metered data. No unreasonable burdens on devices.
- **Local-first and meshnet-friendly**: peer discovery and operation must work on local networks without internet.
- **Data format**: either agnostic to data format, or uses a format that is human-readable and easy to export.
- **Open networks must require disabling security controls** (secure by default).
- **Comprehensive tooling**: tooling to inspect data and state for system devs, app devs, and end users. Distributed test setup.
- **Existing technology**: use existing technology wherever sensible, not reinventing transport or peer discovery.
- **API expressiveness**: expressive enough to build features missing from core; simple enough to allow groups to vibe-code ad-hoc apps.

## 5. Architecture: components and layers

The architecture follows a layered design where each layer builds on the one below it, making increasingly opinionated choices while providing greater ease of use and safety. Layers are fully encapsulated and interface only through public functions and hooks.

Design principles:

- Each layer makes more opinionated, restrictive choices
- Each layer provides greater ease of use, safety, and fun
- When making a restrictive choice: can it be pushed up to a higher layer?
- Lower layers calcify sooner; higher layers may be more experimental
- We will get the architecture wrong. It must be straightforward to make dramatic changes by swapping out a single layer.

### Cross-cutting concerns

These capabilities span multiple layers and are not all reflected in this specification document yet:

#### Authentication and data security

- Network access management for group membership (see Layer 0: network access control)
- With network access security in place and a single set of data per app, additional data access security isn't required.
- Encryption of data at rest and in transit

#### Agent identity

An **agent** is a participant with a cryptographic identity: a public/private keypair. The agent's public key is its `AgentId` — a stable, verifiable identifier that does not depend on any central registry.

```typescript
// A participant's cryptographic public key, used as their stable identifier
type AgentId = Uint8Array;

// Verify that a signature was produced by the agent identified by agentId
function verify(
  agentId: AgentId,
  data: Uint8Array,
  signature: Uint8Array,
): boolean;
```

The framework generates the agent's keypair on first run and persists it in storage. On subsequent runs it reloads the same keypair. The app does not provide or manage key material. Signing happens internally — the private key is never exposed.

The local agent's public identity is accessible after initialization:

```typescript
const peerkit = await Peerkit.create({ storage: ..., transport: ... })
const myId = peerkid.agent.id  // the local agent's public key (AgentId)
```

`AgentInfo` is the public, shareable descriptor exchanged between peers and stored in the agent table. It contains everything needed to verify an agent's signatures and reach them on the network:

```typescript
// Shareable, serializable descriptor of an agent — their "business card"
interface AgentInfo {
  id: AgentId; // The agent's public key (their stable identity)
  addresses: PeerAddress[]; // Known addresses (LAN, WAN, relay, etc.)
}
```

Address selection among multiple addresses is handled internally by the transport (`ITransport.connect`) — callers do not need to pick.

Agent identity is distinct from peer identity (`PeerId`), which is a network-level address. Both may be derived from the same keypair, but they serve different purposes: `PeerId` identifies a network endpoint, `AgentId` identifies an author across all their devices and sessions.

**Signing**: State change blobs (Layer 4) are signed by their author using the agent's private key. Peers verify the signature when integrating a blob. This ensures that only the holder of the private key can produce state changes attributed to that agent — no central authority is needed.

#### Data validation

- Newly received data should be considered "pending" and must be "accepted"
- The exact validation mechanisms are not imposed by the framework
- Apps implement custom validation functions
- Validation cannot access the network; required data must be available locally

#### Storage

Storage is opinionated and platform-dependent. Pluggable storage lets developers choose a backend that fits their app's constraints and deployment environment.

Therefore storage is injected as a dependency. The framework defines a storage interface; applications provide an implementation. Peerkit ships SurrealDB as the default implementation, which runs in both Node.js and browser environments.

Storage touches every layer, because each layer persists different kinds of data:

| Layer               | What is stored                                                           |
| ------------------- | ------------------------------------------------------------------------ |
| Cross-cutting       | Agent table (`AgentId → AgentInfo`)                                      |
| 0 (transport)       | Cached peer addresses                                                    |
| 1 (networking)      | Blobs and their content hashes                                           |
| 2 (structured data) | Schema blobs                                                             |
| 3 (indexed data)    | Metadata entries, index structures                                       |
| 4 (state changes)   | State change blobs, causal DAG edges, tombstone records, epoch snapshots |

##### Storage interface

The injected storage implementation must satisfy:

```typescript
interface Storage {
  // Agent table (cross-cutting)
  putAgentInfo(info: AgentInfo): Promise<void>;
  getAgentInfo(id: AgentId): Promise<AgentInfo | null>;
  deleteAgentInfo(id: AgentId): Promise<void>;

  // Peer address cache (Layer 0)
  putPeerAddress(peerAddress: PeerAddress): Promise<void>;
  getPeerAddresses(): Promise<PeerAddress[]>;
  deletePeerAddress(peerId: PeerId): Promise<void>;

  // Blob storage (Layers 1-4)
  putBlob(hash: Hash, blob: Uint8Array): Promise<void>;
  getBlob(hash: Hash): Promise<Uint8Array | null>;
  hasBlob(hash: Hash): Promise<boolean>;
  deleteBlob(hash: Hash): Promise<void>;
}
```

##### Injection

Storage is passed to the framework at initialization:

```
const peerkit = Peerkit.create({ storage: new SurrealDBStorage(), ... })
```

The same storage instance is shared across all layers. Layers do not instantiate storage themselves.

### Layer 0: transport

Responsible for establishing connections between peers and discovering other peers on the network.

**Implementation**: js-libp2p (with iroh as fallback if connectivity issues arise, particularly on mobile).

#### Zero infrastructure

If the transport permits it, Peerkit does not require dedicated infrastructure. The roles traditionally served by infrastructure (bootstrapping, signaling, relaying) are served by peers themselves. Every "server" in a Peerkit network is a full participant running the same application. This entails that hosted relay nodes must be part of the network, which increases the burden on the app provider. This architecture is possible with libp2p, but not with iroh as the transport.

There are three infrastructure roles that must be covered:

##### 1. Bootstrapping: finding the first peer

A new node needs the address of at least one existing peer to join the network. Once connected to one peer, the node discovers others through the peer table. The network self-discovers from there.

**Local network**: mDNS (multicast DNS) discovers peers on the same LAN with zero configuration. No addresses needed.

**Internet**: The app ships with or accepts a list of known peer addresses (bootstrap peers). These are ordinary nodes running the application. Practically, this means the app creator (or any committed user) runs a peer on a reachable address, and that address is shared with new users.

Bootstrap peer addresses can be:

- Entered manually by the user (paste an address, scan a QR code). Manual address entry is a core feature of the framework.
- Hardcoded in the app by the app creator

Possible future enhancements:

- Published to a well-known location (e.g. a DNS TXT record, a web page)
- Discovered via BitTorrent Mainline DHT (a public, infrastructure-free DHT that anyone can publish to, keyed by app identifier)

Peers cache known-good peer addresses locally for faster reconnection on restart. Bootstrapping from scratch (mDNS or hardcoded addresses) is only needed when the cache is empty or all cached peers are unreachable.

##### 2. NAT traversal and connection establishment

Most consumer devices sit behind a router that blocks incoming connections (NAT). libp2p uses a layered strategy to establish direct connections, tried in order:

1. **Direct connection**: If either peer has a publicly reachable address, the other connects directly.
2. **Router port forwarding**: The peer asks its router to open a port automatically, making it reachable from the internet. Works on many home routers.
3. **Reachability check**: The peer asks its connected peers to try dialing it, to find out whether it is publicly reachable or blocked by its router.
4. **Hole-punching**: If both peers are behind routers, they connect through a relay peer first, then attempt to establish a direct connection by having both sides dial simultaneously. If successful, the relay is no longer needed.
5. **Relay as fallback**: If hole-punching fails (estimated 5–15% of attempts, typically when both peers are behind strict routers), the relayed connection stays active.

No step requires dedicated infrastructure — router negotiation is local, and reachability checks and relaying use connected peers.

**Resource management for relaying**: A peer acting as relay carries the bandwidth cost of forwarding traffic. The framework must:

- Allow peers to opt in/out of relaying for others
- Set bandwidth and connection limits for relay traffic
- Prefer relaying through peers that have indicated willingness and capacity (e.g. desktop peers on broadband)
- Automatically stop relaying when a direct connection is later established

##### Browser nodes

There is no separate "browser mode." A browser is just a peer that uses different transports. The only architectural consequence is that browsers cannot open listening sockets, so they cannot be bootstrap nodes (no stable address to advertise). Browsers connect via WebRTC (post-MVP), establishing bidirectional connections including browser-to-browser. Once connected they are full peers on those connections and can relay, signal, and participate like any other node.

A network of only browser nodes cannot bootstrap. At least one desktop/mobile peer must be reachable for initial connection.

##### Transport selection by platform

| Platform                        | Transport         | Capabilities                                                                                                       |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Desktop (Linux, macOS, Windows) | TCP               | Full node: bootstrap, signaling, relay, direct connections                                                         |
| Mobile (Android, iOS)           | TCP               | Full node with caveats: background restrictions may limit availability as bootstrap/relay                          |
| Browser (Chromium)              | WebRTC (post-MVP) | Lite node: cannot be bootstrapped to, always initiates connections. Can relay between peers it has connections to. |

All transports use encrypted channels (Noise protocol for TCP, DTLS for WebRTC). QUIC is a future upgrade for desktop/mobile once js-libp2p ships support.

##### Network access control

Networks are **closed by default**. Every incoming connection must present network access bytes before any application data is exchanged. This is enforced at the transport level as part of the connection handshake:

- After a connection is established and encrypted, the connecting peer must present network access bytes
- The bytes are passed to the `onConnect` hook
- If the hook rejects, the connection is dropped immediately and the peer is blocked.
- No application data is sent or received before the bytes are accepted

To make a network open, the app explicitly sets the network access check to accept all connections. This is an opt-out, not the default.

##### Module boundary

**Types**:

```typescript
// Identifier for an agent
type AgentId = Uint8ByteArray;

interface RelayConfig {
  canRelay: boolean;
}

// Byte sequence to prove access to a network has been granted
type NetworkAccessBytes = Uint8Array;
```

**API**:
Transport is injected as a dependency. The rest of the system interacts with it through a defined interface:

```typescript
interface ITransport {
  // Establish a connection to a peer, presenting network access bytes
  connect(peerId: PeerId, pass: NetworkAccessBytes): Promise<Connection>;

  // Send data to a peer. Each message uses a short-lived stream, avoiding
  // the need for manual message framing. Stream creation is cheap enough
  // for expected message rates (sub-minute to tens per second).
  send(peerId: PeerId, data: Uint8Array): Promise<void>;

  // Configure this peer's willingness and resource limits for relaying traffic
  setRelayConfig(config: RelayConfig): void;

  // Hook called on each incoming connection with the peer's network access bytes.
  // Return true to accept, false to reject and drop the connection.
  onConnect(
    handler: (agentId: AgentId, bytes: NetworkAccessBytes) => boolean,
  ): void;
}
```

This interface enables replacement of js-libp2p with iroh or another transport without affecting higher layers.

### Layer 1: P2P networking

Routing opaque blobs to the right peers so that layers above can create eventually consistent shared state.

**Capabilities**:

- Peer responsibility coverage tracking and automatic management for adequate coverage
- Generic data and agent identifiers (future-proofing)
- Does not store blobs itself, but tracks what blobs have been received and integrated
- Implements evaluation of incoming network access bytes to allow or deny connections
- Resource budgets (future): each peer advertises its willingness to relay data

#### Data distribution interface

Layer 1 provides blob distribution across peers. It does not prescribe how blobs are routed — the distribution strategy is pluggable via dependency injection. Peerkit ships a full replication default in the MVP.

**Core concept**: Every blob has a content hash (its identity). Layer 1 ensures blobs reach the peers that should have them, according to the active distribution strategy. Layer 1 does not define a key space or routing topology — those are concerns of the distribution strategy.

**Distribution strategy interface** (injected by developer):

- `willStore(peerId: PeerId, blob: Uint8Array) -> bool` — should this peer store the given blob?

The strategy inspects the blob to determine routing. The caller does not specify a target — routing is entirely the strategy's responsibility.
**Example strategies**:

1. **Full replication** (MVP, built-in): every peer stores everything. `willStore()` always returns true. No coordination needed. Works for small networks (tens or hundreds of peers).
2. **DHT / key-based**: defines a 256-bit hash ring. `willStore()` maps the blob's content hash to a position on the ring and returns a value according to the proximity of the peer. Peers claim responsibility for portions of the key space. The classic Kademlia/Chord approach, suited for large open networks.
3. **Direct replication**: `willStore()` returns true for a fixed set of peers configured by the app. For backup apps, personal sync, or any scenario where the author decides exactly who gets the data.
4. **Topic-based**: the strategy maps blobs to topics (e.g. by schema type). Peers subscribe to topics and receive blobs published to them. Pub/sub pattern.

#### Gossip

Gossip is the mechanism by which blobs propagate across the network. It operates in two phases:

**Push (new blob propagation)**: When a peer publishes or integrates a new blob, it immediately forwards it to connected peers for whom `willStore()` returns true.

**Pull**: When two peers connect, they reconcile their stored blobs to repair any gaps. Each peer advertises a compact summary of the blobs it holds; the other peer responds with any blobs the first is missing. This handles blob exchange with peers that didn't receive pushed blobs for whatever reason.

A summary must be compact enough to exchange on every connection. The exact representation depends on the gossip strategy.

**Gossip and the distribution strategy**: gossip push uses `willStore()` to decide which peers to forward a blob to. Anti-entropy pull is scoped to the blobs a peer is responsible for under the active strategy. The gossip mechanism itself is strategy-agnostic.

**Open question**: The MVP gossip strategy is unresolved. Simple push to all connected peers is the simplest implementation.

#### Connection management

Each peer maintains connections to a bounded number of peers. The connection management strategy is pluggable via dependency injection, like the distribution strategy. Peerkit ships a default that connects to all peers.

Example strategies:

- **Persistent connections** (default): maintain long-lived connections to all peers.
- **Ephemeral connections**: open connections on demand (connect-fire-close), maintaining only a small number of persistent connections. The persistent connections can rotate through neighbors to maintain coverage. Suited for large networks where holding many connections is expensive.

#### Module boundary

**Types**:

```typescript
// Hash value of a data blob
type Hash = Uint8Array;
// Blobs of data
type Blob = Uint8Array;
```

**API**:

```typescript
interface INetworking {
  // Publish a blob. The distribution strategy determines which peers receive it.
  publish(blob: Blob): Promise<void>;

  // Retrieve a blob by its content hash.
  // Only supported by strategies that can locate peers by hash (e.g. full replication, DHT).
  // Push-only strategies (e.g. pub-sub) cannot support this — returns null if unavailable.
  get(hash: Hash): Promise<Blob | null>;

  // Block or unblock a peer connection
  block(peer: PeerId): void;
  unblock(peer: PeerId): void;

  // Send an opaque message to a peer (fire-and-forget)
  send(peer: PeerId, data: Uint8Array): Promise<void>;
}
```

**Note on `get(hash)`**: Not all distribution strategies support targeted retrieval by hash. Full replication and DHT-based strategies can locate responsible peers from a hash alone. Push-only strategies (e.g. topic-based pub-sub) have no reverse lookup — blobs are received when pushed, not fetched on demand. Callers should not rely on `get()` being available unless the active strategy supports it.

**Hooks** (called by Layer 1 into the layer above or into injected storage):

```typescript
interface INetworkingHooks {
  // Called when a new blob arrives from the network.
  // The callee is responsible for persisting accepted blobs via injected storage.
  onIntegrate(peerId: PeerId, blob: Blob): "accepted" | "rejected";

  // Retrieve a blob by hash from local storage.
  // Called when a peer requests a blob this node is responsible for.
  getBlob(hash: Hash): Promise<Uint8Array | null>;

  // Handle an incoming message from a peer
  onMessage(peer: PeerId, data: Uint8Array): void;
}
```

### Layer 2: structured data (blob + schema)

Adds semantic meaning to blobs through schemas.

**Capabilities**:

- The first bytes of a blob reference a schema blob containing the blob's data structure definition (JSON Schema or similar)
- Referenced schema blobs must be fetched to decode the data blob.
- Blobs must decode according to their schema
- Hook called when new data arrives matching a given schema

**API**:

```typescript
interface IStructuredData {
  // Publish a schema definition so peers can decode blobs that reference it
  publishSchema(schema: Schema): Promise<Hash>;

  // Publish a blob whose structure conforms to the given schema
  publishBlob(schemaId: Hash, data: Uint8Array): Promise<Hash>;

  // New data coming in, matching a given schema
  onNewData(schemaId: Hash, data: Uint8Array);
}
```

### Layer 3: indexed data (blob + schema + metadata)

Adds queryability through deterministic metadata and distributed indexes. Layer 2 provides the "detail view" (fetch a specific blob by hash). Layer 3 provides the "list view" (browse and search blobs by their properties).

#### Index mechanism: metadata as distributed data

When a blob is created, metadata is deterministically extracted according to its schema's `METADATA_FIELDS` definition and published as separate blobs via `publish()`. `METADATA_FIELDS` is a list of field names declared in the schema that should be indexed — each named field gets its own metadata blob per value. The distribution strategy routes metadata blobs like any other blob. This means index lookups use the same `get()` mechanism as any other data retrieval — no special query protocol is needed.

> **Open question**: the schema format is not yet specified. Either the schema definition format is hardcoded (e.g. a JSON Schema dialect with a `metadata_fields` key), or an additional hook is needed (e.g. `get_metadata_fields(schema) => string[]`) to let schemas express this dynamically. This has implications for Layer 2 as well.

Metadata must be a separate blob because it needs to be routed independently of its source blob. In a DHT, `hash("tag:meeting-notes")` routes to different peers than the content blob itself — that's what makes index lookups efficient without scanning. If metadata were embedded in the source blob, it would be co-located with the content and distributed lookup would be impossible.

**Example**: A document blob has schema fields `author`, `tags`, and `createdAt`. The schema declares `tags` and `author` as metadata fields. When the blob is published:

1. The blob itself is published via `publish(blob)`
2. A metadata entry `{ blobId, tag: "meeting-notes" }` is published via `publish(metadataBlob)`
3. A metadata entry `{ blobId, author: "agentXyz" }` is published via `publish(metadataBlob)`

To find all documents tagged "meeting-notes", a peer queries for metadata entries matching that tag and receives a list of blob IDs.

#### Properties

- **Deterministic**: Metadata is derived from the blob itself using rules defined in the schema. Any peer can independently verify that a metadata entry is correct by re-deriving it from the source blob. Forged index entries can be detected and rejected.
- **Distributed**: Metadata entries are blobs distributed via Layer 1 like any other — they are replicated and gossiped using the active distribution strategy. No peer needs a global index.
- **Composable**: Queries on multiple fields can be resolved by intersecting results from multiple lookups.
- **Prunable**: When a blob is pruned, its associated metadata entries can be pruned too.

#### API

```typescript
interface IIndexedData {
  // Get all metadata entries for a blob
  getMetadata(blobId: Hash): Promise<Metadata[]>;

  // Find blobs matching field criteria (translates to Layer 1 lookups)
  query(metadataQuery: MetadataQuery): Promise<Hash[]>;

  // Verify that a metadata entry was correctly derived from the given blob
  verifyMetadata(blob: Blob, metadata: Metadata): boolean;
}
```

### Layer 4: State changes (blob + schema + indexing)

Layers 1-3 deal with immutable blobs: you publish a blob, it gets distributed, it can be queried. But real applications need mutable state — a document that gets edited, a counter that increments, a list with items added and removed. In a P2P system without a central authority, multiple peers can mutate the same logical entity concurrently. Layer 4 defines how those concurrent mutations are expressed, linked, and resolved.

> **Open question**: A CRDT definition needs to be declared somewhere — grouping a set of state change schemas that belong to the same CRDT, declaring the merge function, and optionally defining CRDT-level operations (e.g. deduplicating redundant state changes). The format and location of this definition is not yet specified.

#### State changes as blobs

State changes are blobs. They use Layer 2 schemas and Layer 3 indexing. No fundamentally new storage or networking mechanism is introduced — Layer 4 adds conventions and semantics on top of what exists below.

Each state change blob contains:

- **Schema ID**: identifies the type of state change (e.g. CreateEntry, UpdateEntry, DeleteEntry)
- **Target**: the blob ID of the entity being acted on (absent for creates)
- **Causal links**: blob IDs of the state changes this one depends on (the state changes the author had seen when making this change)
- **Payload**: the new data, if needed
- **Author**: the `AgentId` (public key) of the agent who made the change
- **Signature**: the author's signature over the blob content, verifiable by any peer using the author's public key

Causal links form a DAG (directed acyclic graph) of state changes per entity. This DAG captures the order in which changes were made and allows detection of concurrent changes (branches in the DAG).

#### Built-in CRDT: CRUD object

Peerkit ships one built-in CRDT: a CRUD object. The following are the state changes it allows:

- **CreateEntry**: establishes a new logical entity. The blob ID of this state change becomes the entity's identity.
- **UpdateEntry**: targets a CreateEntry (by blob ID) and carries causal links to the previous state changes the author had seen. Payload contains the new state.
- **DeleteEntry**: targets a CreateEntry. Signals that the entity should be considered removed. Triggers pruning of the original data and prior updates (see destructive edits below).

Multiple peers may issue UpdateEntry or DeleteEntry for the same entity concurrently, creating branches in the causal DAG. Resolution is handled by merge functions.

#### Conflict resolution

When a peer receives state changes that form concurrent branches (no causal link between them), a merge is required. The CRDT schema defines how merges work.

**Default merge strategy (last-writer-wins)**: Compare timestamps; if equal, compare blob hashes deterministically. Simple, sufficient for many apps, and requires no custom logic.

**Custom merge functions**: For richer semantics, the schema can specify a merge function. This is an open design question — options include:

- A named, well-known merge strategy (e.g. "lww", "set-union") that the framework ships implementations for
- Application-provided merge logic registered at startup.

The framework ships built-in merge strategies for common patterns. Custom strategies are possible but not required for typical CRUD apps.

> **Open question**:

The merge logic could also be published as part of the CRDT specification. The CRDT spec would include the actual code and the intrepreter/vm/assembler it must be run with, i.e.

```json
{
  "merge": {
    "interpreter": "node_22.1",
    "exec": "function(a: AdditionStateChange, b: AdditionStateChange) -> AdditionState { return State { value: a.value + b.value }; }"
  }
}
```

One of the benefits is it makes everything needed to use the CRDT fully in-band as long as the node has the interpreter available. There might need to be some tooling to make it easy for devs to write the code in a .js file and then have it imported into their CRDT type as a string.

#### Destructive edits and pruning

Pruning in a P2P system without a central coordinator is inherently difficult, but possibly solvable with trade-offs.

##### Core problem

Gossip treats a missing blob as something to repair. A pruned blob also looks missing. Without a mechanism to distinguish "not yet received" from "intentionally removed," gossip will undo prunes by re-fetching the data. Permanent tombstones solve this but grow monotonically, partially defeating the purpose of deletion.

##### Possible solution: epoch-based pruning with snapshot sync

Peerkit uses **epochs** — coordinated time windows that bound tombstone retention and define the sync protocol:

1. Peers store tombstone records (compact: hash + deletion timestamp) for the duration of one epoch.
2. After an epoch boundary, tombstones from previous epochs are dropped.
3. Peers that were online during the epoch use **incremental gossip** as normal — tombstones and prune state prevent data resurrection.
4. Peers that were offline for longer than one epoch **cannot use incremental gossip**. They must treat themselves as new peers joining and perform a **full state sync** against a snapshot.

**Snapshot-based anti-entropy**: Peers periodically produce compact state snapshots. A returning or joining peer syncs against the snapshot. If a blob isn't in the snapshot, it doesn't exist — no tombstone needed. The snapshot is the authoritative representation of current state.

This bounds tombstone storage to one epoch's worth of deletions (proportional to deletion _rate_, not deletion _history_) and shifts the cost of long absence from the network to the returning peer (a one-time full resync) rather than burdening all peers with permanent tombstones.

##### Delete flow

When an entity is deleted:

1. A DeleteEntry state change is published
2. Peers that integrate the delete may prune the original CreateEntry blob, all UpdateEntry blobs, and the associated Layer 3 metadata entries
3. The DeleteEntry is retained as a compact tombstone record for the current epoch
4. After the epoch boundary, the tombstone is dropped — snapshot-based sync handles any peers that missed it

Data is fully removed from the network over time — not just tombstoned. This is critical for storage scalability.

##### Update chain pruning

Update chain pruning is an open problem. Two structural issues make it difficult:

1. **Chain integrity**: If updates form a causal chain `A → B → C`, pruning an intermediate element (e.g. `B`) orphans all successors (`C`). The only structurally safe prune point is the tail — everything before the latest known update. But this is only well-defined once the merge has converged across all peers.

2. **Consistency under degradation**: Falling back to a different merge strategy when causal links are missing would cause peers with different data availability to reach different merge decisions — a consistency violation.

**Open question**: Should updates be a **set** rather than a **chain**? Set-based updates (no causal links between updates of the same entity) would make pruning straightforward: once the merge result is stable across peers, all inputs can be discarded. This trades causal ordering between updates for simpler pruning semantics.

##### Open questions

- How are epoch boundaries coordinated in a decentralized network? Options include wall-clock intervals (simple but clock-skew-sensitive), consensus-based epoch numbers, or leader-based epoch advancement.
- What is a reasonable default epoch duration? Too short increases resync frequency for intermittently-connected peers; too long delays tombstone reclamation.
- How large are state snapshots in practice, and how expensive is full resync for a peer rejoining after a long absence?
- Should updates be modelled as a set (no causal links between updates of the same entity) rather than a chain? This would simplify pruning but lose causal ordering between updates.

#### Collaborative editing (Yjs / CRDT libraries)

For real-time collaborative editing (e.g. the knowledge base showcase app), the framework supports CRDT library integration. Instead of coarse-grained UpdateEntry state changes, an app can use fine-grained CRDT operations (e.g. Yjs operations for text editing).

These operations are still blobs, published and synced through Layers 1-3. The CRDT library handles merge semantics — the framework just transports the operations. This keeps Peerkit agnostic to the specific CRDT implementation while enabling rich collaborative features.

#### API

```typescript
interface IStateChanges {
  // Create a new entity; returns its ID (the hash of the CreateEntry blob)
  createEntry(schemaId: Hash, data: unknown): Promise<Hash>;

  // Update an entity; automatically includes causal links to known prior state changes
  updateEntry(entityId: Hash, data: unknown): Promise<void>;

  // Delete an entity and trigger pruning of its associated blobs
  deleteEntry(entityId: Hash): Promise<void>;

  // Get the current resolved state of an entity, applying merge if concurrent branches exist
  getEntry(entityId: Hash): Promise<unknown | null>;

  // Query entities via Layer 3 metadata
  queryEntries(metadataQuery: MetadataQuery): Promise<Hash[]>;

  // Get the full causal history (DAG of state changes) for an entity
  getHistory(entityId: Hash): Promise<StateChange[]>;
}
```

### Layer 5+: higher-level features (future)

Not yet specified. Potential areas:

- Data validation framework (received data is "pending" until "accepted")
- Deletable / deduplicatable / warrantable CRDT state changes
- Features implementable directly as CRDT types vs. requiring lower-level hooks
- Rethinking validation dependency and induction

#### Upgradability

Upgrading apps in a P2P network is fundamentally harder than in client-server: there is no central point to deploy updates to. Peers update independently, at different times, and the network will have peers running different versions simultaneously — potentially for a long time. Peerkit must make this easy and smooth.

**Schema versioning**: Schemas (Layer 2) carry a version number. When a schema evolves (new fields, changed structure), the new version is published as a new schema blob. Old schema blobs remain in the network. Peers on the new version must handle data created under old schemas.

**Backward-compatible by default**: Schema changes should be additive where possible — new fields with defaults, new optional metadata. Blobs created under an older schema version remain valid and readable. A peer running a newer app version can read old data without migration. A peer running an older app version that receives data with an unknown schema version can choose to store it opaquely (for gossiping to others) without processing it.

**Validation across versions**: Validation rules may change between versions. Each blob carries its schema version, and validation is applied according to the rules of that version. A v2 peer validates v1 blobs using v1 rules and v2 blobs using v2 rules. This avoids the problem of old peers rejecting new data or new peers rejecting old data.

**Protocol versioning** (Layer 0-1): The transport and networking protocols are versioned. Peers exchange version information during the connection handshake. The framework defines compatibility rules: which protocol versions can interoperate, and how to negotiate down to a common version.

**No forced upgrades**: In a P2P system where groups own their tools, upgrades cannot be forced. Peers must coexist across versions gracefully. The framework never requires all peers to be on the same version for the network to function. Degraded functionality (e.g. a new feature not available to old peers) is acceptable; broken connectivity is not.

#### Scalability

Target: millions of nodes over time. Scalability is addressed at three levels:

**Connections**: Each peer maintains a bounded number of connections (O(log N) or a configured maximum). No operation requires contacting all peers.

**Data distribution**: Peerkit defines a pluggable distribution strategy interface but does not prescribe a routing topology. The distribution strategy is injected by the developer. Peerkit ships full replication as the built-in default. See Layer 1 for the interface and example strategies (DHT, direct replication, topic-based).

**Destructive edits**: This is critical for long-term storage scalability. Peerkit is not append-only at the protocol level. Data that has been superseded, deleted, or pruned can be fully removed over time. Without destructive edits, storage grows monotonically regardless of sharding, and networks eventually become unusable on constrained devices. Higher layers define the semantics of when pruning is appropriate. Tombstone storage is bounded through epoch-based compaction combined with snapshot-based anti-entropy for returning peers. See Layer 4's "Destructive edits and pruning" section for the full design.

**Resource budgets** (future): Each peer advertises its capacity (storage, bandwidth, connection count). The framework respects these limits and distributes load accordingly. Constrained devices (mobile, old hardware) take on less responsibility without being excluded from the network.

**API discipline**: No "get all" methods on potentially large collections. No networking concepts requiring notification of or connection to all peers. Every query and operation must be bounded.

## 6. Technology decisions

- **Language**: TypeScript (large ecosystem, accessible to app developers, lower resource cost than Rust development)
- **Networking**: js-libp2p as primary, iroh as fallback
  - libp2p: more mature, direct browser connections, large community, proven at scale (Ethereum, IPFS)
  - iroh: technically excellent, better hole-punching via relay fallback, but lacks JS wrapper and browser direct connections
- **Storage**: SurrealDB as default (common database for browser and desktop, JS SDK available), but pluggable
- **Architecture style**: core API covers peer discovery, transport, and agents; storage logic (data model, distribution strategy) is not built into the core API but selected per application

## 7. Technical principles

- A suite of compliance tests constrains the behavior of implementations
- The project is modular and relies on dependency injection
- Module APIs are defined by the framework for common problems: peer discovery, authentication, peer connections
- Data schemas for core modules are versioned
- After first release, tests constrain updates to be compatible with previous versions
- The system is not constrained by a specific data store or network protocol
- The observable API is defined by published specifications

## 8. MVP definition

Not every app needs all 4 layers. The layers are additive — each builds on the one below but is independently useful. The MVP ships Layer 0 + 1 to get a working P2P library as quickly as possible.

### MVP scope: Layer 0 + 1

**What's included:**

- js-libp2p transport with manual bootstrap address entry
- Encrypted connections (Noise protocol)
- Network access bytes handshake (closed networks by default)
- Publish and get opaque blobs (full replication — every peer stores everything)
- Block/unblock peers
- Gossip to propagate new blobs to connected peers
- Peer messaging (signals)

**What's deliberately excluded from MVP:**

- Custom data distribution — **full replication** is the built-in default (every peer stores everything). The distribution interface is exposed for developers to provide their own strategy.
- Layer 2 (schemas) — app structures its own blobs
- Layer 3 (indexing) — app builds its own local indexes
- Layer 4 (state changes, conflict resolution) — app handles its own state change semantics
- Pruning / destructive edits — requires epoch-based compaction and snapshot sync (see Layer 4). MVP storage is append-only; full replication on small networks makes this acceptable.
- Browser support — desktop only initially
- Mobile support — desktop only initially

### What can be built with the MVP

The MVP gives developers: encrypted P2P connections, closed networks, and a shared blob store with full replication via gossip. That's enough for:

- Simple messaging / chat
- Shared document storage (without conflict resolution — last-write-wins at the app level)
- Configuration or state sync between devices
- Any app where the data set is small enough for every peer to hold

The app developer handles data structure, indexing, and conflict resolution in their own code. The developer experience improves as Layers 2-4 are added, but the MVP is functional.

## 9. Open questions

- How should merge function logic be embedded in schemas? Options include interpreted language source code or compiled WASM, but both constrain app languages and runtime platforms. Could specify both a merge function and the name of its runtime engine.
- What gossip strategy should the MVP use? K2's gossip approach (by arc and timestamp) may be more efficient than simple flooding, but porting K2's implementation to TypeScript is a significant effort.
- How to handle multi-data/multi-app composition (multiple dataspaces with bridge calling/signals)?
- How to handle atomic operations across multiple blobs in a distributed system? (A higher-order CRDT could be added that enables publishing multiple state changes of lower-order CRDTs as a single state change.)
