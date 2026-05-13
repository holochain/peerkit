# @peerkit/transport-libp2p-react-native

React Native implementation of the peerkit transport layer. Wires
`@peerkit/transport-libp2p-core` to a libp2p stack configured for mobile:
WebSockets (outbound), WebRTC, and circuit-relay-v2 client.

Mobile peers cannot accept inbound direct connections (CGNAT, no listen socket
survives backgrounding on iOS or Android). Reachability is therefore always
mediated by a relay; direct peer-to-peer is achieved with WebRTC over a
circuit-relay-v2 reservation, using ICE/STUN for hole-punching.

## Install

```sh
npm install @peerkit/transport-libp2p-react-native
npm install react-native-get-random-values react-native-quick-crypto react-native-webrtc
```

The three `react-native-*` peer dependencies provide native modules and must
be linked via the standard React Native autolinking flow (iOS: `pod install`,
Android: Gradle sync).

## Polyfills

libp2p depends on Node built-ins (`crypto`, `stream`, `buffer`, `events`,
`process`) and on the Web Crypto / WebRTC globals. Hermes provides none of
those out of the box. The package ships a single side-effect entry that
installs everything in the right order.

Add **as the very first import** of the app entry (typically `index.js` or
`App.tsx`):

```js
import "@peerkit/transport-libp2p-react-native/polyfills";
```

The polyfill module:

1. Patches `globalThis.crypto.getRandomValues` via
   `react-native-get-random-values`. Must run first — peer-id generation and
   noise key generation reach for RNG during module init.
2. Installs `react-native-quick-crypto`, providing a JSI-backed
   `globalThis.crypto.subtle`.
3. Registers `react-native-webrtc` globals (`RTCPeerConnection`,
   `RTCSessionDescription`, etc.) consumed by `@libp2p/webrtc`.
4. Assigns `globalThis.Buffer` and `globalThis.process` from the `buffer` and
   `process` shims so libp2p code that touches these as globals (rather than
   ES module imports) works.

## Metro config

Metro must rewrite Node-style bare imports to their React Native shims. Add
the following to `metro.config.js`:

```js
const { getDefaultConfig } = require("@react-native/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  crypto: require.resolve("react-native-quick-crypto"),
  stream: require.resolve("readable-stream"),
  buffer: require.resolve("buffer"),
  events: require.resolve("events"),
  process: require.resolve("process"),
};

// libp2p 3.x publishes a `browser` conditional export that is broken under
// Metro's package-exports resolver — see <https://github.com/libp2p/js-libp2p/issues/2969>.
// Enabling the resolver is required for several libp2p subpackages to
// resolve at all; per-package overrides may be needed if a specific module
// fails to bundle.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
```

## Babel config

libp2p uses ES2022 private class fields (`#field`). Hermes parses these
correctly on recent React Native versions, but stale Babel caches can still
trip up. Ensure the private-methods transform is enabled:

```js
module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [["@babel/plugin-transform-private-methods", { loose: true }]],
};
```

## Usage

```ts
import "@peerkit/transport-libp2p-react-native/polyfills";
import { createNode } from "@peerkit/transport-libp2p-react-native";

const transport = await createNode({
  networkAccessBytes: new Uint8Array([
    /* network access bytes */
  ]),
  bootstrapRelays: ["/dns4/relay.example.com/tcp/443/wss/p2p/12D3Koo..."],
  // Optional: defaults to ["/p2p-circuit", "/webrtc"].
  addrs: ["/p2p-circuit", "/webrtc"],
});
```

`createNode` returns a `TransportLibp2p` instance from
`@peerkit/transport-libp2p-core`. Refer to that package's documentation for
the public API (`onAccessConnect`, `onAgentsConnect`, `onMessageConnect`,
`sendAgents`, `sendMessage`, etc.).

## Noise crypto

`createNode` wires Noise with a JSI-backed `ICryptoInterface` over
`react-native-quick-crypto`. SHA-256, HKDF and ChaCha20-Poly1305 run as
native code; X25519 stays on the pure-JS Noise default because
`ICryptoInterface` is synchronous and quick-crypto's X25519 surface is not.

The adapter is also exported standalone for consumers who want to wire it
into their own libp2p stack:

```ts
import { quickCryptoNoise } from "@peerkit/transport-libp2p-react-native/quick-crypto-noise";
```

## Runtime scope

Importing the package's main entry pulls `react-native-quick-crypto` at
module load time. The package is therefore intended exclusively for React
Native bundles — do not import it from Node test code. Type-only imports
(`import type { ... }`) remain safe in any TypeScript context.

## Known limitations

- No hole-punching via DCUtR (see
  <https://github.com/libp2p/js-libp2p/discussions/2388>). All direct
  peer-to-peer connections go over WebRTC; if WebRTC ICE fails, traffic
  remains relayed.
- No background operation. iOS suspends the JS runtime when the app is
  backgrounded; Android Doze mode throttles. Foreground-only without
  additional OS-specific work.
- No local discovery (no mDNS).
- Mobile peer cannot listen for inbound direct connections. The transport
  advertises `/p2p-circuit` and `/webrtc` listen addresses only.
