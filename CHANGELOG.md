# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## \[[0.1.0-alpha.5](https://github.com/holochain/peerkit/compare/v0.1.0-alpha.4...v0.1.0-alpha.5)\] - 2026-05-20

### Bug Fixes

- Suppress setup-node token injection to allow OIDC npm publish by @synchwire in [#45](https://github.com/holochain/peerkit/pull/45)

## \[[0.1.0-alpha.4](https://github.com/holochain/peerkit/compare/v0.1.0-alpha.3...v0.1.0-alpha.4)\] - 2026-05-20

### Bug Fixes

- Follow npm trusted publishers docs — registry-url, no NODE_AUTH_TOKEN, no cache by @synchwire in [#42](https://github.com/holochain/peerkit/pull/42)

### Miscellaneous Tasks

- Release v0.1.0-alpha.4 by @ThetaSinner in [#43](https://github.com/holochain/peerkit/pull/43)

## \[[0.1.0-alpha.3](https://github.com/holochain/peerkit/compare/v0.1.0-alpha.2...v0.1.0-alpha.3)\] - 2026-05-20

### Bug Fixes

- Remove registry-url from setup-node to allow OIDC auth for npm publish by @synchwire in [#40](https://github.com/holochain/peerkit/pull/40)

### Miscellaneous Tasks

- Release v0.1.0-alpha.3 by @ThetaSinner in [#41](https://github.com/holochain/peerkit/pull/41)

## \[[0.1.0-alpha.2](https://github.com/holochain/peerkit/commits/v0.1.0-alpha.2)\] - 2026-05-20

### Features

- Add PeerDisconnected callback by @jost-s
- Expose remaining node methods with agent ID inteface by @jost-s
- Bubble up transport callbacks for app consumption by @jost-s
- Log errors from callbacks by @jost-s
- Catch agent info deserialization errors by @jost-s
- Exchange agents when node connects to node by @jost-s
- Add node and relay classes to peerkit core package by @jost-s
- Add serialization for agent infos by @jost-s
- Add agent module with key pair fns to peerkit package by @jost-s
- _(metrics)_ Add @peerkit/metrics package and instrument transport bytes by @veeso in [#24](https://github.com/holochain/peerkit/pull/24)
  - Introduces @peerkit/metrics, a workspace package that wraps OpenTelemetry's JS SDK behind a small init/record surface (initMetrics, shutdownMetrics, getMeter) and exports metrics over OTLP/HTTP. SDK diag is bridged to the peerkit.metrics logtape logger; verbosity is configurable via MetricsConfig.diagLogLevel.
  - The libp2p transport records peerkit.transport.bytes (Counter, unit "By") on outbound send and inbound message-protocol receive paths, labelled by direction ("sent"|"received") and peer NodeId. Counter and its attribute schema are owned by packages/transport-libp2p/src/metrics.ts and exposed to the class as a typed TransportMetrics interface.
  - CLAUDE.md documents the lifecycle constraint (initMetrics before constructing instrumented components — OTel JS metrics API 1.9 has no proxy meter provider) and the per-package metrics module pattern.
- Add agent store package by @jost-s
- Split transport-libp2p into platform-agnostic core and per-platform packages (#15) by @veeso in [#21](https://github.com/holochain/peerkit/pull/21)
  - Move libp2p instance creation out of `@peerkit/transport-libp2p` so the core only owns protocol logic (access, agents, messages). Add `@peerkit/transport-libp2p-node` with TCP + circuit-relay-v2 factories and a stub `@peerkit/transport-libp2p-react-native`. Introduce `@peerkit/transport` facade with conditional `react-native`/`default` exports so consumers import a single package across platforms.
- Add method to create a custom stream on an existing connection by @jost-s
- Add disconnect call by @jost-s in [#17](https://github.com/holochain/peerkit/pull/17)
- Add peer connected callback that informs about new peer connections after access handshake by @jost-s
- Add message listener on remote when a host opens a stream by @jost-s
- Perform access handshake during direct connection upgrade by @jost-s
- Implement relayed connections and upgrade to direct connection by @jost-s
- Implement access handshake response by @jost-s
- Require agentId in transport constructor by @jost-s
- Implement agent exchange protocol by @jost-s
- Keep track of access decisions by @jost-s
- Add a relay factory method to the transport by @jost-s
- Add agent id to access handshake & use protobuf encoding by @jost-s
- Implement uni-directional message sending and receiving by @jost-s
- Close connection when invalid network access bytes provided by @jost-s
- Write listening address identification by @jost-s
- Initialize npm monorepo with build and test tooling by @jost-s in [#11](https://github.com/holochain/peerkit/pull/11)

### Bug Fixes

- Add files field to restrict published content to dist by @synchwire in [#38](https://github.com/holochain/peerkit/pull/38)
- Remove version from root package.json, read from workspace in publish by @synchwire in [#37](https://github.com/holochain/peerkit/pull/37)
- Work around npm bug where a transitive dev dependency is pruned from lock file by @jost-s
- Correlate relay-ready callback with the relay that triggered it by @jost-s
- Close agent stream only after receiving all messages by @jost-s

### Miscellaneous Tasks

- Release v0.1.0-alpha.2 by @ThetaSinner in [#39](https://github.com/holochain/peerkit/pull/39)
- Release v0.1.0-alpha.1 by @ThetaSinner in [#36](https://github.com/holochain/peerkit/pull/36)
- Mark @peerkit/transport-libp2p-react-native as private by @synchwire
- Delete unusued function sleep by @jost-s
- Rebuild package lock by @jost-s
- Tidy up logging in transport by @jost-s
- Add git commit pre hook to run format by @veeso
- Throw errors for unimplemented methods by @jost-s
- Add CLAUDE context file by @veeso

### Build System

- Add composite option to all tsconfigs by @jost-s
- Use vitest projects for a combined test summary by @jost-s

### CI

- Add release automation workflows by @synchwire in [#30](https://github.com/holochain/peerkit/pull/30)
- Build and deploy typedoc to GitHub Pages on push to main by @synchwire
  - Adds a Pages workflow that runs typedoc and deploys via actions/deploy-pages. Wires build:dist as a prebuild:docs hook so build:docs is self-sufficient and the workflow can call it directly.
- Cancel in-progress tests when triggered repeatedly on one branch by @jost-s in [#18](https://github.com/holochain/peerkit/pull/18)
- Add `npm run fmt:check` comamnd by @veeso
- Add build/test/lint/format ci workflow by @veeso

### Testing

- Add test for bidirectional agent info exchange by @jost-s
- Fix race condition in tests on linux where opening a stream without access handshake throws by @jost-s
- Send message from node to node over relay by @jost-s
- Relay rejects message protocol streams by @jost-s
- Relay requires access handshake by @jost-s

### Refactor

- Create loggers in corresponding modules instead of passing them around by @jost-s in [#25](https://github.com/holochain/peerkit/pull/25)
- Provide transport in callbacks by @jost-s
- Provide builders for relay + node by @jost-s
- Extract fn buildOwnAgentInfo by @jost-s
- Sign and verify agent infos by @jost-s
- Extract primitive types into separate module by @jost-s in [#19](https://github.com/holochain/peerkit/pull/19)
- Rename api package from interface to api by @jost-s
- Send proper ack message when access handshake completes by @jost-s
- Replace retryFnUntilTimeout by vi.wait calls by @jost-s
- Remove network access bytes parameter from connect method by @jost-s
- Simplify interface for transport factory functions by @jost-s
- Move transport types to new workspace package called interface by @jost-s
- Rename transport.stop to transport.shutDown by @jost-s
- Use node ID instead of agent ID to address peers in all transport API methods by @jost-s
- Add message framing to support large messages by @jost-s
- Rename Network Access Pass to Network Access Bytes by @jost-s

### Documentation

- Render SPECIFICATIONS.md in typedoc site and fix README links by @synchwire in [#28](https://github.com/holochain/peerkit/pull/28)
  - Adds SPECIFICATIONS.md to typedoc projectDocuments so it is rendered alongside the API reference. Replaces the broken docs/index.html link with the published Pages URL and corrects the case of the spec file link so it resolves on both GitHub and the rendered docs site.
- Update infrastructure and transport layer in specs by @jost-s
  - Include combined relay and bootstrap service in infrastructure.
- Rename P2 to Peerkit by @jost-s
- Add high-level specification by @jost-s in [#1](https://github.com/holochain/peerkit/pull/1)
- Init repo with readme by @jost-s

### First-time Contributors

- @ThetaSinner made their first contribution in [#39](https://github.com/holochain/peerkit/pull/39)
- @synchwire made their first contribution in [#38](https://github.com/holochain/peerkit/pull/38)
- @jost-s made their first contribution in [#25](https://github.com/holochain/peerkit/pull/25)
- @veeso made their first contribution in [#24](https://github.com/holochain/peerkit/pull/24)

<!-- generated by git-cliff -->
