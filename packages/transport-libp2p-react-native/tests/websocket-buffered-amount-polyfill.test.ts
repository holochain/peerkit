import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { installWebSocketBufferedAmountPolyfill } from "../src/websocket-buffered-amount-polyfill.js";

// The polyfill patches the global `WebSocket` prototype, so each test swaps in a
// stand-in constructor and restores the original afterwards.
const mutableGlobal = globalThis as unknown as { WebSocket?: unknown };

let saved: unknown;

beforeEach(() => {
  saved = mutableGlobal.WebSocket;
});

afterEach(() => {
  if (saved === undefined) {
    delete mutableGlobal.WebSocket;
  } else {
    mutableGlobal.WebSocket = saved;
  }
});

describe("installWebSocketBufferedAmountPolyfill", () => {
  test("reports 0 for a socket that never assigns bufferedAmount", () => {
    class FakeWebSocket {}
    mutableGlobal.WebSocket = FakeWebSocket;

    installWebSocketBufferedAmountPolyfill();

    const socket = new FakeWebSocket() as { bufferedAmount: number };
    expect(socket.bufferedAmount).toBe(0);
  });

  test("reports 0 even when the runtime initializes the field to undefined", () => {
    // Mirrors React Native: the constructor assigns the property (an `[[Set]]`),
    // which the polyfill's no-op setter must swallow so no own property shadows
    // the accessor.
    class FakeWebSocket {
      constructor() {
        (this as { bufferedAmount?: number }).bufferedAmount = undefined;
      }
    }
    mutableGlobal.WebSocket = FakeWebSocket;

    installWebSocketBufferedAmountPolyfill();

    const socket = new FakeWebSocket() as { bufferedAmount: number };
    expect(socket.bufferedAmount).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(socket, "bufferedAmount")).toBe(
      false,
    );
  });

  test("does not overwrite a real bufferedAmount getter", () => {
    class FakeWebSocket {
      get bufferedAmount(): number {
        return 42;
      }
    }
    mutableGlobal.WebSocket = FakeWebSocket;

    installWebSocketBufferedAmountPolyfill();

    const socket = new FakeWebSocket() as { bufferedAmount: number };
    expect(socket.bufferedAmount).toBe(42);
  });

  test("is a no-op when the runtime provides no WebSocket", () => {
    delete mutableGlobal.WebSocket;
    expect(() => {
      installWebSocketBufferedAmountPolyfill();
    }).not.toThrow();
  });
});
