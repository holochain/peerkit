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

- `packages/api` — `@peerkit/api`, shared type definitions (`ITransport`, `NodeId`, `NetworkAccessBytes`, callbacks). All other packages import from here.
- `packages/transport-libp2p` — `@peerkit/transport-libp2p`, the default transport. Implements `ITransport` on top of libp2p (TCP + noise + yamux + identify).

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
- Test a single workspace: `npm test -w @peerkit/transport-libp2p`
- Single test file: `npm test -w @peerkit/transport-libp2p -- tests/access.test.ts`
- Single test by name: `npm test -w @peerkit/transport-libp2p -- -t "Invalid network access bytes"`

Vitest runs with `--run` by default (CI-style, no watch).

### CI checks

Do not run CI checks unless explicitly asked. When asked, run the same checks CI runs (`.github/workflows/test.yml`). All four must pass:

- `npm run lint`
- `npx prettier . --check`
- `npm run build`
- `npm test`

## Architecture — transport layer

`ITransport` and all public API is defined in `packages/api/src/transport.ts` and is the contract every transport must satisfy. `TransportLibp2p` in `packages/transport-libp2p` is the reference implementation.

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
