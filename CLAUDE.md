# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Peerkit is a TypeScript peer-to-peer data synchronization framework. It sits above low-level P2P libraries (libp2p/iroh) and provides an opinionated, modular stack for structured data, access control, and scalability. Target platforms: Linux, macOS, Windows, Android, iOS, browsers.

## Specifications are authoritative

`SPECIFICATIONS.md` is the source of truth for all architecture and task decisions. Follow it strictly.

- Read the relevant section before writing or modifying code in a layer. Layer 0 (transport), Layer 1 (networking), Layer 2 (schemas), Layer 3 (indexing), Layer 4 (state changes/CRDT) each have fixed module boundaries, type signatures, and hook contracts in the spec — match them exactly.
- Do not invent APIs, types, or layer responsibilities the spec does not describe. Do not cross layer boundaries (e.g. transport must not know about schemas, Layer 1 must not prescribe routing topology).
- Preserve spec-mandated defaults and invariants: closed networks by default, `NetworkAccessBytes` gating before any app data, blob content-addressing, `AgentId = public key`, signatures on state changes, pluggable distribution/connection strategies, no "get all" on unbounded collections.
- Stay within MVP scope (Layer 0 + 1, desktop, full replication) unless the task explicitly extends it.
- If requirements and spec conflict, stop and flag the conflict — do not silently deviate. If the spec has an open question relevant to the task, surface it rather than guess.
- When spec terminology exists (`AgentId`, `NetworkAccessBytes`, `Blob`, `Hash`, `willStore`, epoch, tombstone, etc.), use it verbatim.

## Monorepo layout

npm workspaces. Root is private and orchestrates builds; only published packages live under `packages/`.

- `packages/api` — `@peerkit/api`, shared type definitions (`ITransport`, `IKeyPair`, `NodeId`, `AgentId`, `NetworkAccessBytes`, callbacks). All other packages import from here.
- `packages/peerkit` — `@peerkit/peerkit`, the orchestrator. Owns `AgentKeyPair` (the concrete Ed25519 key implementation) and key lifecycle. Uses `@noble/ed25519` for signing and verification — chosen for zero dependencies and identical behaviour on Node.js, browser, and React Native without polyfills.
- `packages/transport-libp2p-core` — `@peerkit/transport-libp2p-core`, the platform-agnostic libp2p transport. Owns the access/agents/messages protocol logic on top of a caller-supplied libp2p instance. Imported by the platform impls; not consumed directly by app code.
- `packages/transport-libp2p-nodejs` — `@peerkit/transport-libp2p-nodejs`, Node.js impl. Builds libp2p with TCP + noise + yamux + identify + dcutr + circuit-relay-v2 and wraps it with `transport-libp2p-core`.
- `packages/transport-libp2p-react-native` — `@peerkit/transport-libp2p-react-native`, React Native impl (planned: WebSocket + WebRTC + circuit-relay-v2 client).
- `packages/transport-libp2p` — `@peerkit/transport-libp2p`, the public facade. Conditional `exports` resolve to the React Native impl when the `react-native` condition matches, otherwise to the Node.js impl. App code depends on this package.
- `packages/metrics` — `@peerkit/metrics`, app-side OpenTelemetry SDK bootstrap. Exposes `initMetrics`/`shutdownMetrics` (OTLP/HTTP export configuration) and bridges OTel diagnostics into the `peerkit.metrics` logtape logger. Per the [OpenTelemetry library guidelines](https://opentelemetry.io/docs/specs/otel/library-guidelines/#api-and-minimal-implementation), library packages depend on `@opentelemetry/api` directly and call `metrics.getMeter(...)`; only applications depend on `@peerkit/metrics` (which transitively pulls the SDK).

Workspace root pins Node `>=22` and uses `"type": "module"` + TypeScript `module: nodenext`. Imports inside TS sources use `.js` extensions (ESM resolution), even when importing `.ts` files.

New workspace packages must:

1. Add a `"references"` entry in the root `tsconfig.json`.
2. Extend the root `tsconfig.json` with `composite: true`, `rootDir: "src"`, `outDir: "dist"`.
3. Add an `exports` field in `package.json` pointing to `./dist/index.js` / `./dist/index.d.ts`.

## Commands

Run from repo root unless noted.

- Install: `npm install`
- Build all (docs + dist): `npm run build`
- Build dist only (TS project references): `npm run build:dist`
- Build typedoc: `npm run build:docs`
- Lint: `npm run lint`
- Format: `npm run fmt`
- Test all workspaces: `npm test`
- Test a single workspace: `npm test -w @peerkit/transport-libp2p-nodejs`
- Single test file: `npm test -w @peerkit/transport-libp2p-nodejs -- tests/access.test.ts`
- Single test by name: `npm test -w @peerkit/transport-libp2p-nodejs -- -t "Invalid network access bytes"`

Vitest runs with `--run` by default (CI-style, no watch).

### CI checks

Do not run CI checks unless explicitly asked. When asked, run the same checks CI runs (`.github/workflows/test.yml`). All four must pass:

- `npm run lint`
- `npx prettier . --check`
- `npm run build`
- `npm test`

## Architecture — transport layer

`ITransport` and all public API is defined in `packages/api/src/transport.ts` and is the contract every transport must satisfy. `TransportLibp2p` in `packages/transport-libp2p-core` is the reference implementation; the Node.js and React Native impls wrap it with platform-specific libp2p setup.

### Transport public API

All runtime methods are keyed by `NodeId` (an opaque `string` — the libp2p peer ID in multibase encoding). No libp2p types cross the public boundary. Mapping between peerkit `AgentId` and transport `NodeId` is the responsibility of the layer above.

### Key behaviors future contributors must preserve

- **Network access gating.** Every incoming connection must complete a raw-bytes handshake on `/peerkit/access/v1` before any other stream is accepted. The `NetworkAccessHandler` decides accept/reject. If no handler is set, or the handler returns `false`, the transport **closes the underlying libp2p connection** (not just the stream). Denied peers are remembered for the session and rejected immediately on reconnect without re-invoking the handler.
- **Access protocol wire format.** The initiator sends its `NetworkAccessBytes` as a raw `Uint8Array` message. The responder replies with its own `NetworkAccessBytes` if access is granted, then closes the connection if not. No protobuf encoding — the protocol ID (`/peerkit/access/v1`) is the version signal.
- **Arrow-field callbacks.** `onAccessConnect`, `onAgentsConnect`, `onMessageConnect` are arrow class fields because libp2p passes them as bare callbacks; converting to methods drops `this`.
- **Incoming message bytes.** libp2p may deliver `message.data` as either `Uint8Array` or `Uint8ArrayList` — normalize with `.subarray()` before use.
- **Construction.** Use `TransportLibp2p.createNode(...)` or `TransportLibp2p.createRelay(...)` (async static factories) rather than `new TransportLibp2p(...)` directly — the factories own libp2p node creation and `start()`.
- **Default `networkAccessBytes`.** Defaults to `new Uint8Array([0])`, not an empty array — an empty array causes `.send()` to be a no-op, which breaks the counter-handshake.

### Two construction modes

- **Node** (`TransportLibp2p.create`): handles all three protocols — access, agents, messages. Supports `bootstrapRelays` to connect at startup.
- **Relay** (`TransportLibp2p.createRelay`): handles access and agents only; message protocol is not registered. Acts as bootstrap and circuit-relay server.

## Logging

`@logtape/logtape`. The transport attaches `peerId` and optional `id` as structured log properties via `getLogger(["peerkit", "transport"]).with({...})`. Tests configure a console sink in `beforeEach` and `reset()` in `afterEach` — mirror this pattern when adding tests that assert on log output.

## Metrics

`@peerkit/metrics` (OpenTelemetry). Conventions every instrumented package must follow:

- **API vs. SDK split.** Library packages depend on `@opentelemetry/api` only and obtain their meter with `metrics.getMeter("@peerkit/<package>", version)`. Only applications (and `@peerkit/metrics` itself) depend on the OTel SDK. Do not add `@peerkit/metrics` as a dependency of a library package — it would pull the SDK into every consumer's tree.
- **Lifecycle.** Applications call `initMetrics({ serviceName, ... })` once at startup and `shutdownMetrics()` on teardown. Without `initMetrics`, `metrics.getMeter(...)` returns OTel's no-op meter — instruments are zero-cost.
- **Instrument creation order.** OTel JS metrics API 1.9 has no proxy meter provider. An instrument captured before `initMetrics()` runs binds permanently to the no-op meter. Therefore instrumented components (e.g. `TransportLibp2p`) create their counters/histograms in the **constructor**, not at module scope. Apps must call `initMetrics()` before constructing instrumented components, and tests must call it in `beforeEach` before `createNode(...)`.
- **Per-package metrics module.** Each instrumented package defines a `src/metrics.ts` that owns its OTel scope name (`@peerkit/<package>`), version, and instrument descriptors, and exposes a `createXxxMetrics()` factory returning a `XxxMetrics` interface. The factory calls `metrics.getMeter(SCOPE_NAME, SCOPE_VERSION)` from `@opentelemetry/api`. The instrumented class stores the factory's return value in a `private readonly metrics: XxxMetrics` field. This keeps OTel descriptors in one place and lets the class body call `this.metrics.<instrument>.add(...)`.
- **Typed attributes.** Counters (and other instruments) are generic over an `Attributes` subtype. Each instrument defines a per-package interface (e.g. `BytesAttributes extends Attributes`) for compile-time enforcement of attribute keys and value types at call sites.
- **Metric naming.** Use OTel semantic conventions when available; otherwise dot-notation `peerkit.<package>.<measure>` (e.g. `peerkit.transport.bytes`). Set `unit` (e.g. `"By"` for bytes) and a `description` that names both dimensions in plain English.
- **Cardinality.** Be deliberate about label cardinality. `direction: "sent" | "received"` is bounded; per-peer labels (`peer: NodeId`) are unbounded and must not be added without a bucketing/sampling strategy. Document any high-cardinality label in the metric's JSDoc. While investigating cardinality blow-up, lower `MetricsConfig.diagLogLevel` to `DiagLogLevel.DEBUG` to surface SDK warnings.
- **Diagnostics.** OTel SDK `diag` channel is bridged to the `["peerkit", "metrics"]` logtape logger. `MetricsConfig.diagLogLevel` (default `DiagLogLevel.WARN`) controls verbosity; lower it when investigating export failures.
- **Tests.** Configure an `InMemoryMetricExporter` + `PeriodicExportingMetricReader` and pass it as `MetricsConfig.reader` in `beforeEach`. Call `shutdownMetrics()` in `afterEach`. Filter metric data via `dataPointType === DataPointType.SUM` (with a type-predicate filter) to narrow the discriminated union before accessing `.value`.

## TypeScript conventions

Root `tsconfig.json` sets strict-plus flags worth knowing before editing:

- `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`.
- `composite: true` — packages are TS project references. New workspace packages must add a `"references"` entry in the root `tsconfig.json` and extend it.

ESLint flat config (`eslint.config.mjs`) ignores `**/dist/**` and `docs/**`.

## Plans

Always write implementation plans to `.claude/plans/` (create the directory if missing). One markdown file per plan, kebab-case name. Do not place plans elsewhere in the repo.

Superpowers skills (`writing-plans`, `executing-plans`, `brainstorming`, etc.) must write to `.claude/plans/` only. Never write plan, brainstorm, or scratch output to `docs/` — `docs/` is reserved for generated typedoc output.

## Git

- Do not add `Co-Authored-By` trailers to commits (global user rule).
- Commit style observed: Conventional Commits (`feat:`, `refactor:`, `docs:`).
