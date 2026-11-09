/**
 * Constraint auto-solve — the live-drag half of Revit's parametric
 * behaviour: locked dimensions, equality, alignment, parallel and
 * perpendicular constraints re-enforce themselves right after a move /
 * drag commit, without the user pressing the Solve button.
 *
 * Engine (this module) is pure: a re-entrant debounce gate with an
 * enable flag and counters. The feature layer (constraint-solver.ts)
 * binds `fire` to solveHostedConstraints() and calls `schedule()` at the
 * end of every transform commit.
 *
 * Design notes:
 *   - Debounced (default 120 ms) so a multi-frame drag commits once and
 *     solves once, not per pointermove.
 *   - Re-entrant safe: a solve that is already running defers the next
 *     schedule instead of stacking.
 *   - Persisted toggle handled by the feature layer (localStorage lives
 *     there; this module stays DOM-free).
 */

export interface AutoSolveEngine {
  /** Queue a solve after the debounce window (no-op when disabled). */
  schedule(): void;
  /** Solve immediately (bypasses the debounce; still re-entrant safe). */
  flush(): void;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** Diagnostics: schedules queued, flushes run, solves skipped (busy). */
  stats(): { scheduled: number; flushed: number; skipped: number; pending: boolean };
  /** Cancel a pending debounce (test + teardown hook). */
  cancel(): void;
}

export function createAutoSolveEngine(
  fire: () => void | Promise<void>,
  opts: { debounceMs?: number } = {},
): AutoSolveEngine {
  const debounceMs = Math.max(0, opts.debounceMs ?? 120);
  let enabled = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let rerunQueued = false;
  let scheduled = 0;
  let flushed = 0;
  let skipped = 0;

  const run = async (): Promise<void> => {
    if (busy) { rerunQueued = true; skipped++; return; }
    busy = true;
    try { await fire(); } catch { /* the feature layer logs its own errors */ } finally {
      busy = false;
      if (rerunQueued) { rerunQueued = false; await run(); }
    }
  };

  return {
    schedule() {
      if (!enabled) return;
      scheduled++;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, debounceMs);
    },
    flush() {
      if (!enabled) return;
      if (timer != null) { clearTimeout(timer); timer = null; }
      scheduled++;
      flushed++;
      void run();
    },
    setEnabled(on: boolean) {
      enabled = !!on;
      if (!enabled && timer != null) { clearTimeout(timer); timer = null; }
    },
    isEnabled: () => enabled,
    stats: () => ({ scheduled, flushed, skipped, pending: timer != null || busy }),
    cancel() {
      if (timer != null) { clearTimeout(timer); timer = null; }
    },
  };
}
