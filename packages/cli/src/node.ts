import { getFileSink } from "@logtape/file";
import { configure } from "@logtape/logtape";
import {
  AuthoredDataSync,
  FullReplicationStrategy,
  MemoryBlobStore,
} from "@peerkit/authored-data-sync";
import { startNode } from "@peerkit/peer-session";
import { defaultNodeListenAddrs } from "@peerkit/transport-libp2p-nodejs";
import type { Command } from "commander";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { runNodeCommands } from "./commands.js";
import { logLevel } from "./logging.js";

export function addNodeCommand(program: Command): void {
  program
    .command("node <relay-addrs...>")
    .description(
      "Start a peer node connected to the given relay address(es). Opens an interactive REPL.",
    )
    .option(
      "--listen <addrs>",
      "Comma-separated listen addresses (overrides transport defaults).",
    )
    .option(
      "--epoch <ms>",
      "Epoch window in milliseconds for recent/historical sync (default: 1 day). Short values help observe blobs aging into the historical segment.",
    )
    .option(
      "--auto-sync",
      "Periodically pull from peers in the background. Off by default — use the `pull` command for manual, observable sync.",
    )
    .option(
      "--pull-interval <ms>",
      "Background auto-sync interval in milliseconds (default: 30000). --auto-sync has to be enabled for this to be effective.",
    )
    .action(
      async (
        relayAddrs: string[],
        opts: {
          listen?: string;
          epoch?: string;
          autoSync?: boolean;
          pullInterval?: string;
        },
      ) => {
        // Create a temporary log file.
        const stderrLog = join(tmpdir(), `peerkit-${process.pid}.log`);
        // Pipe all outputs from stderr to the log file. That enables libraries
        // upstream from peerkit that log to stderr to be recorded in the file
        // too.
        const stderrStream = createWriteStream(stderrLog, { flags: "a" });
        process.stderr.write = (chunk: string | Uint8Array) =>
          stderrStream.write(chunk);

        await configure({
          sinks: {
            file: getFileSink(stderrLog, {
              // Do not block file stream, to allow everything else output to
              // stderr like the transport library's logs be written to the
              // file too.
              nonBlocking: true,
            }),
          },
          loggers: [
            { category: "peerkit", lowestLevel: logLevel, sinks: ["file"] },
            {
              category: ["peerkit", ""],
              lowestLevel: logLevel,
              sinks: ["file"],
            },
            {
              category: ["logtape", "meta"],
              lowestLevel: "warning",
              sinks: ["file"],
            },
          ],
        });

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: "peerkit> ",
        });

        function printAbove(line: string): void {
          readline.cursorTo(process.stdout, 0);
          const timestamp = new Date().toISOString();
          console.log(`${timestamp} ${line}`);
          rl.prompt(true); // Redraw prompt
        }

        const addresses = opts.listen
          ? opts.listen.split(",").map((a) => a.trim())
          : defaultNodeListenAddrs;

        let epochDurationMs: number | undefined;
        if (opts.epoch !== undefined) {
          epochDurationMs = Number(opts.epoch);
          if (!Number.isInteger(epochDurationMs) || epochDurationMs <= 0) {
            console.error(
              `Invalid --epoch value: ${opts.epoch} (expected positive integer milliseconds)`,
            );
            process.exit(1);
          }
        }

        let pullIntervalMs = 30_000;
        if (opts.pullInterval !== undefined) {
          pullIntervalMs = Number(opts.pullInterval);
          if (!Number.isInteger(pullIntervalMs) || pullIntervalMs <= 0) {
            console.error(
              `Invalid --pull-interval value: ${opts.pullInterval} (expected positive integer milliseconds)`,
            );
            process.exit(1);
          }
        }

        const blobStore = new MemoryBlobStore();
        const dataSync = new AuthoredDataSync(
          blobStore,
          new FullReplicationStrategy(),
          pullIntervalMs,
          epochDurationMs, // undefined falls back to the module default (1 day)
        );

        const session = await startNode({
          bootstrapRelays: relayAddrs,
          addresses,
          modules: [dataSync],
          callbacks: {
            onRelayConnected: (address) => {
              printAbove(`[Connected to relay]: ${address}`);
            },
            onAgentsReceived: (agentIds) => {
              for (const id of agentIds) {
                printAbove(`[Peer discovered]: ${id}`);
              }
            },
            onPeerConnected: (alias, agentId) => {
              printAbove(`[Peer connected]: ${alias}: ${agentId}`);
            },
            onPeerDisconnected: (alias) => {
              printAbove(`[Peer disconnected]: ${alias}`);
            },
            onMessageReceived: (alias, text) => {
              printAbove(`[Message from ${alias}]: ${text}`);
            },
          },
        });

        // The module auto-starts its periodic pull on registration. Unless the
        // operator opted into background auto-sync, halt the timer so `pull`
        // stays the only initiator — the responder side and manual pulls are
        // unaffected.
        if (!opts.autoSync) {
          await dataSync.stop();
        }

        // Guard prevents double-shutdown when exit/quit triggers rl.close(),
        // which fires the close event, which would otherwise call shutdown again.
        let shuttingDown = false;
        async function shutdownSession(): Promise<void> {
          if (shuttingDown) return;
          shuttingDown = true;
          rl.close();
          stderrStream.end();
          await session.shutdown();
          process.exit(0);
        }

        // Startup output
        console.log();
        console.log(`Node session started with agent ID ${session.myAgentId}`);
        console.log(`Epoch window ${dataSync.epochDuration} ms`);
        console.log(
          `Auto-sync ${
            opts.autoSync
              ? `on, every ${pullIntervalMs} ms`
              : "off (use 'pull')"
          }`,
        );
        console.log(`Log file at ${stderrLog}`);
        console.log();
        rl.prompt();

        runNodeCommands(rl, session, dataSync, blobStore, shutdownSession);
      },
    );
}
