import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  reset,
} from "@logtape/logtape";
import { afterEach, beforeEach, test } from "vitest";
import { TransportLibp2p } from "../src/index.js";

beforeEach(async () => {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: getAnsiColorFormatter({
          format({ timestamp, level, category, message, record }) {
            let output = `${timestamp} ${level} ${category}`;
            if (typeof record.properties.id === "string") {
              output = output + ` ${record.properties.id}`;
            }
            output = output + `: ${message}`;
            return output;
          },
        }),
      }),
    },
    loggers: [
      {
        category: "peerkit",
        lowestLevel: "info",
        sinks: ["console"],
      },
    ],
  });
});

afterEach(async () => {
  await reset();
});

test("A relay node starts and stops cleanly", async () => {
  const relay = await TransportLibp2p.createRelay({ id: "relay" });
  relay.setNetworkAccessHandler((_agentId, _bytes) => true);
  relay.setAgentsReceivedHandler((_fromAgent, _bytes) => {});
  await relay.stop();
});
