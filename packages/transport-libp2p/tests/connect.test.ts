import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  reset,
} from "@logtape/logtape";
import { afterEach, beforeEach, test } from "vitest";
import getPort from "get-port";
import { TransportLibp2p } from "../src/index.js";
import { multiaddr } from "@multiformats/multiaddr";

beforeEach(async () => {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: getAnsiColorFormatter({
          format({ timestamp, level, category, message, record }) {
            let output = `${timestamp} ${level} ${category}`;
            if (
              "id" in record.properties &&
              typeof record.properties.id === "string"
            ) {
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
  // Reset logger configuration
  await reset();
});

test("A node can connect to a bootstrap node and identify its own listening address", async () => {
  const bootstrapNodePort = await getPort({ port: [30_000, 40_000] });
  const bootstrapNodeAddr = `/ip4/127.0.0.1/tcp/${bootstrapNodePort}`;
  const bootstrapNode = await TransportLibp2p.create({
    addrs: [bootstrapNodeAddr],
    id: "bootstrap",
  });

  // Create a node and connect to the bootstrap node.
  const node = await TransportLibp2p.create({ id: "node" });
  await node.connect(multiaddr(bootstrapNodeAddr), new Uint8Array());

  // Wait for the new listening addresses to have been identified.
  await new Promise((resolve, reject) => {
    node.onNewAddress((addrs) => resolve(addrs));
    setTimeout(reject, 100);
  });

  await node.stop();
  await bootstrapNode.stop();
});
