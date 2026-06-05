/**
 * A self-contained WHATWG `Event` / `EventTarget` / `CustomEvent` polyfill for
 * the React Native Hermes engine.
 *
 * React Native's `setUpDOM` polyfills a handful of DOM globals (`DOMRect`,
 * `Node`, `Element`, ...) but **not** the event classes, and Hermes ships none
 * of them. libp2p depends on all three at module-evaluation time:
 *
 *  - `@libp2p/interface` declares `class StreamMessageEvent extends Event`.
 *  - `main-event`'s `TypedEventEmitter extends EventTarget` and dispatches
 *    `new CustomEvent(type, { detail })`.
 *
 * Without these globals the bundle red-screens with
 * `Property 'Event' doesn't exist` before any application code runs.
 *
 * This is a hand-rolled implementation rather than a dependency on
 * `event-target-shim` on purpose: the shim's type definitions expose `Event`
 * only as an interface (not a constructor value), and its dispatcher wraps
 * foreign event objects in a copy — which breaks the `instanceof` checks and
 * subclass fields (e.g. `StreamMessageEvent.data`) that libp2p relies on.
 * Owning both `Event` and `EventTarget` here guarantees the exact event
 * instance is delivered to every listener.
 */

interface EventInitLike {
  readonly bubbles?: boolean;
  readonly cancelable?: boolean;
  readonly composed?: boolean;
}

interface CustomEventInitLike<T> extends EventInitLike {
  readonly detail?: T;
}

interface EventListenerOptions {
  readonly capture?: boolean;
}

interface AddEventListenerOptions extends EventListenerOptions {
  readonly once?: boolean;
  readonly passive?: boolean;
  readonly signal?: AbortSignalLike;
}

/**
 * The minimal `AbortSignal` surface honoured by `addEventListener`'s `signal`
 * option. libp2p frequently scopes listeners to an abort signal, so a listener
 * registered with an already-aborted signal must never fire, and one tied to a
 * live signal must be removed when it aborts.
 */
interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
}

type EventListenerCallback =
  | ((event: PolyfillEvent) => void)
  | { handleEvent(event: PolyfillEvent): void };

interface RegisteredListener {
  readonly callback: EventListenerCallback;
  readonly once: boolean;
}

function normalizeAddOptions(
  options?: boolean | AddEventListenerOptions,
): AddEventListenerOptions {
  if (typeof options === "boolean") {
    return { capture: options };
  }
  return options ?? {};
}

/** WHATWG `Event`. */
class PolyfillEvent {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;

  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly timeStamp = 0;
  readonly isTrusted = false;
  readonly eventPhase = PolyfillEvent.NONE;

  private targetInternal: PolyfillEventTarget | null = null;
  private currentTargetInternal: PolyfillEventTarget | null = null;
  private defaultPreventedInternal = false;
  private propagationStopped = false;
  private immediatePropagationStopped = false;

  constructor(type: string, eventInitDict?: EventInitLike) {
    this.type = type;
    this.bubbles = eventInitDict?.bubbles ?? false;
    this.cancelable = eventInitDict?.cancelable ?? false;
    this.composed = eventInitDict?.composed ?? false;
  }

  get target(): PolyfillEventTarget | null {
    return this.targetInternal;
  }

  get srcElement(): PolyfillEventTarget | null {
    return this.targetInternal;
  }

  get currentTarget(): PolyfillEventTarget | null {
    return this.currentTargetInternal;
  }

  get defaultPrevented(): boolean {
    return this.defaultPreventedInternal;
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPreventedInternal = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }

  composedPath(): PolyfillEventTarget[] {
    return this.currentTargetInternal == null
      ? []
      : [this.currentTargetInternal];
  }

  // The following methods are polyfill-internal: `PolyfillEventTarget` uses them
  // to drive dispatch state across the class boundary (TypeScript `private`
  // members are not reachable from another class).

  /** @internal */
  beginDispatch(target: PolyfillEventTarget): void {
    this.targetInternal = target;
    this.currentTargetInternal = target;
  }

  /** @internal */
  endDispatch(): void {
    this.currentTargetInternal = null;
  }

  /** @internal */
  get immediatePropagationWasStopped(): boolean {
    return this.immediatePropagationStopped;
  }
}

/** WHATWG `CustomEvent`. */
class PolyfillCustomEvent<T = unknown> extends PolyfillEvent {
  readonly detail: T | null;

  constructor(type: string, eventInitDict?: CustomEventInitLike<T>) {
    super(type, eventInitDict);
    this.detail = eventInitDict?.detail ?? null;
  }
}

/** WHATWG `EventTarget`. */
class PolyfillEventTarget {
  private readonly listenerMap = new Map<string, RegisteredListener[]>();

  addEventListener(
    type: string,
    callback: EventListenerCallback | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (callback == null) {
      return;
    }
    const opts = normalizeAddOptions(options);
    const signal = opts.signal;
    if (signal?.aborted === true) {
      return;
    }
    const list = this.listenerMap.get(type) ?? [];
    // Per spec a (callback, capture) pair is registered at most once.
    if (list.some((entry) => entry.callback === callback)) {
      return;
    }
    list.push({ callback, once: opts.once ?? false });
    this.listenerMap.set(type, list);
    if (signal != null) {
      signal.addEventListener("abort", () => {
        this.removeEventListener(type, callback);
      });
    }
  }

  removeEventListener(
    type: string,
    callback: EventListenerCallback | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (callback == null) {
      return;
    }
    const list = this.listenerMap.get(type);
    if (list == null) {
      return;
    }
    const index = list.findIndex((entry) => entry.callback === callback);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  dispatchEvent(event: PolyfillEvent): boolean {
    event.beginDispatch(this);
    // Snapshot the list: a listener may add or remove listeners mid-dispatch.
    const list = this.listenerMap.get(event.type);
    if (list != null) {
      for (const entry of [...list]) {
        if (entry.once) {
          this.removeEventListener(event.type, entry.callback);
        }
        const { callback } = entry;
        if (typeof callback === "function") {
          callback(event);
        } else {
          callback.handleEvent(event);
        }
        if (event.immediatePropagationWasStopped) {
          break;
        }
      }
    }
    event.endDispatch();
    return !event.defaultPrevented;
  }
}

/**
 * Install `Event`, `EventTarget`, and `CustomEvent` on the global scope,
 * overwriting any implementation the runtime already provides.
 *
 * The overwrite is deliberate, not defensive. React Native's own global `Event`
 * exposes read-only/non-configurable members (`type`, the phase constants) that
 * libp2p's event subclasses redeclare as class fields, which throws at
 * construction on Hermes. {@link PolyfillEvent} declares them as writable,
 * configurable fields, so the three globals are replaced outright (not `??=`d)
 * to guarantee a single, subclass-safe hierarchy for libp2p's `instanceof`
 * checks and `EventTarget` dispatch.
 *
 * Runs once from the polyfills entry, before any libp2p module evaluates. Safe
 * to call more than once.
 */
export function installEventTargetPolyfill(): void {
  const eventScope = globalThis as {
    Event?: unknown;
    EventTarget?: unknown;
    CustomEvent?: unknown;
  };
  eventScope.Event = PolyfillEvent;
  eventScope.EventTarget = PolyfillEventTarget;
  eventScope.CustomEvent = PolyfillCustomEvent;
}
