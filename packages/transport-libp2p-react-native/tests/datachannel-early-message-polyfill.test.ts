import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Shared registry so the test can drive the native emitter the polyfill
// subscribes to. `vi.hoisted` makes it available inside the `vi.mock` factory.
const native = vi.hoisted(() => {
  const listeners: Array<{ type: string; fn: (event: unknown) => void }> = [];
  return {
    listeners,
    emit(type: string, event: unknown): void {
      for (const listener of listeners) {
        if (listener.type === type) {
          listener.fn(event);
        }
      }
    },
    reset(): void {
      listeners.length = 0;
    },
  };
});

vi.mock("react-native", () => {
  class NativeEventEmitter {
    addListener(
      type: string,
      fn: (event: unknown) => void,
    ): { remove(): void } {
      native.listeners.push({ type, fn });
      return { remove: () => {} };
    }
  }
  return { NativeModules: { WebRTCModule: {} }, NativeEventEmitter };
});

import { installDataChannelEarlyMessagePolyfill } from "../src/datachannel-early-message-polyfill.js";

const mutableGlobal = globalThis as unknown as { RTCPeerConnection?: unknown };

interface FakeDataChannel {
  _reactTag: string;
  onmessage: ((event: { data: ArrayBuffer }) => unknown) | null;
}

let dataChannelPrototype: object;
let savedPeerConnection: unknown;

function makeChannel(reactTag: string): FakeDataChannel {
  return Object.create(dataChannelPrototype, {
    _reactTag: { value: reactTag, writable: true, enumerable: true },
  }) as FakeDataChannel;
}

function binaryEvent(reactTag: string, bytes: number[]): unknown {
  return {
    reactTag,
    type: "binary",
    data: Buffer.from(bytes).toString("base64"),
  };
}

beforeEach(() => {
  native.reset();
  savedPeerConnection = mutableGlobal.RTCPeerConnection;

  // A fresh datachannel prototype per test with a real `onmessage` accessor,
  // mirroring react-native-webrtc's `defineEventAttribute(proto, "message")`.
  const prototype = {};
  Object.defineProperty(prototype, "onmessage", {
    configurable: true,
    enumerable: false,
    get(this: { _onmessageHandler?: unknown }): unknown {
      return this._onmessageHandler ?? null;
    },
    set(this: { _onmessageHandler?: unknown }, handler: unknown): void {
      this._onmessageHandler = handler;
    },
  });
  dataChannelPrototype = prototype;

  class FakeRTCPeerConnection {
    createDataChannel(): object {
      return makeChannel("probe");
    }
    close(): void {}
  }
  mutableGlobal.RTCPeerConnection = FakeRTCPeerConnection;
});

afterEach(() => {
  if (savedPeerConnection === undefined) {
    delete mutableGlobal.RTCPeerConnection;
  } else {
    mutableGlobal.RTCPeerConnection = savedPeerConnection;
  }
});

describe("installDataChannelEarlyMessagePolyfill", () => {
  test("replays an early message dropped before the consumer attached", () => {
    installDataChannelEarlyMessagePolyfill();

    // Message arrives before the RTCDataChannel consumer exists.
    native.emit("dataChannelReceiveMessage", binaryEvent("tag-1", [1, 2, 3]));

    const channel = makeChannel("tag-1");
    const received: ArrayBuffer[] = [];
    channel.onmessage = (event) => {
      received.push(event.data);
    };

    expect(received).toHaveLength(1);
    expect([...new Uint8Array(received[0]!)]).toEqual([1, 2, 3]);
  });

  test("does not re-deliver live messages once the consumer is attached", () => {
    installDataChannelEarlyMessagePolyfill();

    const channel = makeChannel("tag-2");
    const received: ArrayBuffer[] = [];
    channel.onmessage = (event) => {
      received.push(event.data);
    };

    // A live message after attach is delivered by react-native-webrtc's own
    // path; the polyfill must not also replay it.
    native.emit("dataChannelReceiveMessage", binaryEvent("tag-2", [9]));

    expect(received).toHaveLength(0);
  });

  test("drops buffered messages when the channel closes", () => {
    installDataChannelEarlyMessagePolyfill();

    native.emit("dataChannelReceiveMessage", binaryEvent("tag-3", [7]));
    native.emit("dataChannelStateChanged", {
      reactTag: "tag-3",
      state: "closed",
    });

    const channel = makeChannel("tag-3");
    const received: ArrayBuffer[] = [];
    channel.onmessage = (event) => {
      received.push(event.data);
    };

    expect(received).toHaveLength(0);
  });

  test("is a no-op when no RTCPeerConnection is available", () => {
    delete mutableGlobal.RTCPeerConnection;
    expect(() => {
      installDataChannelEarlyMessagePolyfill();
    }).not.toThrow();
  });
});
