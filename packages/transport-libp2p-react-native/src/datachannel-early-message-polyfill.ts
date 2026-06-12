/**
 * Buffers the earliest message(s) arriving on a freshly opened inbound
 * (in-band) datachannel and replays them once the JS `RTCDataChannel` object
 * and its listener exist.
 *
 * On `react-native-webrtc`, the channel-open announcement and inbound message
 * events can reach JS out of order during connection setup: a message for a
 * newly opened inbound channel may arrive before the corresponding
 * `RTCDataChannel` object is created, leaving no listener to receive it. This
 * polyfill captures such early messages by `reactTag` and delivers them when
 * the listener is attached.
 *
 * Pre-negotiated channels (`createDataChannel` with `negotiated: true, id: 0`
 * on both ends) are unaffected: their JS object and listener exist before any
 * data arrives.
 */

import { Buffer } from "buffer";
import { NativeEventEmitter, NativeModules } from "react-native";

interface NativeReceiveMessageEvent {
  reactTag: string;
  type?: string;
  data: string;
}

interface NativeStateChangeEvent {
  reactTag: string;
  state?: string;
}

// The subset of a `react-native-webrtc` RTCDataChannel instance this relies on.
interface ReactNativeDataChannel {
  _reactTag: string;
}

interface MessageEventLike {
  data: ArrayBuffer;
}

type MessageHandler = (event: MessageEventLike) => unknown;

interface DataChannelProbeHost {
  createDataChannel(label: string): object;
  close(): void;
}

type RTCPeerConnectionConstructor = new () => DataChannelProbeHost;

const PROBE_CHANNEL_LABEL = "peerkit-early-message-probe";
const INSTALLED_FLAG = "__peerkitDataChannelEarlyMessagePatched";

/**
 * Decode a base64 datachannel payload to an exactly sized `ArrayBuffer`,
 * matching how `react-native-webrtc` surfaces binary messages
 * (`event.data.byteLength` must equal the message length).
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const view = Buffer.from(base64, "base64") as unknown as {
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
  };
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * Capture the shared `RTCDataChannel` prototype. The class is not exported, so a
 * throwaway peer connection mints a probe channel and its prototype is read off
 * the instance. Returns `null` if a peer connection cannot be created.
 */
function captureDataChannelPrototype(
  RTCPeerConnectionCtor: RTCPeerConnectionConstructor,
): object | null {
  let probeConnection: DataChannelProbeHost | undefined;
  try {
    probeConnection = new RTCPeerConnectionCtor();
    const channel = probeConnection.createDataChannel(PROBE_CHANNEL_LABEL);
    return Object.getPrototypeOf(channel) as object;
  } catch {
    return null;
  } finally {
    probeConnection?.close();
  }
}

/**
 * Install the early-message recovery. Idempotent, and a no-op when the WebRTC
 * native module or the global `RTCPeerConnection` is absent (`registerGlobals()`
 * has not run, or under tests).
 */
export function installDataChannelEarlyMessagePolyfill(): void {
  const webRtcModule = NativeModules.WebRTCModule;
  const scope = globalThis as {
    RTCPeerConnection?: RTCPeerConnectionConstructor;
  };
  const RTCPeerConnectionCtor = scope.RTCPeerConnection;
  if (webRtcModule == null || RTCPeerConnectionCtor == null) {
    return;
  }

  const prototype = captureDataChannelPrototype(RTCPeerConnectionCtor) as
    | (Record<string, unknown> & object)
    | null;
  if (prototype == null || prototype[INSTALLED_FLAG] === true) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "onmessage");
  if (descriptor?.get == null || descriptor.set == null) {
    return;
  }

  // Early messages buffered per datachannel reactTag, awaiting a consumer.
  const buffered = new Map<string, ArrayBuffer[]>();
  // reactTags whose consumer has attached. Their live messages are delivered by
  // react-native-webrtc's own path, so the duplicate seen here is ignored.
  const consumed = new Set<string>();

  const emitter = new NativeEventEmitter(webRtcModule);
  emitter.addListener("dataChannelReceiveMessage", (raw) => {
    const event = raw as NativeReceiveMessageEvent;
    // libp2p only sends binary frames; ignore everything else.
    if (event.type !== "binary" || consumed.has(event.reactTag)) {
      return;
    }
    const payload = base64ToArrayBuffer(event.data);
    const existing = buffered.get(event.reactTag);
    if (existing) {
      existing.push(payload);
    } else {
      buffered.set(event.reactTag, [payload]);
    }
  });
  emitter.addListener("dataChannelStateChanged", (raw) => {
    const event = raw as NativeStateChangeEvent;
    if (event.state === "closed") {
      buffered.delete(event.reactTag);
      consumed.delete(event.reactTag);
    }
  });

  const originalGet = descriptor.get;
  const originalSet = descriptor.set;
  Object.defineProperty(prototype, "onmessage", {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get(this: ReactNativeDataChannel): unknown {
      return originalGet.call(this);
    },
    set(this: ReactNativeDataChannel, handler: MessageHandler | null): void {
      originalSet.call(this, handler);
      if (handler == null) {
        return;
      }
      const reactTag = this._reactTag;
      // From now on react-native-webrtc delivers live messages to this handler;
      // mark the channel so the duplicate copies seen here are dropped.
      consumed.add(reactTag);
      const pending = buffered.get(reactTag);
      if (pending == null) {
        return;
      }
      buffered.delete(reactTag);
      for (const data of pending) {
        handler({ data });
      }
    },
  });

  Object.defineProperty(prototype, INSTALLED_FLAG, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}
