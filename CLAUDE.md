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
- When spec terminology exists (`AgentId`, `PeerId`, `NetworkAccessBytes`, `Blob`, `Hash`, `willStore`, epoch, tombstone, etc.), use it verbatim.

## Monorepo layout

npm workspaces. Root is private and orchestrates builds; only published packages live under `packages/`.

- `packages/transport-libp2p` — `@peerkit/transport-libp2p`, the default transport. Implements the `ITransport` interface on top of libp2p (TCP + noise + yamux + identify).

Workspace root pins Node `>=22` and uses `"type": "module"` + TypeScript `module: nodenext`. Imports inside TS sources use `.js` extensions (ESM resolution), even when importing `.ts` files.

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
- Single test file: `npm test -w @peerkit/transport-libp2p -- tests/connect.test.ts`
- Single test by name: `npm test -w @peerkit/transport-libp2p -- -t "Invalid network access bytes"`

Vitest runs with `--run` by default (CI-style, no watch).

### CI checks

Before declaring work done, run the same checks CI runs (`.github/workflows/test.yml`). All four must pass:

- `npm run lint`
- `npx prettier . --check`
- `npm run build`
- `npm test`

## Architecture — transport layer

`ITransport` (`packages/transport-libp2p/src/types/transport.ts`) is the contract a transport must satisfy. `TransportLibp2p` is the reference implementation.

Key behaviors future contributors must preserve:

- **Network access gating.** Every incoming stream on `/peerkit/access/0.1.0` must present `NetworkAccessBytes` first. The handler registered via `setNetworkAccessHandler` decides accept/reject. If no handler is set, or the handler returns `false`, the transport **closes the underlying libp2p connection** (not just the stream). Tests in `tests/connect.test.ts` lock this in.
- **Access protocol constant.** `ACCESS_PROTOCOL = "/peerkit/access/0.1.0"` — changing it is a breaking protocol change.
- **Arrow-field callbacks.** `onConnect` is an arrow class field because libp2p invokes it as a bare callback; converting it to a method drops `this`.
- **Incoming message bytes.** libp2p may deliver `message.data` as either `Uint8Array` or a `Uint8ArrayList` — normalize with `.subarray()` as in `transport.ts`.
- **Address identification.** New listening addresses are surfaced via the `peer:identify` event and forwarded to `setNewAddressesHandler`. Handlers are last-write-wins; overwriting warns.
- **Construction.** Use `TransportLibp2p.create(options)` (async) rather than `new TransportLibp2p(...)` directly — the static factory owns libp2p node creation and `start()`.

## Logging

`@logtape/logtape`. The transport attaches `peerId` and optional `id` as structured log properties via `getLogger(["peerkit", "transport"]).with({...})`. Tests configure a console sink in `beforeEach` and `reset()` in `afterEach` — mirror this pattern when adding tests that assert on log output.

## TypeScript conventions

Root `tsconfig.json` sets strict-plus flags worth knowing before editing:

- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`.
- `composite: true` — packages are TS project references. New workspace packages must add a `"references"` entry in the root `tsconfig.json` and extend it.

ESLint flat config (`eslint.config.mjs`) ignores `**/dist/**` and `docs/**`.

## Plans

Always write implementation plans to `.claude/plans/` (create the directory if missing). One markdown file per plan, kebab-case name. Do not place plans elsewhere in the repo.

Superpowers skills (`writing-plans`, `executing-plans`, `brainstorming`, etc.) must write to `.claude/plans/` only. Never write plan, brainstorm, or scratch output to `docs/` — `docs/` is reserved for generated typedoc output.

## Git

- Do not add `Co-Authored-By` trailers to commits (global user rule).
- Commit style observed: Conventional Commits (`feat:`, `refactor:`, `docs:`).
