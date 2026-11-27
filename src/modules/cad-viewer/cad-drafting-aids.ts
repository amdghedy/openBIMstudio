/**
 * Shared drafting-aid state (2D-2 — A12 follow-up: main-shell status-bar
 * toggles).
 *
 * The CAD viewer's drafting aids (GRID, SNAP, OSNAP, ORTHO, POLAR,
 * OTRACK, DYN, LWT, DUCS) used to live only as `let` bindings inside the
 * per-tab engine closure in cad-viewer.ts, so the main-shell status bar
 * (`src/shell/status-bar.ts`) had no way to read or switch them — it
 * showed no toggles at all. This module is the single source of truth:
 * the viewer publishes its live flags here (from `updateStatus()`, which
 * every toggle path calls) and applies remote changes here, and the
 * shell status bar toggles the same flags through this module.
 *
 * Two deliberate boundaries:
 * - UCS and QUICK stay viewer-local. UCS carries a view-rotation side
 *   effect (`setUcs`) and QUICK is a measure mode with its own readout,
 *   not an on/off drafting aid.
 * - The state is shared across drawing tabs, like AutoCAD's application
 *   system variables. A saved drawing session restored into a tab still
 *   wins for that tab (the restore runs after engine init and publishes
 *   the restored values back here), so per-tab restore behaviour is
 *   unchanged; the shared state only carries the live value between
 *   sessions and across the shell/viewer boundary.
 *
 * Persistence: the state is kept in localStorage
 * (`obs.cad-drafting-aids.v1`) so a shell-bar toggle survives a reload
 * when no drawing session is restored. The stored value is validated
 * on load — unknown keys and non-boolean values are dropped, never
 * applied. All storage access is guarded: in node (tests) there is no
 * `window`/`localStorage` and the module works purely in memory.
 *
 * Notification: every real change dispatches the `obs:cad-drafting-aids`
 * window event (detail `{ changed, state }`) and calls the in-process
 * subscribers. `applyDraftingAids` diffs first and notifies at most
 * once per call, so the viewer publishing its own state can never
 * echo-loop with its own subscriber.
 *
 * Pure functions + a small guarded store; no DOM, no viewer state —
 * node-testable.
 */

export type DraftingAidKey =
  | "grid"
  | "snap"
  | "osnap"
  | "ortho"
  | "polar"
  | "otrack"
  | "dyn"
  | "lwt"
  | "ducs";

export const DRAFTING_AID_KEYS: readonly DraftingAidKey[] = [
  "grid",
  "snap",
  "osnap",
  "ortho",
  "polar",
  "otrack",
  "dyn",
  "lwt",
  "ducs",
];

/**
 * The viewer defaults, as declared in cad-viewer.ts (`buildEngine`):
 * OSNAP on, grid on, polar tracking on, OTRACK on, dynamic input on,
 * lineweight display on, dynamic UCS on; grid snap and ortho off.
 */
export const DRAFTING_AID_DEFAULTS: Readonly<Record<DraftingAidKey, boolean>> = {
  grid: true,
  snap: false,
  osnap: true,
  ortho: false,
  polar: true,
  otrack: true,
  dyn: true,
  lwt: true,
  // DUCS (Dynamic UCS) defaults ON, as in AutoCAD. In this 2D viewer
  // DUCS is the switch itself — persisted, shown in both status bars,
  // togglable from the command line (DUCS) and F6. The 3D face alignment
  // it gates in AutoCAD has no 3D surface to act on here, so no geometry
  // path reads the flag yet; the UCS-origin completion it would gate is
  // not implemented either (the UCS prompt has no pick handler).
  ducs: true,
};

export const DRAFTING_AIDS_EVENT = "obs:cad-drafting-aids";

const STORAGE_KEY = "obs.cad-drafting-aids.v1";

export type DraftingAidsState = Record<DraftingAidKey, boolean>;

export function isDraftingAidKey(value: unknown): value is DraftingAidKey {
  return (
    typeof value === "string" &&
    (DRAFTING_AID_KEYS as readonly string[]).includes(value)
  );
}

/** Validate a stored/foreign value: known keys with boolean values only. */
export function sanitizeDraftingAids(
  value: unknown,
): Partial<DraftingAidsState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<DraftingAidsState> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isDraftingAidKey(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

function loadStored(): Partial<DraftingAidsState> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeDraftingAids(JSON.parse(raw));
  } catch {
    return {};
  }
}

function saveStored(state: DraftingAidsState): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* persistence is a convenience; a full/blocked store never breaks toggling */
  }
}

let state: DraftingAidsState = {
  ...DRAFTING_AID_DEFAULTS,
  ...loadStored(),
};

const subscribers = new Set<(state: DraftingAidsState) => void>();

function notify(changed: DraftingAidKey[]): void {
  const snapshot = { ...state };
  for (const cb of [...subscribers]) {
    try {
      cb(snapshot);
    } catch {
      /* one bad subscriber never breaks the others */
    }
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(DRAFTING_AIDS_EVENT, {
          detail: { changed: [...changed], state: snapshot },
        }),
      );
    }
  } catch {
    /* event delivery is a convenience; the subscriber path already ran */
  }
}

/** A copy of the current state. Callers must not mutate the result. */
export function getDraftingAids(): DraftingAidsState {
  return { ...state };
}

export function getDraftingAid(key: DraftingAidKey): boolean {
  return state[key];
}

/**
 * Set one aid. Unknown keys are a no-op returning `false` (fail-closed);
 * known keys return `true`. Notifies only when the value actually changes.
 */
export function setDraftingAid(key: unknown, on: boolean): boolean {
  if (!isDraftingAidKey(key)) return false;
  applyDraftingAids({ [key]: on } as Partial<DraftingAidsState>);
  return true;
}

/** Toggle one aid; returns the new value (`false` for an unknown key). */
export function toggleDraftingAid(key: unknown): boolean {
  if (!isDraftingAidKey(key)) return false;
  const next = !state[key];
  applyDraftingAids({ [key]: next } as Partial<DraftingAidsState>);
  return next;
}

/**
 * Apply several aids at once. Unknown keys and non-boolean values are
 * dropped; returns the keys whose value actually changed, and notifies
 * at most once (only when at least one key changed).
 */
export function applyDraftingAids(
  partial: Partial<DraftingAidsState> | unknown,
): DraftingAidKey[] {
  const clean = sanitizeDraftingAids(partial);
  const changed: DraftingAidKey[] = [];
  for (const k of DRAFTING_AID_KEYS) {
    if (clean[k] !== undefined && clean[k] !== state[k]) {
      state[k] = clean[k] as boolean;
      changed.push(k);
    }
  }
  if (changed.length) {
    saveStored(state);
    notify(changed);
  }
  return changed;
}

/** Restore the viewer defaults (and persist them). */
export function resetDraftingAids(): void {
  applyDraftingAids({ ...DRAFTING_AID_DEFAULTS });
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribeDraftingAids(
  cb: (state: DraftingAidsState) => void,
): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
