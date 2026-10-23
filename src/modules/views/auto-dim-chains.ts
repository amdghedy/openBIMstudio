/**
 * Auto Dimension: build X and Y dimension chains for every column and wall.
 *
 *  - key coordinates are the FACES (outline corners) of walls and columns
 *  - horizontal chain (measures X) sits `offset` metres below the lowest element
 *  - vertical chain (measures Z / plan-Y) sits `offset` metres left of the leftmost element
 *  - an overall dimension is stacked another `stack` metres further out
 * Each dimension carries element refs so it follows edits. Pure module.
 */
import { collectElementSnapPoints, type SnapRef } from "./element-snap-points";

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
