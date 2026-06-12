import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { ITransport } from "@peerkit/api";
import { beforeEach, describe, expect, test, vi } from "vitest";

// `createRelay` is pure wiring: it assembles a libp2p config that listens on
// WebRTC Direct, constructs the core transport, and starts the node. The real
// libp2p modules cannot run in a unit test, so every collaborator is mocked and
// the captured config is asserted.

const order = vi.hoisted(() => [] as string[]);
const captured = vi.hoisted(
  () =>
    ({}) as {
      libp2pConfig?: Record<string, unknown>;
      webRtcDirectArg?: unknown;
    },
);
const startSpy = vi.hoisted(() => vi.fn(() => order.push("start")));

vi.mock("libp2p", () => ({
  createLibp2p: vi.fn(async (config: Record<string, unknown>) => {
    captured.libp2pConfig = config;
    return { start: startSpy };
  }),
}));

vi.mock("@libp2p/webrtc", () => ({
  webRTCDirect: (arg: unknown) => {
    captured.webRtcDirectArg = arg;
    return { tag: "webrtc-direct" };
  },
}));
vi.mock("@libp2p/circuit-relay-v2", () => ({
  circuitRelayServer: () => ({ tag: "relay-server" }),
}));
vi.mock("@libp2p/identify", () => ({ identify: () => ({ tag: "identify" }) }));
vi.mock("@libp2p/ping", () => ({ ping: () => ({ tag: "ping" }) }));
vi.mock("@chainsafe/libp2p-noise", () => ({ noise: () => ({ tag: "noise" }) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({ tag: "yamux" }) }));

vi.mock("@peerkit/transport-libp2p-core", () => ({
  TransportLibp2p: class {
    constructor() {
      order.push("construct");
    }
  },
}));

const { createRelay } = await import("../src/relay.js");

const baseOptions = {
  networkAccessHandler: async () => true,
  agentsReceivedCallback: async () => {},
};

describe("createRelay", () => {
  beforeEach(() => {
    order.length = 0;
    captured.libp2pConfig = undefined;
    captured.webRtcDirectArg = undefined;
    startSpy.mockClear();
  });

  test("listens on a single WebRTC Direct transport (no websockets)", async () => {
    await createRelay({ ...baseOptions, addrs: ["0.0.0.0:9000"] });

    expect(captured.libp2pConfig?.transports).toEqual([
      { tag: "webrtc-direct" },
    ]);
  });

  test("lets webRTCDirect auto-generate its certificate (no cert argument)", async () => {
    // The relay no longer pre-generates a certificate; libp2p creates an
    // ephemeral one at start. webRTCDirect is therefore called with no config.
    await createRelay({ ...baseOptions, addrs: ["0.0.0.0:9000"] });

    expect(captured.webRtcDirectArg).toBeUndefined();
  });

  test("maps host:port listen addresses to webrtc-direct multiaddrs", async () => {
    await createRelay({ ...baseOptions, addrs: ["0.0.0.0:9000"] });

    expect(captured.libp2pConfig?.addresses).toMatchObject({
      listen: ["/ip4/0.0.0.0/udp/9000/webrtc-direct"],
    });
  });

  test("does not set an announceFilter without a public IP", async () => {
    await createRelay({ ...baseOptions, addrs: ["0.0.0.0:9000"] });

    const addresses = captured.libp2pConfig?.addresses as Record<
      string,
      unknown
    >;
    expect(addresses.announceFilter).toBeUndefined();
  });

  test("installs a public-IP announceFilter when behind NAT", async () => {
    await createRelay({
      ...baseOptions,
      addrs: ["0.0.0.0:9000"],
      publicIp: "1.2.3.4",
    });

    const addresses = captured.libp2pConfig?.addresses as Record<
      string,
      unknown
    >;
    expect(typeof addresses.announceFilter).toBe("function");
  });

  test("public-IP announceFilter keeps only matching address families", async () => {
    await createRelay({
      ...baseOptions,
      addrs: ["0.0.0.0:9000", "[::]:9000"],
      publicIp: "1.2.3.4",
    });

    const addresses = captured.libp2pConfig?.addresses as Record<
      string,
      unknown
    >;
    const announceFilter = addresses.announceFilter as (
      addrs: Multiaddr[],
    ) => Multiaddr[];
    const rewritten = announceFilter([
      multiaddr("/ip4/0.0.0.0/udp/9000/webrtc-direct/certhash/uHASH"),
      multiaddr("/ip6/::/udp/9000/webrtc-direct/certhash/uHASH"),
    ]);

    expect(rewritten.map((addr) => addr.toString())).toEqual([
      "/ip4/1.2.3.4/udp/9000/webrtc-direct/certhash/uHASH",
    ]);
  });

  test("defers listening until after the core transport is constructed", async () => {
    await createRelay({ ...baseOptions, addrs: ["0.0.0.0:9000"] });

    expect(captured.libp2pConfig?.start).toBe(false);
    expect(order).toEqual(["construct", "start"]);
  });

  test("returns the constructed transport", async () => {
    const transport: ITransport = await createRelay({
      ...baseOptions,
      addrs: ["0.0.0.0:9000"],
    });
    expect(transport).toBeDefined();
  });
});
