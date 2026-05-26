# @peerkit/relay

Quick-setup bootstrap/relay node for the [peerkit](https://github.com/holochain/peerkit) framework.

A peerkit relay serves two roles for a closed network:

- **Bootstrap server** — newly started nodes connect to it and receive the
  set of known, signature-verified agent-info records (replay), so they can
  discover peers without a central directory.
- **Circuit-relay server** — nodes that are not directly dialable (mobile,
  NAT'd) accept inbound connections through the relay until a direct WebRTC
  connection can be upgraded.

This package wraps `PeerkitRelayBuilder` from `@peerkit/peerkit` with sensible
lifecycle wiring (structured logging, OpenTelemetry metrics, an in-memory
agent store, signal-driven shutdown) so the common case is a few lines.

> **Status:** library only. The package exposes `run`/`startRelay`; a CLI and
> deployment artifacts are tracked separately.

## Install

```sh
npm install @peerkit/relay
```

## Usage

`run` owns the full process lifecycle: it initializes metrics, creates the
agent store, starts the relay, and installs `SIGINT`/`SIGTERM` handlers that
shut everything down cleanly.

```ts
import { run, type RelayConfig } from "@peerkit/relay";
import { createHash } from "node:crypto";

// Every node in a closed network must present these exact bytes to be
// admitted. Derive them however you like; here from a shared secret.
const accessBytes = new Uint8Array(
  createHash("sha256")
    .update(process.env.NETWORK_SECRET ?? "")
    .digest(),
);

const config: RelayConfig = {
  id: "relay-1",
  logLevel: "info",
  // The Node.js relay transport speaks WebSockets, so listen addresses
  // carry the `/ws` suffix.
  listenAddrs: ["/ip4/0.0.0.0/tcp/9000/ws"],
  // Bytes this relay announces to dialing peers.
  NetworkAccessBytes: accessBytes,
  // Admission decision for each inbound peer's presented bytes.
  networkAccessHandler: async (_nodeId, bytes) =>
    bytes.length === accessBytes.length &&
    bytes.every((b, i) => b === accessBytes[i]),
  // Optional: announce a public hostname so peers behind NAT can dial in.
  publicHost: process.env.PUBLIC_HOST,
  // Optional: export metrics over OTLP/HTTP.
  otel: process.env.OTLP_ENDPOINT
    ? { otlpEndpoint: process.env.OTLP_ENDPOINT }
    : undefined,
};

// `run` rejects if startup fails (after rolling back any partial state); on
// success it resolves and the process stays alive on its signal handlers.
// Exit non-zero so an orchestrator restarts a relay that failed to start.
run(config).catch((err) => {
  console.error("relay failed to start", err);
  process.exit(1);
});
```

To embed a relay inside a larger process instead of owning the lifecycle, use
`startRelay`, which returns a `RunningRelay` handle (`transport`, `nodeId`,
`peerCount()`, `shutdown()`):

```ts
import { startRelay, createLogger } from "@peerkit/relay";
import { MemoryAgentStore } from "@peerkit/agent-store";

const logger = createLogger({ level: "info", id: "relay-1" });
const agentStore = new MemoryAgentStore();
const relay = await startRelay(config, { logger, agentStore });

// ... later
await relay.shutdown();
```

## Configuration

`RelayConfig` fields:

| Field                  | Type                   | Required | Description                                                                  |
| ---------------------- | ---------------------- | -------- | ---------------------------------------------------------------------------- |
| `id`                   | `string`               | yes      | Stable relay identifier; used in logs and as the metrics service.            |
| `logLevel`             | `string`               | yes      | Log level (`debug`/`info`/`warn`/`error`; `warn` aliases logtape `warning`). |
| `listenAddrs`          | `readonly string[]`    | yes      | libp2p multiaddrs to listen on; WebSocket addresses need `/ws`.              |
| `NetworkAccessBytes`   | `NetworkAccessBytes`   | yes      | Bytes the relay announces to dialing peers.                                  |
| `networkAccessHandler` | `NetworkAccessHandler` | yes      | `(nodeId, bytes) => Promise<boolean>` admission decision per peer.           |
| `publicHost`           | `string`               | no       | Public hostname announced so NAT'd peers can dial in.                        |
| `otel`                 | `OtelConfig`           | no       | OTLP/HTTP metrics export; omit to disable metrics export.                    |

`OtelConfig` fields: `otlpEndpoint` (required), `exportIntervalMs`, `headers`.

## Metrics

When `otel` is set, the relay exports OpenTelemetry metrics under the
`@peerkit/relay` meter: access checks, connected peers, stored agents, agents
received, and agent replays. See `@peerkit/metrics` for export configuration.

## License

CAL-1.0
