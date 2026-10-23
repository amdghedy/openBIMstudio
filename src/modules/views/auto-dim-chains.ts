/**
 * Auto Dimension: build X and Y dimension chains for every column and wall.
 *
 *  - key coordinates are the FACES (outline corners) of walls and columns
 *  - horizontal chain (measures X) sits `offset` metres below the lowest element
 *  - vertical chain (measures Z / plan-Y) sits `offset` metres left of the leftmost element
 *  - an overall dimension is stacked another `stack` metres further out
 * Each dimension carries element refs so it follows edits. Pure module.
 */
import { collectElementSnapPoints, type ElementSnapPoint, type SnapRef } from "./element-snap-points";

export interface AutoDim {
  axis: "x" | "z";
  /** Dimension line position: z for axis "x", x for axis "z" (world metres). */
  linePos: number;
  x1: number; z1: number; x2: number; z2: number;
  ref1: SnapRef; ref2: SnapRef;
  overall: boolean;
}

export interface AutoDimOptions {
  categories?: string[];
  /** Distance of the first chain from the outermost element (m). Default 0.5. */
  offset?: number;
  /** Extra distance of the overall row (m). Default 0.5. */
  stack?: number;
  /** Coordinates closer than this are merged (m). Default 0.005. */
  tol?: number;
  /** Ignore dimensions shorter than this (m). Default 0.01. */
  minLength?: number;
  overall?: boolean;
}

interface Key { v: number; x: number; z: number; ref: SnapRef }

function dedupe(keys: Key[], tol: number): Key[] {
  const sorted = [...keys].sort((a, b) => a.v - b.v);
  const out: Key[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(k.v - last.v) <= tol) continue;
    out.push(k);
  }
  return out;
}

export function buildAutoDimensions(elements: readonly any[], opts: AutoDimOptions = {}): AutoDim[] {
  const cats = new Set(opts.categories ?? ["column", "wall"]);
  const offset = opts.offset ?? 0.5, stack = opts.stack ?? 0.5;
  const tol = opts.tol ?? 0.005, minLen = opts.minLength ?? 0.01;
  const els = elements.filter((e) => cats.has(e?.type));
  if (!els.length) return [];

  // Faces / corners only: for walls and columns these are the real outline corners.
  const pts = collectElementSnapPoints(els).filter((p) => p.kind === "corner");
  if (!pts.length) return [];

  let minX = Infinity, minZ = Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.z); }

  const out: AutoDim[] = [];
  const chain = (axis: "x" | "z") => {
    const keys = dedupe(pts.map((p) => ({ v: axis === "x" ? p.x : p.z, x: p.x, z: p.z, ref: p.ref })), tol);
    if (keys.length < 2) return;
    const base = axis === "x" ? minZ - offset : minX - offset;
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1];
      if (b.v - a.v < minLen) continue;
      out.push({ axis, linePos: base, x1: a.x, z1: a.z, x2: b.x, z2: b.z, ref1: a.ref, ref2: b.ref, overall: false });
    }
    if ((opts.overall ?? true) && keys.length > 2) {
      const a = keys[0], b = keys[keys.length - 1];
      out.push({ axis, linePos: base - stack, x1: a.x, z1: a.z, x2: b.x, z2: b.z, ref1: a.ref, ref2: b.ref, overall: true });
    }
  };
  chain("x");
  chain("z");
  return out;
}


export interface RangeDimOptions {
  /** Direction measured: "x" = horizontal chain, "z" = vertical (plan-Y) chain. */
  axis: "x" | "z";
  /** The two picked edges, in world metres (only the coordinate along `axis` is used for the range). */
  p1: { x: number; z: number; ref?: SnapRef };
  p2: { x: number; z: number; ref?: SnapRef };
  categories?: string[];
  /** Where to put the dimension line (z for axis x, x for axis z). Omit to place `offset` outside the elements. */
  linePos?: number;
  offset?: number;
  stack?: number;
  tol?: number;
  minLength?: number;
  overall?: boolean;
  /** Extra width of the pick band across the measuring direction (m). */
  band?: number;
}

const RANGE_CATS = ["wall", "column", "door", "window"];

/**
 * Dimension everything the line between two picked edges crosses:
 * every wall / column / door / window whose extent meets that line, from the first edge to the last.
 */
export function buildRangeDimension(elements: readonly any[], o: RangeDimOptions): AutoDim[] {
  const axis = o.axis;
  const along = (q: { x: number; z: number }) => (axis === "x" ? q.x : q.z);
  const perp = (q: { x: number; z: number }) => (axis === "x" ? q.z : q.x);
  const tol = o.tol ?? 0.005, minLen = o.minLength ?? 0.01, offset = o.offset ?? 0.5, band = o.band ?? 0.1;
  const lo = Math.min(along(o.p1), along(o.p2)), hi = Math.max(along(o.p1), along(o.p2));
  if (hi - lo < minLen) return [];
  const pLo = Math.min(perp(o.p1), perp(o.p2)) - band, pHi = Math.max(perp(o.p1), perp(o.p2)) + band;

  const cats = new Set(o.categories ?? RANGE_CATS);
  const els = elements.filter((e) => cats.has(e?.type));
  const byEl = new Map<string, ElementSnapPoint[]>();
  // Hosted openings need their host walls to resolve, so collect with the full list.
  for (const q of collectElementSnapPoints(elements.filter((e) => cats.has(e?.type) || e?.type === "wall"))) {
    let a = byEl.get(q.elementId); if (!a) byEl.set(q.elementId, (a = [])); a.push(q);
  }

  const keys: Key[] = [];
  let perpMin = Infinity;
  for (const el of els) {
    const pts = byEl.get(String(el.id)) ?? [];
    if (!pts.length) continue;
    let mn = Infinity, mx = -Infinity;
    for (const q of pts) { const v = perp(q); mn = Math.min(mn, v); mx = Math.max(mx, v); }
    const pad = el.type === "door" || el.type === "window" ? 0.15 : 0;
    if (mx + pad < pLo || mn - pad > pHi) continue;           // line does not cross this element
    perpMin = Math.min(perpMin, mn);
    const useKinds = el.type === "door" || el.type === "window" ? ["jamb"] : ["corner"];
    for (const q of pts) {
      if (!useKinds.includes(q.kind)) continue;
      const v = along(q);
      if (v < lo - tol || v > hi + tol) continue;
      keys.push({ v, x: q.x, z: q.z, ref: q.ref });
    }
  }
  // The picked edges are always the first and last witness points.
  const first = along(o.p1) <= along(o.p2) ? o.p1 : o.p2, last = first === o.p1 ? o.p2 : o.p1;
  const refOf = (q: { x: number; z: number; ref?: SnapRef }): SnapRef => q.ref ?? { kind: "static-boundary", x: q.x, z: q.z };
  keys.push({ v: along(first), x: first.x, z: first.z, ref: refOf(first) });
  keys.push({ v: along(last), x: last.x, z: last.z, ref: refOf(last) });

  // Dedupe, but never drop the picked ends in favour of a nearby element key.
  const merged = dedupe(keys, tol);
  if (merged.length < 2) return [];
  merged[0] = { ...merged[0], x: first.x, z: first.z, ref: refOf(first) };
  merged[merged.length - 1] = { ...merged[merged.length - 1], x: last.x, z: last.z, ref: refOf(last) };

  const base = o.linePos ?? ((isFinite(perpMin) ? perpMin : Math.min(perp(o.p1), perp(o.p2))) - offset);
  const out: AutoDim[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const a = merged[i], b = merged[i + 1];
    if (b.v - a.v < minLen) continue;
    out.push({ axis, linePos: base, x1: a.x, z1: a.z, x2: b.x, z2: b.z, ref1: a.ref, ref2: b.ref, overall: false });
  }
  if ((o.overall ?? true) && merged.length > 2) {
    const a = merged[0], b = merged[merged.length - 1];
    const step = o.stack ?? 0.5;
    // Stack the overall row on the far side from the model's interior (down / left of the chain).
    out.push({ axis, linePos: base - step, x1: a.x, z1: a.z, x2: b.x, z2: b.z, ref1: a.ref, ref2: b.ref, overall: true });
  }
  return out;
}
