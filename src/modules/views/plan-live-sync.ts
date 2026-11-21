/**
 * Plan live-sync — Revit 2D environment audit gap G12 (b).
 *
 * The plan is a separate SVG projection regenerated from the model, NOT a
 * live view of the Three.js scene. This module does not change that: it only
 * coalesces model-change notifications into regenerations, so an open plan
 * refreshes on its own when the model changes instead of waiting for the
 * user to press Regenerate.
 *
 * Two behaviours, both previously broken in the panel's ad-hoc debounce:
 *
 *  1. Debounce / coalesce — a burst of model changes (drawing a chain of
 *     wall segments, a multi-element edit) schedules exactly one
 *     regeneration, `delayMs` after the last change.
 *  2. No dropped changes — a change that arrives while a regeneration is
 *     already running used to be discarded outright (the panel returned
 *     early on `generating`). Here it is remembered as one queued follow-up
 *     that fires when the running regeneration finishes (`markIdle()`),
 *     instead of being lost.
 *
 * DOM-free and timer-based so node tests can exercise it directly. The
 * panel (src/features/plan-view-panel.ts) owns the wiring: it constructs one
 * instance with `onRegenerate: () => void regenerate()` and `isBusy: () =>
 * generating`, feeds it from `onAuthoringChange` (and history-mediated
 * mutations via `createElement` → `notifyAuthoringChange`), and calls
 * `markIdle()` when a regeneration finishes.
 */

export interface PlanLiveSyncOptions {
  /** Debounce window after the last change before regenerating (ms). */
  delayMs?: number;
  /** True while a regeneration is running; changes then queue one follow-up. */
  isBusy?: () => boolean;
  /** Called (at most once per burst) when the plan should regenerate. */
  onRegenerate: () => void;
}

export class PlanLiveSync {
  private readonly delayMs: number;
  private readonly isBusy: () => boolean;
  private readonly onRegenerate: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedWhileBusy = false;

  constructor(options: PlanLiveSyncOptions) {
    this.delayMs = Math.max(0, options.delayMs ?? 400);
    this.isBusy = options.isBusy ?? (() => false);
    this.onRegenerate = options.onRegenerate;
  }

  /** True while a debounced regeneration is still waiting to fire. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** True when a change arrived mid-regeneration and is owed a follow-up. */
  get queued(): boolean {
    return this.queuedWhileBusy;
  }

  /**
   * Record one model change. Rapid successive calls coalesce into a single
   * regeneration `delayMs` after the last call; a call made while a
   * regeneration is running queues exactly one follow-up instead.
   */
  notify(): void {
    if (this.isBusy()) {
      this.queuedWhileBusy = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onRegenerate();
    }, this.delayMs);
  }

  /**
   * Call when a regeneration finishes. If a change arrived while it was
   * running, the owed follow-up fires immediately (the regeneration itself
   * coalesces, so this can never thrash).
   */
  markIdle(): void {
    if (!this.queuedWhileBusy) return;
    this.queuedWhileBusy = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onRegenerate();
  }

  /** Fire a pending debounced regeneration right now, if one is waiting. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.onRegenerate();
  }

  /** Drop any pending or queued regeneration. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queuedWhileBusy = false;
  }

  /** Alias for cancel() — releases timers when the panel is torn down. */
  dispose(): void {
    this.cancel();
  }
}
