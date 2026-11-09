// solver-mode: button-driven (no pointerup / no auto-rebuild race with placement)
// openingsForWall() in authoring.ts already re-clamps hosted offsets at READ time on
// the single rebuild the placement/move commit performs, so the solver must NOT also
// solve on pointerup. The [S] button calls solveHostedConstraints() deliberately.
//
// Since the solver-bridge landed, this button is the parametric engine's trigger:
// it enforces EVERY stored constraint (locked dimensions, equality, alignment,
// parallel, perpendicular) through the numeric L-M solver, then re-clamps hosted
// opening offsets. Previously it only clamped openings and stored constraints
// were dead metadata.
import { ctx } from "../core/context";
import { getAllConstraints } from "../modules/parametric-constraints/types";
import { solveStoredConstraints } from "../modules/parametric-constraints/solver-bridge";
import { createAutoSolveEngine, type AutoSolveEngine } from "../modules/parametric-constraints/auto-solve";

type Any = Record<string, any>;

let solving = false;

function getFeatures(): Any {
  const c = ctx as Any;
  if (!c.features) c.features = {};
  return c.features as Any;
}

function getAuthoring(): Any | null {
  const f = getFeatures();
  return (f.authoring as Any) ?? null;
}

function getElements(): Any[] {
  const a = getAuthoring();
  if (!a) return [];
  if (typeof a.getElements === "function") {
    try { return a.getElements() ?? []; } catch { return []; }
  }
  if (Array.isArray(a.elements)) return a.elements;
  return [];
}

function rebuildAuthoring(): void {
  const a = getAuthoring();
  if (!a) return;
  try {
    if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
    else if (typeof a.rebuild === "function") a.rebuild();
  } catch { /* ignore */ }
  try {
    if (typeof a.markAuthoringDirty === "function") a.markAuthoringDirty();
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent("obs:authoring-changed", { detail: { reason: "constraint-solver" } }));
  } catch { /* ignore */ }
}

function pair(v: Any): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
  if (v && typeof v === "object") {
    if ("x" in v && "z" in v) return [Number(v.x), Number(v.z)];
    if ("x" in v && "y" in v) return [Number(v.x), Number(v.y)];
  }
  return null;
}

/** Clamp hosted openings back onto their host span (read-time invariant). */
function clampHostedOpenings(elements: Any[]): number {
  let changed = 0;

  const hosts = new Map<string, Any>();
  for (const el of elements) {
    if (!el || !el.id || !el.params) continue;
    const t = String(el.type ?? "");
    if ((t === "wall" || t === "beam" || t === "line" || t === "mline") && el.params.start && el.params.end) {
      hosts.set(String(el.id), el);
    }
  }

  for (const el of elements) {
    if (!el || !el.hostId || !el.params) continue;
    const t = String(el.type ?? "");
    if (t !== "door" && t !== "window" && t !== "opening" && t !== "fitting") continue;

    const host = hosts.get(String(el.hostId));
    if (!host || !host.params) continue;

    const p = el.params as Any;
    const hp = host.params as Any;
    const start = pair(hp.start);
    const end = pair(hp.end);
    if (!start || !end) continue;

    const ax = start[0], az = start[1], bx = end[0], bz = end[1];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (!Number.isFinite(L) || L < 0.01) continue;

    const half = Number(p.width ?? p.WIDTH ?? 0.9) / 2;
    const current = Number(p.offsetAlongHost ?? p.offset ?? L / 2);
    const min = Math.min(half, L / 2);
    const max = Math.max(L - half, L / 2);
    const clamped = Math.max(min, Math.min(max, current));

    if (typeof p.offsetAlongHost !== "number" || Math.abs(clamped - current) > 1e-4) {
      p.offsetAlongHost = Math.round(clamped * 1000) / 1000;
      changed++;
    }
  }
  return changed;
}

/**
 * Full parametric solve pass:
 *   1. stored constraints (locked dims / equality / alignment / parallel /
 *      perpendicular) via the numeric L-M solver, with wall auto-join and
 *      per-wall length pinning;
 *   2. hosted opening re-clamp onto the (possibly moved) hosts.
 * Returns the number of elements changed. Safe to call re-entrantly.
 */
export function solveHostedConstraints(): number {
  if (solving) return 0;
  solving = true;
  try {
    const elements = getElements();
    if (!elements.length) return 0;

    let changed = 0;

    // 1. Stored parametric constraints — the previously-dead metadata.
    let stored: { changed: number; errors: string[] } | null = null;
    try {
      stored = solveStoredConstraints(elements as Any[], getAllConstraints());
      changed += stored.changed;
      if (stored.errors?.length) {
        console.warn("[constraint-solver] stored-constraint issues:", stored.errors.slice(0, 5));
      }
    } catch (err) {
      console.warn("[constraint-solver] stored solve skipped:", err instanceof Error ? err.message : err);
    }

    // 2. Opening clamp on the (possibly moved) hosts.
    changed += clampHostedOpenings(elements);

    if (changed) rebuildAuthoring();
    return changed;
  } finally {
    solving = false;
  }
}

export function setupConstraintSolver(): void {
  const f = getFeatures();
  f.constraintSolver = { solve: solveHostedConstraints, solveAll: solveHostedConstraints };
  // NOTE: no new cross-feature globals here — the ui-honesty budget forbids
  // growth. The pre-existing window alias now runs the FULL pipeline (stored
  // constraints + openings), and ribbon/command callers can reach solveAll
  // via ctx.features.constraintSolver.
  (window as Any).__obsSolveHostedConstraints = solveHostedConstraints;
  setupAutoSolve(f);
  console.log(
    "[constraint-solver] ready — stored constraints solved via L-M bridge, openings re-clamped (button-driven + auto-solve after move commits)",
  );
}

// ─── Live drag-solve (Revit parity: constraints re-enforce after a move) ──

const AUTO_SOLVE_KEY = "obs-constraint-autosolve";
let autoEngine: AutoSolveEngine | null = null;

function persistedAutoSolve(): boolean {
  try { return localStorage.getItem(AUTO_SOLVE_KEY) !== "off"; } catch { return true; }
}

/** Bind the pure auto-solve engine to solveHostedConstraints (called once). */
export function setupAutoSolve(features: Any): void {
  if (autoEngine) return;
  autoEngine = createAutoSolveEngine(() => { solveHostedConstraints(); });
  autoEngine.setEnabled(persistedAutoSolve());
  features.constraintSolver.auto = autoEngine;
  features.constraintSolver.setAutoSolve = setConstraintAutoSolve;
  features.constraintSolver.isAutoSolveEnabled = isConstraintAutoSolveEnabled;
}

/** Enable/disable the post-commit auto-solve (persisted). */
export function setConstraintAutoSolve(on: boolean): void {
  if (!autoEngine) setupAutoSolve(getFeatures());
  autoEngine!.setEnabled(on);
  try { localStorage.setItem(AUTO_SOLVE_KEY, on ? "on" : "off"); } catch { /* private mode */ }
}

export function isConstraintAutoSolveEnabled(): boolean {
  return autoEngine ? autoEngine.isEnabled() : persistedAutoSolve();
}

/**
 * Queue the debounced solve after a geometry commit (move/drag/parametric
 * edit). Called from authoring.ts transformElements — the one commit point
 * every pointer-drag and property edit funnels through.
 */
export function scheduleAutoSolve(): void {
  if (!autoEngine) return; // boot order: features first, engine binds on setup
  autoEngine.schedule();
}
