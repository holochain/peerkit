import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
} from "@logtape/logtape";
import { startRelay } from "@peerkit/peer-session";
import { localDevRelayListenAddr } from "@peerkit/transport-libp2p-nodejs";
import type { Command } from "commander";
import { logLevel } from "./logging.js";

export function addRelayCommand(program: Command): void {
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
      const consoleSink = getConsoleSink({
        formatter: getAnsiColorFormatter(),
      });
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
}
