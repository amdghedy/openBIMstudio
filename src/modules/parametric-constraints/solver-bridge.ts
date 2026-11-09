/**
 * Constraint-store → numeric-solver bridge.
 *
 * Closes the parametric dead end: `types.ts` stores locked-dimension /
 * equality / alignment / parallel / perpendicular constraints, and
 * `../constraints/solver.ts` is a full Levenberg-Marquardt geometric
 * solver — but until this module nothing converted the stored metadata
 * into solver equations, so locked dimensions silently did nothing.
 *
 * Mapping (element reference geometry → solver points):
 *   - segment elements (wall/beam/line/mline with params.start/params.end)
 *     own two solver points (start, end) — same 2i / 2i+1 layout
 *     `solveAndApply` uses for all-segment systems;
 *   - point elements (params.point / params.position) own one point.
 *
 * Stored-constraint mapping:
 *   locked-dimension  segment↔segment  → distance between the nearest
 *                                        endpoint pair (stable choice);
 *                     segment↔point    → distance point↔nearest endpoint;
 *                     point↔point      → distance between the centres.
 *   equality          consecutive segment pairs → equal-length;
 *                     point chains sorted by position → equal gaps.
 *   alignment         point onto segment → point-on-line;
 *                     point↔point → coincident;
 *                     segment↔segment → collinear (point-on-line + parallel).
 *   parallel          segments → parallel.
 *   perpendicular     segments → perpendicular.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

import {
  solve,
  type Constraint,
  type SolverPoint,
  type SolveResult,
} from "../constraints/solver";
import type { ParametricConstraint } from "./types";

/** Minimal authoring-element shape the bridge reads/writes. */
export interface ElementLike {
  id?: string;
  type?: string;
  params?: Record<string, any>;
  [k: string]: unknown;
}

export interface SolveStoredOptions {
  /** Endpoint coincidence tolerance for auto-join (metres). */
  joinTolerance?: number;
  /** Pin each segment's current length while enforcing stored constraints. */
  keepLengths?: boolean;
  /** Element ids whose geometry never moves (the anchor side of a lock). */
  pinnedIds?: string[];
}

export interface SolveStoredOutcome {
  /** Elements whose params actually changed. */
  changed: number;
  result: SolveResult | null;
  /** Human-readable problems (unknown ids, degenerate geometry, …). */
  errors: string[];
}

interface Vec {
  x: number;
  z: number;
}

function readVec(p: unknown): Vec | null {
  if (Array.isArray(p) && p.length >= 2) {
    const x = Number(p[0]);
    const z = Number(p[1]);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }
  if (p && typeof p === "object") {
    const v = p as Record<string, unknown>;
    const x = Number(v.x);
    const z = Number(v.z);
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }
  return null;
}

function isSegment(el: ElementLike): boolean {
  return !!(el?.params && readVec(el.params.start) && readVec(el.params.end));
}

function pointOf(el: ElementLike): Vec | null {
  if (!el?.params) return null;
  return readVec(el.params.point) ?? readVec(el.params.position);
}

/** Shape a point is written back in: preserve the original array/object form. */
function writeShape(el: ElementLike, key: string): "array" | "object" {
  const v = el?.params?.[key];
  return Array.isArray(v) ? "array" : "object";
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** System of solver points built from authoring elements. */
export interface BuiltSystem {
  pts: SolverPoint[];
  /** element id → solver point indices (2 for segments, 1 for points). */
  indexOf: Map<string, number[]>;
  segmentIds: Set<string>;
  pointIds: Set<string>;
}

/**
 * Build the solver point list for a set of elements.
 *
 * Layout invariant: for an all-segment element list, element i owns points
 * 2i (start) and 2i+1 (end) — identical to `solveAndApply` in
 * ../constraints/index.ts, so the two call sites can share constraint
 * index space.
 */
export function buildSystem(elements: ElementLike[]): BuiltSystem {
  const pts: SolverPoint[] = [];
  const indexOf = new Map<string, number[]>();
  const segmentIds = new Set<string>();
  const pointIds = new Set<string>();

  for (const el of elements) {
    if (!el?.id) continue;
    if (isSegment(el)) {
      const s = readVec(el.params!.start)!;
      const e = readVec(el.params!.end)!;
      indexOf.set(el.id, [pts.length, pts.length + 1]);
      pts.push({ x: s.x, y: s.z }, { x: e.x, y: e.z });
      segmentIds.add(el.id);
    } else {
      const p = pointOf(el);
      if (!p) continue;
      indexOf.set(el.id, [pts.length]);
      pts.push({ x: p.x, y: p.z });
      pointIds.add(el.id);
    }
  }
  return { pts, indexOf, segmentIds, pointIds };
}

/** Nearest endpoint pair between two segments (indices into sys.pts). */
function nearestEndpointPair(
  sys: BuiltSystem,
  aId: string,
  bId: string,
): [number, number] | null {
  const ai = sys.indexOf.get(aId);
  const bi = sys.indexOf.get(bId);
  if (!ai || !bi || ai.length !== 2 || bi.length !== 2) return null;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const i of ai) {
    for (const j of bi) {
      const d = Math.hypot(sys.pts[i].x - sys.pts[j].x, sys.pts[i].y - sys.pts[j].y);
      if (d < bestD) {
        bestD = d;
        best = [i, j];
      }
    }
  }
  return best;
}

/** Convert stored constraints into solver constraints for a built system. */
export function storedToSolverConstraints(
  stored: ParametricConstraint[],
  sys: BuiltSystem,
): {
  cons: Constraint[];
  errors: string[];
  /** segment↔point alignment pairs — the caller post-projects the point
   *  onto the segment so it keeps its parametric position along the host
   *  instead of drifting in the flat tangential direction. */
  alignmentPairs: Array<{ ptIdx: number; segIdx: [number, number] }>;
} {
  const cons: Constraint[] = [];
  const errors: string[] = [];
  const alignmentPairs: Array<{ ptIdx: number; segIdx: [number, number] }> = [];
  const idx = (id: string): number[] | null => sys.indexOf.get(id) ?? null;

  for (const c of stored) {
    if (!c?.active) continue;
    const ids = c.elementIds ?? [];
    if (ids.length < 2 && c.type !== "equality") {
      errors.push(`${c.type} ${c.id}: needs two elements`);
      continue;
    }

    switch (c.type) {
      case "locked-dimension": {
        const value = Number(c.value);
        if (!Number.isFinite(value) || value <= 0) {
          errors.push(`${c.id}: locked value must be positive, got ${c.value}`);
          break;
        }
        const [aId, bId] = ids;
        const aSeg = sys.segmentIds.has(aId);
        const bSeg = sys.segmentIds.has(bId);
        const aIdx = idx(aId);
        const bIdx = idx(bId);
        if (!aIdx || !bIdx) {
          errors.push(`${c.id}: unknown element '${!aIdx ? aId : bId}'`);
          break;
        }
        if (aSeg && bSeg) {
          const pair = nearestEndpointPair(sys, aId, bId);
          if (!pair) {
            errors.push(`${c.id}: degenerate segment pair`);
            break;
          }
          cons.push({ kind: "distance", pts: pair, value });
        } else if (!aSeg && !bSeg) {
          cons.push({ kind: "distance", pts: [aIdx[0], bIdx[0]], value });
        } else {
          // One segment, one point: pin the point to the nearest segment
          // endpoint at the locked distance.
          const segIdx = aSeg ? aIdx : bIdx;
          const ptIdx = aSeg ? bIdx[0] : aIdx[0];
          let best = segIdx[0];
          let bestD = Infinity;
          for (const i of segIdx) {
            const d = Math.hypot(sys.pts[i].x - sys.pts[ptIdx].x, sys.pts[i].y - sys.pts[ptIdx].y);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          cons.push({ kind: "distance", pts: [ptIdx, best], value });
        }
        break;
      }

      case "equality": {
        // Consecutive equal-length / equal-gap chain over the listed ids.
        const ordered: { id: string; idx: number[]; seg: boolean }[] = [];
        for (const id of ids) {
          const i = idx(id);
          if (!i) {
            errors.push(`${c.id}: unknown element '${id}'`);
            continue;
          }
          ordered.push({ id, idx: i, seg: sys.segmentIds.has(id) });
        }
        if (ordered.length < 2) break;
        if (ordered.every((o) => o.seg)) {
          for (let i = 0; i + 1 < ordered.length; i++) {
            cons.push({
              kind: "equal-length",
              pts: [
                ordered[i].idx[0], ordered[i].idx[1],
                ordered[i + 1].idx[0], ordered[i + 1].idx[1],
              ],
            });
          }
        } else if (ordered.every((o) => !o.seg && o.idx.length === 1)) {
          // Sort point centres along their dominant spread axis, then lock
          // consecutive gaps to the first gap's current length.
          const xs = ordered.map((o) => sys.pts[o.idx[0]].x);
          const zs = ordered.map((o) => sys.pts[o.idx[0]].y);
          const spreadX = Math.max(...xs) - Math.min(...xs);
          const spreadZ = Math.max(...zs) - Math.min(...zs);
          const axisX = spreadX >= spreadZ;
          const sorted = [...ordered].sort((p, q) => {
            const pv = sys.pts[p.idx[0]];
            const qv = sys.pts[q.idx[0]];
            return axisX ? pv.x - qv.x : pv.y - qv.y;
          });
          const gap = Math.hypot(
            sys.pts[sorted[1].idx[0]].x - sys.pts[sorted[0].idx[0]].x,
            sys.pts[sorted[1].idx[0]].y - sys.pts[sorted[0].idx[0]].y,
          );
          if (!(gap > 1e-9)) {
            errors.push(`${c.id}: first two points coincide — cannot infer gap`);
            break;
          }
          for (let i = 0; i + 1 < sorted.length; i++) {
            cons.push({
              kind: "distance",
              pts: [sorted[i].idx[0], sorted[i + 1].idx[0]],
              value: gap,
            });
          }
        } else {
          errors.push(`${c.id}: equality mixes segment and point elements`);
        }
        break;
      }

      case "alignment": {
        const [aId, bId] = ids;
        const aIdx = idx(aId);
        const bIdx = idx(bId);
        if (!aIdx || !bIdx) {
          errors.push(`${c.id}: unknown element '${!aIdx ? aId : bId}'`);
          break;
        }
        const aSeg = sys.segmentIds.has(aId);
        const bSeg = sys.segmentIds.has(bId);
        if (aSeg && bSeg) {
          // Collinear: b's start lies on a's line and the segments are parallel.
          cons.push({ kind: "point-on-line", pts: [bIdx[0], aIdx[0], aIdx[1]] });
          cons.push({ kind: "parallel", pts: [aIdx[0], aIdx[1], bIdx[0], bIdx[1]] });
        } else if (!aSeg && !bSeg) {
          cons.push({ kind: "coincident", pts: [bIdx[0], aIdx[0]] });
        } else {
          const segIdx = aSeg ? aIdx : bIdx;
          const ptIdx = aSeg ? bIdx[0] : aIdx[0];
          cons.push({ kind: "point-on-line", pts: [ptIdx, segIdx[0], segIdx[1]] });
          alignmentPairs.push({ ptIdx, segIdx: [segIdx[0], segIdx[1]] });
        }
        break;
      }

      case "parallel": {
        const [aId, bId] = ids;
        const aIdx = idx(aId);
        const bIdx = idx(bId);
        if (!aIdx || aIdx.length !== 2 || !bIdx || bIdx.length !== 2) {
          errors.push(`${c.id}: parallel needs two linear elements`);
          break;
        }
        cons.push({ kind: "parallel", pts: [aIdx[0], aIdx[1], bIdx[0], bIdx[1]] });
        break;
      }

      case "perpendicular": {
        const [aId, bId] = ids;
        const aIdx = idx(aId);
        const bIdx = idx(bId);
        if (!aIdx || aIdx.length !== 2 || !bIdx || bIdx.length !== 2) {
          errors.push(`${c.id}: perpendicular needs two linear elements`);
          break;
        }
        cons.push({ kind: "perpendicular", pts: [aIdx[0], aIdx[1], bIdx[0], bIdx[1]] });
        break;
      }

      default:
        errors.push(`${c.id}: unsupported stored constraint type '${c.type}'`);
    }
  }

  return { cons, errors, alignmentPairs };
}

/** Apply solved point positions back onto element params (mm-rounded). */
export function applySystem(
  elements: ElementLike[],
  sys: BuiltSystem,
): number {
  const byId = new Map<string, ElementLike>();
  for (const el of elements) if (el?.id) byId.set(el.id, el);

  let changed = 0;
  for (const [id, indices] of sys.indexOf) {
    const el = byId.get(id);
    if (!el?.params) continue;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;

    if (indices.length === 2 && sys.segmentIds.has(id)) {
      const s = readVec(el.params.start);
      const e = readVec(el.params.end);
      if (!s || !e) continue;
      const ns = { x: r3(sys.pts[indices[0]].x), z: r3(sys.pts[indices[0]].y) };
      const ne = { x: r3(sys.pts[indices[1]].x), z: r3(sys.pts[indices[1]].y) };
      if (
        Math.abs(s.x - ns.x) > 1e-4 || Math.abs(s.z - ns.z) > 1e-4 ||
        Math.abs(e.x - ne.x) > 1e-4 || Math.abs(e.z - ne.z) > 1e-4
      ) {
        const shape = writeShape(el, "start");
        const toOut = (v: { x: number; z: number }) =>
          shape === "array" ? [v.x, v.z] : v;
        el.params.start = toOut(ns);
        el.params.end = toOut(ne);
        changed++;
      }
    } else if (indices.length === 1) {
      const key = el.params.point !== undefined ? "point" : "position";
      const cur = readVec(el.params[key]);
      if (!cur) continue;
      const nv = { x: r3(sys.pts[indices[0]].x), z: r3(sys.pts[indices[0]].y) };
      if (Math.abs(cur.x - nv.x) > 1e-4 || Math.abs(cur.z - nv.z) > 1e-4) {
        el.params[key] = writeShape(el, key) === "array" ? [nv.x, nv.z] : nv;
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Solve the stored parametric constraints over a live element list.
 * Mutates element params in place when the solve converges.
 */
export function solveStoredConstraints(
  elements: ElementLike[],
  stored: ParametricConstraint[],
  opts: SolveStoredOptions = {},
): SolveStoredOutcome {
  const joinTol = opts.joinTolerance ?? 1e-6;
  const keepLengths = opts.keepLengths ?? true;
  const errors: string[] = [];

  const active = (stored ?? []).filter((c) => c?.active);
  if (!active.length) return { changed: 0, result: null, errors };

  const sys = buildSystem(elements);
  if (!sys.pts.length) return { changed: 0, result: null, errors };

  // Anchor elements never move (RVT semantics: the locked-to host stays,
  // followers heal to it).
  const pinned = new Set(opts.pinnedIds ?? []);
  for (const id of pinned) {
    const idx = sys.indexOf.get(id);
    if (!idx) continue;
    for (const i of idx) sys.pts[i].fixed = true;
  }

  // Equality chains: the FIRST listed element is the reference whose length
  // stays pinned; the others must stay free or their pinned length would
  // contradict the equality equation (guaranteed non-convergence).
  const eqMembers = new Set<string>();
  const eqFirst = new Set<string>();
  for (const c of active) {
    if (c.type === "equality") {
      const ids = c.elementIds ?? [];
      if (ids.length >= 2) {
        for (const id of ids) eqMembers.add(id);
        eqFirst.add(ids[0]);
      }
    }
  }

  const { cons, errors: convErrors, alignmentPairs } = storedToSolverConstraints(active, sys);
  errors.push(...convErrors);
  if (!cons.length) return { changed: 0, result: null, errors };

  // Pin segment lengths so locked dimensions move neighbours rather than
  // stretch every host (mirrors solveWalls' keepLengths behaviour).
  if (keepLengths) {
    for (const id of sys.segmentIds) {
      if (eqMembers.has(id) && !eqFirst.has(id)) continue;
      const [i, j] = sys.indexOf.get(id)!;
      const L = Math.hypot(sys.pts[j].x - sys.pts[i].x, sys.pts[j].y - sys.pts[i].y);
      if (L > 1e-6) cons.push({ kind: "distance", pts: [i, j], value: L });
    }
  }

  // Auto-join coincident segment endpoints (plan graph, follower = later idx).
  const ends: { i: number; v: SolverPoint }[] = [];
  for (const id of sys.segmentIds) {
    const [i, j] = sys.indexOf.get(id)!;
    ends.push({ i, v: sys.pts[i] }, { i: j, v: sys.pts[j] });
  }
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      if (
        Math.hypot(ends[a].v.x - ends[b].v.x, ends[a].v.y - ends[b].v.y) <= joinTol
      ) {
        cons.push({ kind: "coincident", pts: [ends[b].i, ends[a].i] });
      }
    }
  }

  // Snapshot the pre-solve geometry: alignment post-projection needs the
  // ORIGINAL point positions (the solve itself may slide points arbitrarily
  // along the flat tangential direction of a point-on-line constraint).
  const origPts = sys.pts.map((p) => ({ x: p.x, y: p.y }));

  const result = solve(sys.pts, cons);
  // Only a converged solve may touch the model: an over-constrained or
  // unconverged system is reported, never silently applied (RVT behaves
  // the same — it flags the conflict instead of mangling geometry).
  if (result.status !== "converged") {
    errors.push(
      result.status === "over-constrained"
        ? "over-constrained system — remove a conflicting constraint"
        : `solver did not converge (max residual ${result.maxResidual.toExponential(2)})`,
    );
    return { changed: 0, result, errors };
  }

  // Alignment post-projection: point-on-line leaves the tangential direction
  // free, and the L-M diagonal clamp can amplify Jacobian noise into huge
  // slides along the line. RVT semantics: alignment keeps the point's
  // parametric position along the host — project the ORIGINAL position onto
  // the solved line (foot of perpendicular).
  if (alignmentPairs.length) {
    for (const { ptIdx, segIdx } of alignmentPairs) {
      if (sys.pts[ptIdx].fixed) continue;
      const a = sys.pts[segIdx[0]];
      const b = sys.pts[segIdx[1]];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const L2 = abx * abx + aby * aby;
      if (L2 <= 1e-12) continue;
      const p = origPts[ptIdx];
      const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2;
      sys.pts[ptIdx].x = a.x + t * abx;
      sys.pts[ptIdx].y = a.y + t * aby;
    }
  }

  const changed = applySystem(elements, sys);
  return { changed, result, errors };
}

/** Re-export for call sites that also want raw ad-hoc solving. */
export { solve as solveGeometry };
export type { Constraint, SolverPoint, SolveResult };
