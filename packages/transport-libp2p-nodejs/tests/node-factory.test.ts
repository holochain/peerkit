import type { ITransport } from "@peerkit/api";
import { beforeEach, describe, expect, test, vi } from "vitest";

// `createNode` is pure wiring: it assembles a libp2p config, constructs the core
// transport, starts the node, and optionally dials relays. Every libp2p module
// is mocked; the captured config is asserted without depending on internals.

const order = vi.hoisted(() => [] as string[]);
const captured = vi.hoisted(
  () =>
    ({}) as {
      libp2pConfig?: Record<string, unknown>;
      webRtcArg?: { rtcConfiguration?: { iceServers?: unknown } };
    },
);
const startSpy = vi.hoisted(() => vi.fn(() => order.push("start")));
const connectToRelaysSpy = vi.hoisted(() => vi.fn());

vi.mock("libp2p", () => ({
  createLibp2p: vi.fn(async (config: Record<string, unknown>) => {
    captured.libp2pConfig = config;
    return { start: startSpy };
  }),
}));

vi.mock("@libp2p/webrtc", () => ({
  webRTC: (arg: { rtcConfiguration?: { iceServers?: unknown } }) => {
    captured.webRtcArg = arg;
    return { tag: "webrtc" };
  },
  webRTCDirect: () => ({ tag: "webrtc-direct" }),
}));
vi.mock("@libp2p/circuit-relay-v2", () => ({
  circuitRelayTransport: () => ({ tag: "relay" }),
}));
vi.mock("@libp2p/identify", () => ({ identify: () => ({ tag: "identify" }) }));
vi.mock("@libp2p/dcutr", () => ({ dcutr: () => ({ tag: "dcutr" }) }));
vi.mock("@chainsafe/libp2p-noise", () => ({ noise: () => ({ tag: "noise" }) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({ tag: "yamux" }) }));

vi.mock("@peerkit/transport-libp2p-core", () => ({
  TransportLibp2p: class {
    connectToRelays = connectToRelaysSpy;
    constructor() {
      order.push("construct");
    }
  },
}));

const { createNode, defaultNodeListenAddrs } = await import("../src/node.js");

describe("createNode", () => {
  beforeEach(() => {
    order.length = 0;
    captured.libp2pConfig = undefined;
    captured.webRtcArg = undefined;
    startSpy.mockClear();
    connectToRelaysSpy.mockClear();
  });

  test("configures webrtc + webrtc-direct + circuit-relay transports (no websockets)", async () => {
    // WebRTC Direct reaches the relay (browser-safe); WebRTC is node-to-node;
    // circuit-relay dials peers through the relay. Plain websockets is gone.
    await createNode({});

    expect(captured.libp2pConfig?.transports).toEqual([
      { tag: "webrtc" },
      { tag: "webrtc-direct" },
      { tag: "relay" },
    ]);
  });

  test("defaults to the relay-circuit + webrtc listen addresses", async () => {
    await createNode({});

    expect(captured.libp2pConfig?.addresses).toEqual({
      listen: defaultNodeListenAddrs,
    });
    expect(defaultNodeListenAddrs).toEqual(["/p2p-circuit", "/webrtc"]);
  });

  test("maps iceServerUrls into the WebRTC rtcConfiguration", async () => {
    await createNode({
      iceServerUrls: ["stun:stun.example:3478", "turn:turn.example:3478"],
    });

    expect(captured.webRtcArg?.rtcConfiguration?.iceServers).toEqual([
      { urls: "stun:stun.example:3478" },
      { urls: "turn:turn.example:3478" },
    ]);
  });

  test("leaves iceServers undefined when no URLs are given", async () => {
    await createNode({});

    expect(captured.webRtcArg?.rtcConfiguration?.iceServers).toBeUndefined();
  });

  test("defers listening until after the core transport is constructed", async () => {
    await createNode({});

    expect(captured.libp2pConfig?.start).toBe(false);
    expect(order).toEqual(["construct", "start"]);
  });

  test("dials bootstrap relays when provided", async () => {
    const bootstrapRelays = [
      "/ip4/1.2.3.4/udp/9000/webrtc-direct/certhash/uH/p2p/12D3Koo",
    ];
    await createNode({ bootstrapRelays });

    expect(connectToRelaysSpy).toHaveBeenCalledExactlyOnceWith(bootstrapRelays);
  });

  test("does not dial relays for an empty bootstrap list", async () => {
    await createNode({ bootstrapRelays: [] });

    expect(connectToRelaysSpy).not.toHaveBeenCalled();
  });

  test("returns the constructed transport", async () => {
    const transport: ITransport = await createNode({});
    expect(transport).toBeDefined();
    expect(transport.connectToRelays).toBe(connectToRelaysSpy);
  });
});
