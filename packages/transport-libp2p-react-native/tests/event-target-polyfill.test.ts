import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { installEventTargetPolyfill } from "../src/event-target-polyfill.js";

// Node already provides `Event` / `EventTarget` / `CustomEvent`. The polyfill
// replaces them outright (React Native's globals are subclass-incompatible on
// Hermes — see `installEventTargetPolyfill`). To exercise the hand-rolled
// classes we strip those globals, install the polyfill onto the bare scope,
// then restore the originals so the rest of the suite (and other files) observe
// Node's implementations.
type EventGlobals = Pick<
  typeof globalThis,
  "Event" | "EventTarget" | "CustomEvent"
>;

const mutableGlobal = globalThis as unknown as Record<
  keyof EventGlobals,
  unknown
>;

let saved: EventGlobals;

beforeEach(() => {
  saved = {
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent,
  };
  delete mutableGlobal.Event;
  delete mutableGlobal.EventTarget;
  delete mutableGlobal.CustomEvent;
  installEventTargetPolyfill();
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

describe("installEventTargetPolyfill", () => {
  test("installs the three event globals when the runtime lacks them", () => {
    expect(typeof globalThis.Event).toBe("function");
    expect(typeof globalThis.EventTarget).toBe("function");
    expect(typeof globalThis.CustomEvent).toBe("function");
  });

  test("delivers the exact event instance, preserving subclass identity", () => {
    // This is the property libp2p relies on: `@libp2p/interface` dispatches
    // `Event` subclasses with extra fields and re-checks them with `instanceof`.
    class StreamMessageEvent extends globalThis.Event {
      constructor(readonly data: string) {
        super("message");
      }
    }
    const target = new globalThis.EventTarget();
    const listener = vi.fn();
    target.addEventListener("message", listener);

    const event = new StreamMessageEvent("hello");
    const notPrevented = target.dispatchEvent(event);

    expect(notPrevented).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    const received = listener.mock.calls[0]?.[0] as StreamMessageEvent;
    expect(received).toBe(event);
    expect(received).toBeInstanceOf(StreamMessageEvent);
    expect(received.data).toBe("hello");
    expect(received.target).toBe(target);
  });

  test("CustomEvent carries detail and defaults it to null", () => {
    const target = new globalThis.EventTarget();
    const listener = vi.fn();
    target.addEventListener("ping", listener);

    target.dispatchEvent(
      new globalThis.CustomEvent("ping", { detail: { n: 42 } }),
    );
    target.dispatchEvent(new globalThis.CustomEvent("ping"));

    expect(listener.mock.calls[0]?.[0].detail).toEqual({ n: 42 });
    expect(listener.mock.calls[1]?.[0].detail).toBeNull();
  });

  test("honours the `once` option", () => {
    const target = new globalThis.EventTarget();
    const listener = vi.fn();
    target.addEventListener("tick", listener, { once: true });

    target.dispatchEvent(new globalThis.Event("tick"));
    target.dispatchEvent(new globalThis.Event("tick"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("removeEventListener detaches a listener", () => {
    const target = new globalThis.EventTarget();
    const listener = vi.fn();
    target.addEventListener("tick", listener);
    target.removeEventListener("tick", listener);

    target.dispatchEvent(new globalThis.Event("tick"));

    expect(listener).not.toHaveBeenCalled();
  });

  test("respects the abort `signal` option", () => {
    const target = new globalThis.EventTarget();

    const controller = new AbortController();
    const live = vi.fn();
    target.addEventListener("tick", live, { signal: controller.signal });
    controller.abort();
    target.dispatchEvent(new globalThis.Event("tick"));
    expect(live).not.toHaveBeenCalled();

    const aborted = vi.fn();
    target.addEventListener("tick", aborted, { signal: AbortSignal.abort() });
    target.dispatchEvent(new globalThis.Event("tick"));
    expect(aborted).not.toHaveBeenCalled();
  });

  test("dispatchEvent reports a prevented default on a cancelable event", () => {
    const target = new globalThis.EventTarget();
    target.addEventListener("tick", (event) => {
      event.preventDefault();
    });

    const notPrevented = target.dispatchEvent(
      new globalThis.Event("tick", { cancelable: true }),
    );

    expect(notPrevented).toBe(false);
  });

  test("overwrites event globals the runtime already provides", () => {
    // React Native 0.81 ships a global `Event` whose `type` is a read-only
    // getter and whose phase constants are non-configurable, which breaks
    // libp2p's field-declaring `Event` subclasses on Hermes. The polyfill must
    // replace such a global rather than defer to it. Stand in for the native
    // global with a sentinel and assert it is overwritten by `PolyfillEvent`.
    const polyfillEvent = globalThis.Event;
    const nativeSentinel = class NativeEvent {};
    mutableGlobal.Event = nativeSentinel;

    installEventTargetPolyfill();

    expect(globalThis.Event).not.toBe(nativeSentinel);
    expect(globalThis.Event).toBe(polyfillEvent);
  });
});
