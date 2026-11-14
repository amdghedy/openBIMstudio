/**
 * Coalesces bursty invalidate requests into at most one callback per
 * animation frame.
 *
 * Pointer-driven hot paths (plan pan/drag, hover picking) can receive 60-120
 * events per second while the display shows 30-60 frames per second — doing
 * full work per event wastes multiple rebuilds per displayed frame. The
 * coalescer keeps one pending callback and schedules it once.
 *
 * Pure and injectable: tests pass a manual schedule function.
 */

export interface RafCoalescer {
  /** Request `cb` to run on the next frame; replaces any pending callback. */
  request(cb: () => void): void;
  /** Run the pending callback immediately (tests / teardown). The
   * already-scheduled frame will later find nothing pending — harmless. */
  flush(): void;
  /** Whether a callback is currently pending. */
  readonly pending: boolean;
}

function defaultSchedule(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => cb());
  } else {
    setTimeout(cb, 0);
  }
}

export function createRafCoalescer(
  scheduleFn: (cb: () => void) => void = defaultSchedule,
): RafCoalescer {
  let queued = false;
  let pending: (() => void) | null = null;
  const run = () => {
    queued = false;
    const cb = pending;
    pending = null;
    if (cb) cb();
  };
  return {
    request(cb: () => void): void {
      pending = cb;
      if (queued) return;
      queued = true;
      scheduleFn(run);
    },
    flush(): void {
      const cb = pending;
      pending = null;
      queued = false;
      if (cb) cb();
    },
    get pending(): boolean {
      return pending !== null;
    },
  };
}
