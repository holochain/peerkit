import {
  configure,
  getAnsiColorFormatter,
  getConsoleSink,
  reset,
} from "@logtape/logtape";
import { multiaddr } from "@multiformats/multiaddr";
import getPort from "get-port";
import { afterEach, beforeEach, test } from "vitest";
import { TransportLibp2p } from "../src/index.js";
import { retryFnUntilTimeout } from "./util.js";

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
    node.setNewAddressesHandler((addrs) => resolve(addrs));
    setTimeout(reject, 1000);
  });

  await node.stop();
  await bootstrapNode.stop();
});

test("Missing network access handler closes connections", async () => {
  const port1 = await getPort({ port: [30_000, 40_000] });
  const address1 = `/ip4/0.0.0.0/tcp/${port1}`;
  const node1 = await TransportLibp2p.create({
    addrs: [address1],
    id: "node1",
  });

  // No function set to check network access bytes.

  // Create a node and attempt to connect.
  const node2 = await TransportLibp2p.create({ id: "node2" });
  const connection = await node2.connect(
    multiaddr(address1),
    new TextEncoder().encode("bytes"),
  );

  // Make sure the connection gets closed by the node1.
  await retryFnUntilTimeout(async () => connection.isClosed(), 1000, 100);

  await node2.stop();
  await node1.stop();
});

test("Invalid network access bytes closes connection", async () => {
  const validNodePort = await getPort({ port: [30_000, 40_000] });
  const validNodeAddress = `/ip4/0.0.0.0/tcp/${validNodePort}`;
  const validNode = await TransportLibp2p.create({
    addrs: [validNodeAddress],
    id: "valid",
  });

  // Set function to check network access bytes.
  validNode.setNetworkAccessHandler(() => false);

  // Create a node and pass invalid network access bytes to the connection attempt.
  const invalidNode = await TransportLibp2p.create({ id: "invalid" });
  const connection = await invalidNode.connect(
    multiaddr(validNodeAddress),
    new TextEncoder().encode("invalid"),
  );

  // Make sure the connection gets closed by the valid node.
  await retryFnUntilTimeout(async () => connection.isClosed(), 1000, 100);

  await invalidNode.stop();
  await validNode.stop();
});
