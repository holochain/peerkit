import type {
  AuthoredDataSync,
  MemoryBlobStore,
} from "@peerkit/authored-data-sync";
import type { AgentId } from "@peerkit/api";
import type { NodeSession } from "@peerkit/peer-session";
import type * as readline from "node:readline";

export function runNodeCommands(
  rl: readline.Interface,
  session: NodeSession,
  dataSync: AuthoredDataSync,
  blobStore: MemoryBlobStore,
  shutdown: () => Promise<void>,
): void {
  // ---- REPL ---------------------------------------------------------------

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case "whoami": {
        // Identity and transport-level summary of this node.
        console.log(`agent id : ${session.myAgentId}`);
        console.log(`node id  : ${session.node.transport.getNodeId()}`);
        console.log(
          `peers    : ${session.node.getConnectedAgents().length} connected, ${
            session.listPeers().length
          } discovered`,
        );
        break;
      }
      case "status":
      case "stat": {
        // One-glance dashboard: identity, connectivity, and store contents.
        const peers = session.listPeers();
        const connected = peers.filter((p) => p.connected);
        const direct = connected.filter(
          (p) => p.connectionType === "direct",
        ).length;
        const ownBlobs = blobsOf(session.myAgentId);
        const ownBytes = ownBlobs.reduce((n, b) => n + b.blob.byteLength, 0);
        const peerBlobs = totalPeerBlobs();
        console.log(`agent      ${shortAgent(session.myAgentId)}`);
        console.log(
          `peers      ${connected.length}/${peers.length} connected (${direct} direct, ${
            connected.length - direct
          } relayed)`,
        );
        console.log(
          `authored   ${ownBlobs.length} blob(s), ${formatBytes(ownBytes)}`,
        );
        console.log(`replicated ${peerBlobs} blob(s) from peers`);
        break;
      }
      case "peers": {
        // Discovered peers with connection state and how much of their
        // authored data this node currently holds.
        const peers = session.listPeers();
        if (peers.length === 0) {
          console.log("No peers discovered yet");
          break;
        }
        for (const { alias, agentId, connected, connectionType } of peers) {
          const status = connected ? `[${connectionType}]` : "[not connected]";
          const held = blobsOf(agentId).length;
          console.log(
            `${alias.padEnd(3)} ${status.padEnd(10)} ${held} blob(s)  ${shortAgent(
              agentId,
            )}`,
          );
        }
        break;
      }
      case "conn": {
        const alias = args[0];
        if (!alias) {
          console.log("Usage: conn <alias>");
          break;
        }
        try {
          await session.connect(alias);
          console.log(`Connected to ${alias}`);
        } catch (error) {
          console.log(`Connecting to ${alias} failed: ${error}`);
        }
        break;
      }
      case "dsct": {
        const alias = args[0];
        if (!alias) {
          console.log("Usage: dsct <alias>");
          break;
        }
        try {
          await session.disconnect(alias);
          console.log(`Disconnected from ${alias}`);
        } catch (error) {
          console.log(`Disconnecting from ${alias} failed: ${error}`);
        }
        break;
      }
      case "send": {
        const alias = args[0];
        const text = args.slice(1).join(" ");
        if (!alias || text.length === 0) {
          console.log("Usage: send <alias> <message>");
          break;
        }
        try {
          await session.sendText(alias, text);
        } catch (error) {
          console.log(`Send failed: ${error}`);
        }
        break;
      }
      case "store": {
        // Author a text blob; print its content hash and assigned timestamp.
        const text = args.join(" ");
        if (text.length === 0) {
          console.log("Usage: store <text>");
          break;
        }
        const hash = dataSync.store(new TextEncoder().encode(text));
        const stored = dataSync.get(hash, session.myAgentId);
        console.log(`stored ${hex(hash)}`);
        if (stored) {
          console.log(
            `  ${formatBytes(stored.blob.byteLength)}, authoredAt ${new Date(
              stored.authoredAt,
            ).toISOString()} (${epochOf(stored.authoredAt)})`,
          );
        }
        break;
      }
      case "fill": {
        // Stress helper: author N random blobs to exercise sync throughput and
        // the recent/historical split. Usage: fill <count> [bytes]
        const count = Number(args[0]);
        const size = args[1] ? Number(args[1]) : 256;
        if (!Number.isInteger(count) || count <= 0) {
          console.log("Usage: fill <count> [bytes]");
          break;
        }
        // Blobs are content-addressed and deduplicated by hash, so identical
        // bytes collapse to one entry.
        const storedBefore = blobsOf(session.myAgentId).length;
        let totalBytes = 0;
        const start = Date.now();
        for (let i = 0; i < count; i++) {
          const blob = new Uint8Array(size);
          crypto.getRandomValues(blob);
          for (let b = 0; b < Math.min(4, size); b++) {
            blob[b] = (i >> (8 * b)) & 0xff;
          }
          const hash = dataSync.store(blob);
          totalBytes += size;
          console.log(`  ${i + 1}. blob ${hex(hash)}`);
        }
        const newlyStored = blobsOf(session.myAgentId).length - storedBefore;
        const deduped = count - newlyStored;
        console.log(
          `filled ${count} blob(s), ${formatBytes(totalBytes)} in ${
            Date.now() - start
          } ms`,
        );
        if (deduped > 0) {
          console.log(
            `  ${newlyStored} newly stored, ${deduped} deduplicated (identical content already held)`,
          );
        }
        break;
      }
      case "get": {
        // Retrieve a blob by hash from a given author (default: me).
        const hexHash = args[0];
        const author = resolveAuthor(args[1]);
        if (!hexHash) {
          console.log("Usage: get <hash> [me|<alias>]");
          break;
        }
        if (!/^[0-9a-fA-F]+$/.test(hexHash)) {
          console.log(`Invalid hex hash: ${hexHash}`);
          break;
        }
        if (!author) {
          console.log(`Unknown author: ${args[1]}`);
          break;
        }
        const stored = dataSync.get(
          new Uint8Array(Buffer.from(hexHash, "hex")),
          author.agentId,
        );
        if (stored === undefined) {
          console.log(`Not found (author: ${author.label})`);
          break;
        }
        console.log(
          `author     ${author.label} (${shortAgent(author.agentId)})`,
        );
        console.log(`size       ${formatBytes(stored.blob.byteLength)}`);
        console.log(
          `authoredAt ${new Date(stored.authoredAt).toISOString()} (${formatAge(
            stored.authoredAt,
          )}, ${epochOf(stored.authoredAt)})`,
        );
        console.log(`content    ${previewBlob(stored.blob)}`);
        break;
      }
      case "blobs": {
        // List stored blobs grouped by author. `blobs` shows everyone;
        // `blobs me` or `blobs <alias>` narrows to one author.
        const filter = args[0];
        const authors = filter
          ? [resolveAuthor(filter)].filter((a) => a !== undefined)
          : authorsByLabel();
        if (filter && authors.length === 0) {
          console.log(`Unknown author: ${filter}`);
          break;
        }
        let printedAny = false;
        for (const { label, agentId } of authors) {
          const blobs = blobsOf(agentId);
          if (blobs.length === 0) continue;
          printedAny = true;
          const bytes = blobs.reduce((n, b) => n + b.blob.byteLength, 0);
          console.log(
            `${label} (${shortAgent(agentId)}) — ${blobs.length} blob(s), ${formatBytes(
              bytes,
            )}`,
          );
          for (const b of blobs) {
            console.log(
              `  ${shortHex(hex(b.hash)).padEnd(14)} ${formatBytes(
                b.blob.byteLength,
              ).padEnd(9)} ${epochOf(b.authoredAt).padEnd(10)} ${formatAge(
                b.authoredAt,
              )}`,
            );
          }
        }
        if (!printedAny) {
          console.log("No blobs stored");
        }
        break;
      }
      case "pull": {
        // Trigger reconciliation now instead of waiting for the timer. Reports
        // how many peer blobs were gained. `pull <alias>` targets one peer.
        const alias = args[0];
        const before = totalPeerBlobs();
        try {
          if (alias) {
            const peer = peerByAlias(alias);
            if (!peer) {
              console.log(`Unknown peer: ${alias}`);
              break;
            }
            if (!peer.connected) {
              console.log(
                `Peer ${alias} is not connected — run 'conn ${alias}'`,
              );
              break;
            }
            await dataSync.pullFromPeer(peer.agentId);
          } else {
            const connected = session.listPeers().filter((p) => p.connected);
            if (connected.length === 0) {
              console.log("No connected peers to pull from");
              break;
            }
            await dataSync.pullFromAllPeers();
          }
        } catch (error) {
          console.log(`Pull failed: ${error}`);
          break;
        }
        const after = totalPeerBlobs();
        console.log(
          `pull complete: ${after - before} new blob(s), now holding ${after} from peers`,
        );
        break;
      }
      case "help":
        console.log("Identity & peers");
        console.log("  whoami                — Show this node's identity");
        console.log("  status                — Dashboard: peers and store");
        console.log("  peers                 — Discovered peers + held blobs");
        console.log("  conn <alias>          — Connect to a discovered peer");
        console.log("  dsct <alias>          — Disconnect from a peer");
        console.log("  send <alias> <msg>    — Send a text message");
        console.log("Authored data sync");
        console.log("  store <text>          — Author a text blob");
        console.log("  fill <count> [bytes]  — Author N random blobs (stress)");
        console.log(
          "  get <hash> [author]   — Fetch a blob (author: me|alias)",
        );
        console.log("  blobs [author]        — List stored blobs by author");
        console.log(
          "  pull [alias]          — Reconcile now (all or one peer)",
        );
        console.log("Session");
        console.log("  exit                  — Shut down and quit");
        break;
      case "exit":
      case "quit":
        await shutdown();
        break;
      case "":
      case undefined:
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type help for usage.`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log();
    console.log("Closing peerkit CLI");
    void shutdown();
  });

  process.on("SIGINT", () => {
    void shutdown();
  });

  // ---- formatting helpers -------------------------------------------------

  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  const shortHex = (value: string) =>
    value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
  const shortAgent = (agentId: AgentId) => shortHex(agentId);

  function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function formatAge(authoredAt: number) {
    const deltaMs = Date.now() - authoredAt;
    if (deltaMs < 1_000) return "just now";
    const s = Math.floor(deltaMs / 1_000);
    if (s < 60) return `${s} s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  function epochOf(authoredAt: number) {
    const epoch = dataSync.epochDuration;
    const epochStart = Math.floor(Date.now() / epoch) * epoch;
    return authoredAt >= epochStart ? "recent" : "historical";
  }

  // Decode a blob to text when it is printable; otherwise show a hex preview.
  // The `fill` command writes random bytes, so binary blobs are expected.
  function previewBlob(blob: Uint8Array) {
    const printable = blob.every(
      (b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f),
    );
    if (printable) return new TextDecoder().decode(blob);
    const preview = hex(blob.subarray(0, 32));
    return `<binary ${formatBytes(blob.byteLength)}> ${preview}${
      blob.byteLength > 32 ? "…" : ""
    }`;
  }

  // ---- store/peer helpers -------------------------------------------------

  // All authors this node may hold data for: itself plus every peer it has an
  // alias for. `since: 0` returns every blob the store holds for that author.
  function authorsByLabel() {
    const peers = session
      .listPeers()
      .map((p) => ({ label: p.alias, agentId: p.agentId }));
    return [{ label: "me", agentId: session.myAgentId }, ...peers];
  }

  function blobsOf(agentId: AgentId) {
    return blobStore.getByAuthorSince(agentId, 0);
  }

  function totalPeerBlobs() {
    return session
      .listPeers()
      .reduce((sum, p) => sum + blobsOf(p.agentId).length, 0);
  }

  // Resolve an author token: "me"/empty → self, an alias → that peer.
  function resolveAuthor(token: string | undefined) {
    if (token === undefined || token === "me") {
      return { label: "me", agentId: session.myAgentId };
    }
    const peer = session.listPeers().find((p) => p.alias === token);
    return peer ? { label: peer.alias, agentId: peer.agentId } : undefined;
  }

  // Look up a discovered peer by alias, with full connection state. Returns the
  // session's own peer record (no CLI-side type), or undefined if unknown.
  function peerByAlias(alias: string) {
    return session.listPeers().find((p) => p.alias === alias);
  }
}
