/**
 * Listener scope — deterministic registration and disposal for event
 * listeners, intervals and timeouts.
 *
 * Boot-time modules used to register window listeners and timers by hand and
 * clear them with ad-hoc flags; a missed clear meant a duplicate listener or
 * a timer firing after its owner was gone. A scope makes the lifetime
 * explicit:
 *
 *   • every registration returns a disposer
 *   • `dispose()` removes everything the scope created, idempotently
 *   • `on()` refuses to register the exact same target/type/listener/capture
 *     twice — duplicate listeners become impossible inside one scope
 *   • registrations after `dispose()` are no-ops that warn once (a silent
 *     leak indicator, not a crash)
 *
 * Used by the boot layer (critical-gaps-boot readiness polling, boot-health
 * UI) and available to any feature that owns cleanup-able resources.
 */

export type Disposer = () => void;

export type ListenerOptions = boolean | AddEventListenerOptions;

interface Registration {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  disposer: Disposer;
}

export interface ListenerScope {
  /**
   * Add an event listener owned by this scope. Registering the identical
   * (target, type, listener, capture) pair again is a no-op that returns the
   * original disposer instead of stacking a second listener.
   */
  on(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: ListenerOptions,
  ): Disposer;
  /** Repeating timer owned by this scope. Returns its disposer. */
  interval(fn: () => void, ms: number): Disposer;
  /** One-shot timer owned by this scope. Returns its disposer. */
  timeout(fn: () => void, ms: number): Disposer;
  /** Remove every registration this scope created. Idempotent. */
  dispose(): void;
  /** Live registrations (listeners + running timers). */
  readonly size: number;
  /** True once dispose() has run. */
  readonly disposed: boolean;
}

function captureOf(options?: ListenerOptions): boolean {
  if (options == null) return false;
  if (typeof options === "boolean") return options;
  return options.capture === true;
}

export function createListenerScope(): ListenerScope {
  const registrations: Registration[] = [];
  let disposed = false;
  let warnedAfterDispose = false;

  function guard(name: string): boolean {
    if (!disposed) return true;
    if (!warnedAfterDispose) {
      warnedAfterDispose = true;
      // eslint-disable-next-line no-console
      console.warn(`[listener-scope] registration "${name}" after dispose() — ignored`);
    }
    return false;
  }

  function add(reg: Registration): void {
    registrations.push(reg);
  }

  function remove(reg: Registration): void {
    const idx = registrations.indexOf(reg);
    if (idx >= 0) registrations.splice(idx, 1);
    try {
      reg.target.removeEventListener(reg.type, reg.listener, reg.capture);
    } catch {
      /* removing from a dead target must never throw */
    }
  }

  function makeDisposer(reg: Registration): Disposer {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      remove(reg);
    };
  }

  return {
    on(target, type, listener, options) {
      if (!guard(`on:${type}`)) return () => undefined;
      const capture = captureOf(options);
      // Duplicate guard: identical target + type + listener + capture already
      // registered by this scope → do not stack a second listener.
      for (const r of registrations) {
        if (r.target === target && r.type === type && r.listener === listener && r.capture === capture) {
          return makeDisposer(r);
        }
      }
      try {
        target.addEventListener(type, listener, options);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[listener-scope] addEventListener(${type}) failed`, err);
        return () => undefined;
      }
      const reg: Registration = { target, type, listener, capture, disposer: () => undefined };
      reg.disposer = makeDisposer(reg);
      add(reg);
      return reg.disposer;
    },

    interval(fn, ms) {
      if (!guard("interval")) return () => undefined;
      const id: ReturnType<typeof setInterval> = setInterval(() => {
        try {
          fn();
        } catch (err) {
          // A throwing interval must not kill the host loop silently.
          // eslint-disable-next-line no-console
          console.error("[listener-scope] interval callback failed", err);
        }
      }, ms);
      const reg: Registration = {
        target: null as unknown as EventTarget,
        type: `interval:${id}`,
        listener: () => undefined,
        capture: false,
        disposer: () => undefined,
      };
      const disposer = () => {
        clearInterval(id as unknown as ReturnType<typeof setTimeout>);
        remove(reg);
      };
      reg.disposer = disposer;
      add(reg);
      return disposer;
    },

    timeout(fn, ms) {
      if (!guard("timeout")) return () => undefined;
      const id: ReturnType<typeof setTimeout> = setTimeout(() => {
        // One-shot: drop the registration before running so size stays honest.
        remove(reg);
        try {
          fn();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[listener-scope] timeout callback failed", err);
        }
      }, ms);
      const reg: Registration = {
        target: null as unknown as EventTarget,
        type: `timeout:${id}`,
        listener: () => undefined,
        capture: false,
        disposer: () => undefined,
      };
      const disposer = () => {
        clearTimeout(id);
        remove(reg);
      };
      reg.disposer = disposer;
      add(reg);
      return disposer;
    },

    dispose() {
      // Copy first: disposers mutate the array.
      for (const reg of registrations.slice()) {
        try {
          reg.disposer();
        } catch {
          /* disposal must never throw */
        }
      }
      registrations.length = 0;
      disposed = true;
    },

    get size(): number {
      return registrations.length;
    },

    get disposed(): boolean {
      return disposed;
    },
  };
}
