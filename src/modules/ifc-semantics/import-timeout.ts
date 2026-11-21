/**
 * Browser IFC import timeout (Revit parity rank 2, issue #231 follow-up).
 *
 * The Node fuzz gate bounds the *parser* (child killed after a fixed budget),
 * but the browser import path (`src/features/importer.ts`) used to race the
 * web-ifc conversion only against user cancel: a conversion that made no
 * progress — or that ran far longer than any legitimate file should — left
 * the import queue wedged on "converting…" forever, with no failure, no
 * recovery, and no way for the next queued file to proceed.
 *
 * This module is the pure, DOM-free half of the fix: the bounds and the
 * watchdog. The importer wires it to the existing cancel machinery (the
 * watchdog rejects through the same `rejectActive` the Cancel button uses,
 * then disposes the importer so the next import starts from a fresh
 * instance) and classifies the result as a *failure*, never as a user
 * cancellation.
 *
 * Two bounds, both grounded in measured conversion times on this VM
 * (bench/results/browser-after.json: 0.1 MB → 0.8 s, 0.4 MB → 1.2 s,
 * 2.3 MB / 2,036 elements → 2.5 s, i.e. roughly 1 s per MB):
 *
 * - Stall bound: no `progressCallback` invocation for `stallMs`
 *   (default 120 s). Conversion streams chunks continuously, so two
 *   silent minutes means the conversion is stuck, not slow.
 * - Total bound: the whole conversion may not exceed
 *   `min(totalCapMs, max(totalFloorMs, totalPerMbMs * sizeMB))`
 *   (defaults: 5 min floor, 30 s per MB, 30 min ceiling). A 2.3 MB file
 *   gets 5 min (120x its measured 2.5 s); a 350 MB file — the largest the
 *   browser will attempt — gets 30 min (at the measured rate it needs ~6).
 *
 * Honest limit, stated in the importer too: web-ifc runs single-threaded
 * in this app (see `getImporter()` — `forceSingleThread=true`), so a
 * *synchronous* hang inside one WASM call (the `OpenModel` hangs behind
 * #231) cannot be interrupted from the page — no timer can fire while the
 * main thread is inside WASM. That class is stopped *before* WASM by the
 * structural pre-flight (`step-preflight.ts`) and bounded by the Node fuzz
 * gate. This timeout bounds everything the page can observe: conversions
 * that yield to the event loop but stall or run past any legitimate time.
 * When it fires, the queue is freed, the task fails with the bound that
 * fired and how to raise it, and the next file proceeds.
 */
export const IFC_IMPORT_STALL_MS_DEFAULT = 120_000;
export const IFC_IMPORT_TOTAL_FLOOR_MS_DEFAULT = 300_000;
export const IFC_IMPORT_TOTAL_PER_MB_MS_DEFAULT = 30_000;
export const IFC_IMPORT_TOTAL_CAP_MS_DEFAULT = 1_800_000;
/** Below this a stall bound is a misconfiguration, not a bound. */
export const IFC_IMPORT_STALL_MS_MIN = 10_000;
/** Below this a total override is a misconfiguration, not a bound. */
export const IFC_IMPORT_TOTAL_MS_MIN = 1_000;

export type ImportTimeoutKind = "stall" | "total";

export interface ImportTimeoutBounds {
  /** No progress for this long → stall timeout. 0 disables the stall bound. */
  stallMs: number;
  /** Whole conversion may not exceed this. */
  totalMs: number;
}

export interface ImportTimeoutOptions {
  /** Stall bound override in ms. Undefined → default; 0 → disabled. */
  stallMs?: number;
  /**
   * Total bound override in ms. Undefined or 0 → auto-scaled from the file
   * size (floor + per-MB, capped). Values below the minimum are clamped up.
   */
  totalMs?: number;
}

/**
 * Pure bound computation. Invalid inputs fall back to the defaults; a stall
 * bound below the minimum is clamped up to it (a 1 s stall bound would fail
 * every real import on a slow machine).
 */
export function computeImportTimeoutMs(
  sizeMB: number,
  opts: ImportTimeoutOptions = {},
): ImportTimeoutBounds {
  const size = Number.isFinite(sizeMB) && sizeMB > 0 ? sizeMB : 0;
  let stallMs = opts.stallMs === undefined ? IFC_IMPORT_STALL_MS_DEFAULT : opts.stallMs;
  if (!Number.isFinite(stallMs) || stallMs < 0) stallMs = IFC_IMPORT_STALL_MS_DEFAULT;
  if (stallMs > 0 && stallMs < IFC_IMPORT_STALL_MS_MIN) stallMs = IFC_IMPORT_STALL_MS_MIN;
  let totalMs: number;
  if (opts.totalMs !== undefined && opts.totalMs > 0) {
    totalMs = Number.isFinite(opts.totalMs) ? opts.totalMs : IFC_IMPORT_TOTAL_FLOOR_MS_DEFAULT;
    if (totalMs < IFC_IMPORT_TOTAL_MS_MIN) totalMs = IFC_IMPORT_TOTAL_MS_MIN;
  } else {
    totalMs = Math.min(
      IFC_IMPORT_TOTAL_CAP_MS_DEFAULT,
      Math.max(IFC_IMPORT_TOTAL_FLOOR_MS_DEFAULT, IFC_IMPORT_TOTAL_PER_MB_MS_DEFAULT * size),
    );
  }
  return { stallMs, totalMs };
}

/**
 * Error thrown when an import conversion exceeds a bound. The message
 * deliberately contains neither "cancel" nor "cancelled": the importer's
 * catch classifies any message containing "cancel" as a user cancellation,
 * and a timeout is a failure, not a cancellation.
 */
export class IfcImportTimeoutError extends Error {
  readonly kind: ImportTimeoutKind;
  readonly fileName: string;
  readonly limitMs: number;
  readonly elapsedMs: number;

  constructor(kind: ImportTimeoutKind, fileName: string, limitMs: number, elapsedMs: number) {
    const limit = kind === "stall"
      ? `made no progress for ${(limitMs / 1000).toFixed(0)} s (stall limit)`
      : `ran for ${(elapsedMs / 1000).toFixed(0)} s, past the ${(limitMs / 1000).toFixed(0)} s total limit`;
    super(
      `IFC conversion timed out: ${fileName} ${limit}. ` +
        `The file was not imported. If the model is legitimate and this machine is slow, ` +
        `raise the import timeout in the Importer settings and retry; for very large files, ` +
        `convert to .frag offline and use Link FRAG instead.`,
    );
    this.name = "IfcImportTimeoutError";
    this.kind = kind;
    this.fileName = fileName;
    this.limitMs = limitMs;
    this.elapsedMs = elapsedMs;
  }
}

export interface ImportTimeoutCallbacks {
  onTimeout: (error: IfcImportTimeoutError) => void;
}

/**
 * Watchdog for one conversion. `start()` arms the total timer and the
 * stall timer; call `poke()` on every progress callback to re-arm the
 * stall timer; `clear()` disarms both. `onTimeout` fires at most once,
 * with the kind that fired first. Timers are real `setTimeout`s so the
 * behaviour under test is the behaviour in production.
 */
export class ImportTimeout {
  private readonly bounds: ImportTimeoutBounds;
  private readonly fileName: string;
  private readonly onTimeout: (error: IfcImportTimeoutError) => void;
  private readonly now: () => number;
  private startMs = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;
  private cleared = false;

  constructor(
    fileName: string,
    bounds: ImportTimeoutBounds,
    callbacks: ImportTimeoutCallbacks,
    now: () => number = () => Date.now(),
  ) {
    this.fileName = fileName;
    this.bounds = bounds;
    this.onTimeout = callbacks.onTimeout;
    this.now = now;
  }

  get timedOut(): boolean {
    return this.fired;
  }

  start(): void {
    this.startMs = this.now();
    this.fired = false;
    this.cleared = false;
    this.clearTimers();
    if (this.bounds.totalMs > 0) {
      this.totalTimer = setTimeout(() => this.fire("total"), this.bounds.totalMs);
    }
    this.armStall();
  }

  /** A progress callback arrived: the conversion is alive; re-arm the stall timer. */
  poke(): void {
    if (this.fired || this.cleared) return;
    this.armStall();
  }

  clear(): void {
    this.cleared = true;
    this.clearTimers();
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (this.bounds.stallMs > 0) {
      this.stallTimer = setTimeout(() => this.fire("stall"), this.bounds.stallMs);
    }
  }

  private clearTimers(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.stallTimer = null;
    this.totalTimer = null;
  }

  private fire(kind: ImportTimeoutKind): void {
    if (this.fired || this.cleared) return;
    this.fired = true;
    this.clearTimers();
    const elapsedMs = this.now() - this.startMs;
    const limitMs = kind === "stall" ? this.bounds.stallMs : this.bounds.totalMs;
    this.onTimeout(new IfcImportTimeoutError(kind, this.fileName, limitMs, elapsedMs));
  }
}
