import type { ITransport } from "@peerkit/api";
import { beforeEach, describe, expect, test, vi } from "vitest";

// `createNode` is pure wiring: it assembles a libp2p config, constructs the
// shared core transport, starts the node, and optionally dials relays. None of
// the real libp2p modules (or the React Native crypto) can run in a Node test,
// so every collaborator is mocked. The mocks return tagged markers so the
// captured config can be asserted without depending on libp2p internals.

// Records the relative order of node construction vs. start so the
// "register protocol handlers before listening" contract can be verified.
const order = vi.hoisted(() => [] as string[]);

// Captures the most recent libp2p config and the WebRTC factory argument so
// individual tests can inspect what `createNode` requested.
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
    // The fake node only needs the `start` method `createNode` calls.
    return { start: startSpy };
  }),
}));

vi.mock("@libp2p/websockets", () => ({ webSockets: () => ({ tag: "ws" }) }));
vi.mock("@libp2p/webrtc", () => ({
  webRTC: (arg: { rtcConfiguration?: { iceServers?: unknown } }) => {
    captured.webRtcArg = arg;
    return { tag: "webrtc" };
  },
}));
vi.mock("@libp2p/circuit-relay-v2", () => ({
  circuitRelayTransport: () => ({ tag: "relay" }),
}));
vi.mock("@libp2p/identify", () => ({ identify: () => ({ tag: "identify" }) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({ tag: "yamux" }) }));
// `noise` is mocked, but `quick-crypto-noise` (pulled in transitively) imports
// `pureJsCrypto` from the same module and spreads it, so the mock must expose
// it. `react-native-quick-crypto` is likewise mocked because that module loads
// it at import time.
vi.mock("@chainsafe/libp2p-noise", () => ({
  noise: () => ({ tag: "noise" }),
  pureJsCrypto: {},
}));
vi.mock("react-native-quick-crypto", () => ({ default: {} }));

// Replace the core transport with a fake that records construction order and
// exposes the `connectToRelays` spy `createNode` calls for bootstrap relays.
vi.mock("@peerkit/transport-libp2p-core", () => ({
  TransportLibp2p: class {
    connectToRelays = connectToRelaysSpy;
    constructor() {
      order.push("construct");
    }
  },
}));

const { createNode, defaultNodeListenAddrs } =
  await import("../src/factories.js");

describe("createNode", () => {
  beforeEach(() => {
    order.length = 0;
    captured.libp2pConfig = undefined;
    captured.webRtcArg = undefined;
    startSpy.mockClear();
    connectToRelaysSpy.mockClear();
  });

  test("defers listening until after protocol handlers are registered", async () => {
    // libp2p must be created with `start: false`, and the node started only
    // after the core transport is constructed — otherwise an inbound stream
    // could arrive before `/peerkit/access/v1` is registered.
    await createNode({});

    expect(captured.libp2pConfig?.start).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["construct", "start"]);
  });

  test("configures the mobile transport set", async () => {
    // WebSockets (outbound) + WebRTC + circuit-relay-v2: the three transports a
    // relay-mediated mobile peer needs. No raw TCP, no listener.
    await createNode({});

    expect(captured.libp2pConfig?.transports).toEqual([
      { tag: "ws" },
      { tag: "webrtc" },
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

  test("overrides listen addresses when `addrs` is provided", async () => {
    const addrs = ["/p2p-circuit"];
    await createNode({ addrs });

    expect(captured.libp2pConfig?.addresses).toEqual({ listen: addrs });
  });

  test("maps `iceServerUrls` into the WebRTC rtcConfiguration", async () => {
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

  test("dials bootstrap relays when provided", async () => {
    const bootstrapRelays = ["/dns4/relay.example/tcp/443/wss/p2p/12D3Koo"];
    await createNode({ bootstrapRelays });

    expect(connectToRelaysSpy).toHaveBeenCalledExactlyOnceWith(bootstrapRelays);
  });

  test("does not dial relays when none are provided", async () => {
    await createNode({});

    expect(connectToRelaysSpy).not.toHaveBeenCalled();
  });

  test("does not dial relays for an empty bootstrap list", async () => {
    // An empty array is falsy-length: the fire-and-forget dial must be skipped
    // rather than invoked with nothing to connect to.
    await createNode({ bootstrapRelays: [] });

    expect(connectToRelaysSpy).not.toHaveBeenCalled();
  });

  test("returns the constructed transport", async () => {
    const transport: ITransport = await createNode({});
    expect(transport).toBeDefined();
    expect(transport.connectToRelays).toBe(connectToRelaysSpy);
  });
});
