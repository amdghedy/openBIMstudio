/**
 * Reference-line tracking (alignment guides that also snap).
 *
 * While a linear element is being drawn, every existing endpoint (and the
 * current start point) offers infinite reference lines: the world X / Z
 * axes through it, plus — for each wall that ends there — that wall's own
 * direction (colinear) and its perpendicular. When the cursor comes within
 * `tol` of one of those lines the point is pulled onto it; when it is near
 * the crossing of two lines from different anchors it is pulled onto the
 * crossing. That is what lets the 4th wall of a room stop exactly square
 * to the 1st.
 *
 * Pure maths, no THREE / DOM, so it is unit-tested in Node.
 */
export interface TrackAnchor {
  x: number;
  z: number;
  /** Directions (radians) of walls that start/end here; adds colinear + perpendicular lines. */
  dirs?: number[];
}

export type TrackKind = "axis" | "colinear" | "perpendicular";

export interface TrackLine {
  /** The anchor the line passes through. */
  from: [number, number];
  /** Unit direction. */
  dir: [number, number];
  kind: TrackKind;
}

export interface TrackHit {
  /** Snapped point (x, z). */
  point: [number, number];
  /** 1 line (projection) or 2 lines (crossing). */
  lines: TrackLine[];
}

const MAX_ANCHORS = 600;

function linesFor(a: TrackAnchor): TrackLine[] {
  const out: TrackLine[] = [
    { from: [a.x, a.z], dir: [1, 0], kind: "axis" },
    { from: [a.x, a.z], dir: [0, 1], kind: "axis" },
  ];
  const seen: number[] = [0, Math.PI / 2];
  const isNew = (ang: number): boolean => {
    const m = ((ang % Math.PI) + Math.PI) % Math.PI;
    return !seen.some((s) => Math.min(Math.abs(s - m), Math.PI - Math.abs(s - m)) < 1e-3);
  };
  for (const d of a.dirs ?? []) {
    if (!Number.isFinite(d)) continue;
    if (isNew(d)) { out.push({ from: [a.x, a.z], dir: [Math.cos(d), Math.sin(d)], kind: "colinear" }); seen.push(((d % Math.PI) + Math.PI) % Math.PI); }
    const p = d + Math.PI / 2;
    if (isNew(p)) { out.push({ from: [a.x, a.z], dir: [Math.cos(p), Math.sin(p)], kind: "perpendicular" }); seen.push(((p % Math.PI) + Math.PI) % Math.PI); }
  }
  return out;
}

const distToLine = (l: TrackLine, x: number, z: number): number =>
  Math.abs((x - l.from[0]) * l.dir[1] - (z - l.from[1]) * l.dir[0]);

function project(l: TrackLine, x: number, z: number): [number, number] {
  const t = (x - l.from[0]) * l.dir[0] + (z - l.from[1]) * l.dir[1];
  return [l.from[0] + l.dir[0] * t, l.from[1] + l.dir[1] * t];
}

function cross(a: TrackLine, b: TrackLine): [number, number] | null {
  const den = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
  if (Math.abs(den) < 0.2) return null; // too shallow an angle: unstable crossing
  const t = ((b.from[0] - a.from[0]) * b.dir[1] - (b.from[1] - a.from[1]) * b.dir[0]) / den;
  return [a.from[0] + a.dir[0] * t, a.from[1] + a.dir[1] * t];
}

/**
 * @param cursor  cursor on the ground plane (x, z)
 * @param anchors reference points (existing endpoints + the current start)
 * @param tol     capture distance in metres (≈ 10–12 screen pixels)
 * @param ignoreNear points closer than this to an anchor are left to the normal endpoint snap
 */
export function computeTracking(
  cursor: [number, number],
  anchors: TrackAnchor[],
  tol: number,
  ignoreNear = tol * 1.5,
): TrackHit | null {
  if (!(tol > 0) || !anchors.length) return null;
  const [cx, cz] = cursor;
  // Nearest anchors only, so dense models stay cheap.
  const pool = anchors.length > MAX_ANCHORS
    ? [...anchors].sort((p, q) => Math.hypot(p.x - cx, p.z - cz) - Math.hypot(q.x - cx, q.z - cz)).slice(0, MAX_ANCHORS)
    : anchors;
  // Lines whose capture band the cursor is inside.
  const cand: Array<{ l: TrackLine; d: number }> = [];
  for (const a of pool) {
    if (Math.hypot(a.x - cx, a.z - cz) <= ignoreNear) continue;
    for (const l of linesFor(a)) {
      const d = distToLine(l, cx, cz);
      if (d <= tol) cand.push({ l, d });
    }
  }
  if (!cand.length) return null;
  cand.sort((p, q) => p.d - q.d);
  const top = cand.slice(0, 40);

  // Prefer a crossing of two lines from different anchors (a fully determined point).
  let best: { pt: [number, number]; a: TrackLine; b: TrackLine; d: number } | null = null;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const A = top[i].l, B = top[j].l;
      if (A.from[0] === B.from[0] && A.from[1] === B.from[1]) continue;
      const X = cross(A, B);
      if (!X) continue;
      const d = Math.hypot(X[0] - cx, X[1] - cz);
      if (d <= tol * 1.6 && (!best || d < best.d)) best = { pt: X, a: A, b: B, d };
    }
  }
  if (best) return { point: best.pt, lines: [best.a, best.b] };
  const one = top[0].l;
  return { point: project(one, cx, cz), lines: [one] };
}
