/**
 * Parametric constraints — model store + wall/plan integration.
 *
 * Bridges the numeric solver (solver.ts) to the authoring model:
 *   - Walls become constrained point pairs (start/end in plan x/z → solver x/y).
 *   - Endpoints that coincide in the current model (within tolerance) are
 *     auto-joined with `coincident` constraints, so a chain of walls behaves
 *     like Revit's sketch: drag one end and the neighbours follow.
 *   - Locked dimensions from the parametric-constraints store and explicit
 *     relations from the user become solver constraints.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

import { solve, type Constraint, type SolverPoint, type SolveResult } from "./solver";

export { solve, equationsFor, countEquations } from "./solver";
export type { Constraint, ConstraintKind, SolverPoint, SolveResult } from "./solver";

/** Minimal wall shape the studio authoring model uses (params.start/params.end). */
export interface WallLike {
  id: string;
  type: string;
  params: {
    start?: { x: number; z: number } | [number, number];
    end?: { x: number; z: number } | [number, number];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface WallSolveOptions {
  /** Join distance below which two endpoints are considered one node. */
  joinTolerance?: number;
  /** Keep each wall's locked/declared length (distance constraint). */
  keepLengths?: boolean;
  /** Extra constraints (indices refer to the built point list). */
  extra?: Constraint[];
}

export interface WallSolveOutcome {
  result: SolveResult;
  /** Per-wall updated start/end, aligned with the walls passed in. */
  updated: { id: string; start: { x: number; z: number }; end: { x: number; z: number } }[];
}

function readPt(p: WallLike["params"]["start"]): { x: number; z: number } {
  if (Array.isArray(p)) return { x: Number(p[0]), z: Number(p[1]) };
  return { x: Number(p?.x ?? 0), z: Number(p?.z ?? 0) };
}

/**
 * Build a solver system from walls and solve.
 *
 * Point layout: wall i owns points 2i (start) and 2i+1 (end).
 * Auto-joins: any two endpoints within `joinTolerance` get a coincident
 * constraint (the later wall's point is the follower).
 */
export function solveWalls(
  walls: WallLike[],
  opts: WallSolveOptions = {},
): WallSolveOutcome {
  const joinTol = opts.joinTolerance ?? 1e-6;
  const keepLengths = opts.keepLengths ?? true;

  const pts: SolverPoint[] = [];
  const cons: Constraint[] = [];
  const ends: { x: number; z: number }[] = [];

  for (const w of walls) {
    const s = readPt(w.params.start);
    const e = readPt(w.params.end);
    pts.push({ x: s.x, y: s.z }, { x: e.x, y: e.z });
    ends.push(s, e);
    if (keepLengths) {
      const L = Math.hypot(e.x - s.x, e.z - s.z);
      if (L > 1e-6) cons.push({ kind: "distance", pts: [pts.length - 2, pts.length - 1], value: L });
    }
  }

  // Auto-join coincident endpoints between different walls (plan graph).
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (Math.hypot(ends[i].x - ends[j].x, ends[i].z - ends[j].z) <= joinTol) {
        cons.push({ kind: "coincident", pts: [j, i] }); // j follows i
      }
    }
  }
  if (opts.extra) cons.push(...opts.extra);

  const result = solve(pts, cons);

  const updated = walls.map((w, i) => ({
    id: w.id,
    start: { x: pts[2 * i].x, z: pts[2 * i].y },
    end: { x: pts[2 * i + 1].x, z: pts[2 * i + 1].y },
  }));
  return { result, updated };
}

/**
 * Apply a solved outcome back onto wall params, rounding to mm and skipping
 * no-op updates. Returns the number of walls changed.
 */
export function applyWallOutcome(
  walls: WallLike[],
  outcome: WallSolveOutcome,
): number {
  const byId = new Map(outcome.updated.map((u) => [u.id, u]));
  let changed = 0;
  for (const w of walls) {
    const u = byId.get(w.id);
    if (!u) continue;
    const s = readPt(w.params.start);
    const e = readPt(w.params.end);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    if (
      Math.abs(r3(s.x) - r3(u.start.x)) > 1e-4 || Math.abs(r3(s.z) - r3(u.start.z)) > 1e-4 ||
      Math.abs(r3(e.x) - r3(u.end.x)) > 1e-4 || Math.abs(r3(e.z) - r3(u.end.z)) > 1e-4
    ) {
      w.params.start = { x: r3(u.start.x), z: r3(u.start.z) };
      w.params.end = { x: r3(u.end.x), z: r3(u.end.z) };
      changed++;
    }
  }
  return changed;
}

/**
 * Convenience: solve and mutate walls in one call.
 * `pinnedIds` stay fixed (e.g. the wall the user is NOT dragging).
 */
export function solveAndApply(
  walls: WallLike[],
  pinnedIds: string[] = [],
  opts: WallSolveOptions = {},
): { changed: number; result: SolveResult } {
  const pinned = new Set(pinnedIds);
  for (const w of walls) {
    if (pinned.has(w.id)) {
      // Fix both endpoints by marking in opts via extra fixed constraints —
      // simplest is to rebuild points here, but solver honors `fixed` on
      // SolverPoint; solveWalls doesn't expose it, so emulate by pinning
      // through distance-to-self constraints is wrong. Instead re-run inline.
    }
  }
  // Inline solve with pinning support (duplicate of solveWalls core):
  const joinTol = opts.joinTolerance ?? 1e-6;
  const keepLengths = opts.keepLengths ?? true;
  const pts: SolverPoint[] = [];
  const cons: Constraint[] = [];
  const ends: { x: number; z: number }[] = [];
  for (const w of walls) {
    const s = readPt(w.params.start);
    const e = readPt(w.params.end);
    const isPinned = pinned.has(w.id);
    pts.push(
      { x: s.x, y: s.z, fixed: isPinned },
      { x: e.x, y: e.z, fixed: isPinned },
    );
    ends.push(s, e);
    if (keepLengths) {
      const L = Math.hypot(e.x - s.x, e.z - s.z);
      if (L > 1e-6) cons.push({ kind: "distance", pts: [pts.length - 2, pts.length - 1], value: L });
    }
  }
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (Math.hypot(ends[i].x - ends[j].x, ends[i].z - ends[j].z) <= joinTol) {
        // A coincident constraint must never fight a fixed point: follower is j.
        cons.push({ kind: "coincident", pts: [j, i] });
      }
    }
  }
  if (opts.extra) cons.push(...opts.extra);
  const result = solve(pts, cons);
  const outcome: WallSolveOutcome = {
    result,
    updated: walls.map((w, i) => ({
      id: w.id,
      start: { x: pts[2 * i].x, z: pts[2 * i].y },
      end: { x: pts[2 * i + 1].x, z: pts[2 * i + 1].y },
    })),
  };
  return { changed: applyWallOutcome(walls, outcome), result };
}
