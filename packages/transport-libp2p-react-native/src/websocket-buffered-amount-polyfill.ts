/**
 * Make React Native's `WebSocket` report a numeric `bufferedAmount`.
 *
 * React Native declares `bufferedAmount` on its `WebSocket` but never assigns
 * it, so it reads as `undefined`. `@libp2p/websockets` drives write backpressure
 * off that value, and the `undefined` comparisons leave every write parked
 * waiting for a `drain` that never fires, hanging the connection.
 *
 * React Native hands every frame straight to the native socket with no
 * JS-visible send buffer to measure, so `0` ("fully flushed") is the correct,
 * backpressure-free answer. A prototype accessor returns `0` for reads and
 * swallows React Native's `undefined` field initialization with a no-op setter,
 * so no shadowing own property is left on the instance.
 */

interface PrototypeHost {
  readonly prototype?: object;
}

/**
 * Install the `bufferedAmount` accessor on the global `WebSocket` prototype.
 * Idempotent, and a no-op when the runtime already exposes a real getter (e.g.
 * a browser or Node polyfill) or provides no `WebSocket` at all (e.g. tests).
 */
export function installWebSocketBufferedAmountPolyfill(): void {
  const scope = globalThis as { WebSocket?: PrototypeHost };
  const prototype = scope.WebSocket?.prototype;
  if (prototype == null) {
    return;
  }
  const existing = Object.getOwnPropertyDescriptor(prototype, "bufferedAmount");
  if (existing?.get != null) {
    return;
  }
  Object.defineProperty(prototype, "bufferedAmount", {
    configurable: true,
    get(): number {
      return 0;
    },
    set(): void {
      // Swallow React Native's `undefined` field initialization so it cannot
      // create an own property that shadows this accessor.
    },
  });
}
