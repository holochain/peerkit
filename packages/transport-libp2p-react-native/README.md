# @peerkit/transport-libp2p-react-native

React Native implementation of the peerkit transport layer. Wires
`@peerkit/transport-libp2p-core` to a libp2p stack configured for mobile:
WebSockets (outbound), WebRTC, and circuit-relay-v2 client.

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
those out of the box (Hermes is Meta's JavaScript engine for React
Native). The package ships a single side-effect entry that
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
5. Installs the WHATWG `Event` / `EventTarget` / `CustomEvent` globals that
   Hermes lacks but `@libp2p/interface` extends at module init.
6. Installs UTF-8 `TextEncoder` / `TextDecoder` globals that Hermes lacks but
   `uint8arrays` constructs at module init.

## Metro config

Metro (React Native's JavaScript bundler) must rewrite Node-style bare
imports to their React Native shims. Add
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

Compile public class fields with spec `[[Define]]` semantics by setting the
`setPublicClassFields: false` assumption:

```js
module.exports = {
  presets: ["babel-preset-expo"], // or "module:@react-native/babel-preset"
  assumptions: {
    setPublicClassFields: false,
  },
};
```

This is **required**, not optional. `babel-preset-expo` defaults to loose
(`[[Set]]`) class fields, which compile an uninitialized field declaration to
`this.field = void 0`. React Native's webapis define read-only prototype
constants — notably `Event.prototype.NONE` (and `CAPTURING_PHASE` /
`AT_TARGET` / `BUBBLING_PHASE`) via `Object.defineProperty` without
`writable: true`. The matching `this.NONE = void 0` walks the prototype chain
and throws `Cannot assign to read-only property 'NONE'` the moment libp2p or
WebRTC construct an `Event`. The `[[Define]]` assumption drops the bare
declaration, so the read-only constant is never assigned.

Do **not** add `["@babel/plugin-transform-private-methods", { loose: true }]`:
its loose option sets the opposite assumption (`setPublicClassFields: true`)
and reintroduces the crash. libp2p's private fields (`#field`) are transformed
by the preset without it.

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

- No background operation. iOS suspends the JS runtime when the app is
  backgrounded; Android Doze mode throttles. Foreground-only without
  additional OS-specific work.
