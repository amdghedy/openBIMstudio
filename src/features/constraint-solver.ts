// solver-mode: button-driven (no pointerup / no auto-rebuild race with placement)
// openingsForWall() in authoring.ts already re-clamps hosted offsets at READ time on
// the single rebuild the placement/move commit performs, so the solver must NOT also
// solve on pointerup. The [S] button calls solveHostedConstraints() deliberately.
import { ctx } from "../core/context";

type Any = Record<string, any>;

let solving = false;

function getFeatures(): Any {
  const c = ctx as Any;
  if (!c.features) c.features = {};
  return c.features as Any;
}

function getAuthoring(): Any | null {
  const f = getFeatures();
  return (f.authoring as Any) ?? (window as Any).__obsAuthoring ?? null;
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

export function solveHostedConstraints(): number {
  if (solving) return 0;
  solving = true;
  try {
    const elements = getElements();
    if (!elements.length) return 0;

    const hosts = new Map<string, Any>();
    for (const el of elements) {
      if (!el || !el.id || !el.params) continue;
      const t = String(el.type ?? "");
      if ((t === "wall" || t === "beam" || t === "line" || t === "mline") && el.params.start && el.params.end) {
        hosts.set(String(el.id), el);
      }
    }

    let changed = 0;
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

    if (changed) rebuildAuthoring();
    return changed;
  } finally {
    solving = false;
  }
}

export function setupConstraintSolver(): void {
  const f = getFeatures();
  f.constraintSolver = { solve: solveHostedConstraints };
  (window as Any).__obsSolveHostedConstraints = solveHostedConstraints;
  console.log("[constraint-solver] button-driven ready (no pointerup auto-solve; openingsForWall clamps at read)");
}
