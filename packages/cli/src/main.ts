#!/usr/bin/env node
import { getFileSink } from "@logtape/file";
import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  parseLogLevel,
  type LogLevel,
} from "@logtape/logtape";
import { startNode, startRelay } from "@peerkit/peer-session";
import { FileAgentKeyStore } from "@peerkit/peerkit/node";
import {
  localDevRelayListenAddr,
  defaultNodeListenAddrs,
} from "@peerkit/transport-libp2p-nodejs";
import { Command } from "commander";
import { createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

const consoleSink = getConsoleSink({ formatter: getAnsiColorFormatter() });
const logLevel: LogLevel = process.env.PEERKIT_LOG
  ? parseLogLevel(process.env.PEERKIT_LOG)
  : "warning";

const program = new Command();
program.name("peerkit").description(
  "Developer CLI for peerkit\n\n\
Set peerkit log level with env var PEERKIT_LOG.\n\
Available log levels are trace, debug, info, warning, error, fatal.\n\
Default: PEERKIT_LOG=warning",
);

program
  .command("relay [addr]")
  .description(
    `Start a relay (default addr: ${localDevRelayListenAddr}). Prints the dial address peers use to connect.`,
  )
  .option(
    "--public-ip <ip>",
    "Public IP to announce (required behind NAT). Peers dial this IP; the relay listens locally on 0.0.0.0:0.",
  )
  .action(async (addr?: string, opts: { publicIp?: string } = {}) => {
    await configure({
      sinks: { main: consoleSink },
      loggers: [
        { category: "peerkit", lowestLevel: logLevel, sinks: ["main"] },
        {
          category: ["logtape", "meta"],
          lowestLevel: "warning",
          sinks: ["main"],
        },
      ],
    });

    const listenAddr = addr ?? localDevRelayListenAddr;
    const relaySession = await startRelay({
      listenAddr,
      publicIp: opts.publicIp,
      onPeerConnected: (nodeId) => {
        console.log(`[Peer connected]: ${nodeId}`);
      },
      onAgentsReceived: (agentIds) => {
        for (const id of agentIds) {
          console.log(`[Agent registered]: ${id}`);
        }
      },
    });
    console.log(`Relay address: ${relaySession.dialAddr}`);

    process.on("SIGINT", async () => {
      await relaySession.shutdown();
      process.exit(0);
    });
  });

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
    "--identity <path>",
    "Path to the node's identity key file. Defaults to $PEERKIT_IDENTITY, else the platform data dir (Windows: %LOCALAPPDATA%\\peerkit\\identity.key, otherwise $XDG_DATA_HOME/peerkit/identity.key or ~/.local/share/peerkit/identity.key).",
  )
  .action(
    async (
      relayAddrs: string[],
      opts: { listen?: string; identity?: string },
    ) => {
      await main(relayAddrs, opts);
    },
  );

await program.parseAsync();

// Resolves the platform's per-user data directory for persisted identity keys.
const defaultDataDir = (): string => {
  if (process.platform === "win32") {
    return process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  }
  return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
};

const main = async (
  relayAddrs: string[],
  opts: { listen?: string; identity?: string },
): Promise<void> => {
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
      { category: ["peerkit", ""], lowestLevel: logLevel, sinks: ["file"] },
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

  // Persist the node identity so its AgentId survives restarts. Precedence:
  // --identity flag, then $PEERKIT_IDENTITY, then the platform data dir.
  // Windows uses %LOCALAPPDATA% (its app data convention); elsewhere the XDG
  // data dir is used (macOS' "Application Support" path is deliberately avoided).
  const identityPath =
    opts.identity ??
    process.env["PEERKIT_IDENTITY"] ??
    join(defaultDataDir(), "peerkit", "identity.key");
  const agentKeyStore = new FileAgentKeyStore(identityPath);

  // rl is created only after startup succeeds to avoid leaking it on failure.
  const session = await startNode({
    bootstrapRelays: relayAddrs,
    addresses,
    agentKeyStore,
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
  console.log(`Log file at ${stderrLog}`);
  console.log();
  rl.prompt();

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case "list": {
        const peers = session.listPeers();
        if (peers.length === 0) {
          console.log("(No peers discovered yet)");
        } else {
          for (const { alias, agentId, connected, connectionType } of peers) {
            const status = connected
              ? `[${connectionType}]`
              : "[not connected]";
            console.log(`${alias}  ${status}  ${agentId}`);
          }
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
      case "dsct": {
        const alias = args[0];
        if (!alias) {
          console.log("Usage: dsct <alias>");
          break;
        }
        try {
          await session.disconnect(alias);
        } catch (error) {
          console.log(`Disconnecting from ${alias} failed: ${error}`);
        }
        break;
      }
      case "help":
        console.log("  list                  — Show discovered peers");
        console.log("  send <alias> <msg>    — Send a text message");
        console.log("  dsct <alias>          — Disconnect from peer");
        console.log("  exit                  — Shut down and quit");
        break;
      case "exit":
      case "quit":
        await shutdownSession();
        break;
      case "":
      case undefined:
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type help for usage.`);
    }

    rl?.prompt();
  });

  rl.on("close", () => {
    console.log();
    console.log("Closing peerkit CLI");
    shutdownSession();
  });

  process.on("SIGINT", () => {
    shutdownSession();
  });
};
