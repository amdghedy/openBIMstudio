/**
 * Magnetic alignment & snap-candidate math (MASTER PROMPT §4/§5).
 *
 * Pure 2D XZ-plane math shared by the runtime snap manager
 * (features/snapping.ts). Kept free of DOM/three.js imports so it is
 * directly unit-testable in Node and reusable by the 2D plan stack.
 *
 * All points are [x, z] tuples in world metres.
 */

export type XY = [number, number];

const EPS = 1e-9;

/** Unit direction a→b; null for degenerate segments. */
export function segDir(a: XY, b: XY): XY | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L = Math.hypot(dx, dz);
  if (L < EPS) return null;
  return [dx / L, dz / L];
}

/**
 * Perpendicular snap (§4.1): the foot of the perpendicular FROM the draw
 * start ONTO the infinite line through a→b. This is the point where a
 * segment from `start` would meet the line at 90°. Returns null when the
 * line is degenerate or the draw start equals the foot.
 */
export function perpendicularFoot(start: XY, a: XY, b: XY): XY | null {
  const d = segDir(a, b);
  if (!d) return null;
  const vx = start[0] - a[0];
  const vz = start[1] - a[1];
  const t = vx * d[0] + vz * d[1];
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}

/**
 * Parallel snap (§4.1/§5): the point on the line through `start` with
 * direction `dir` nearest to the cursor — i.e. the cursor projected onto
 * the draw-start's parallel companion of an existing element's direction.
 */
export function parallelPoint(start: XY, dir: XY, cursor: XY): XY {
  const L = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / L;
  const uz = dir[1] / L;
  const t = (cursor[0] - start[0]) * ux + (cursor[1] - start[1]) * uz;
  return [start[0] + ux * t, start[1] + uz * t];
}

/**
 * Segment × segment intersection (§4.1 "Intersection"). Returns the
 * crossing point when the segments properly intersect (within their
 * extents, inclusive of endpoints), null otherwise.
 */
export function segmentIntersection(p1: XY, p2: XY, p3: XY, p4: XY): XY | null {
  const d1x = p2[0] - p1[0];
  const d1z = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2z = p4[1] - p3[1];
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < EPS) return null; // parallel / collinear
  const t = ((p3[0] - p1[0]) * d2z - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1z - (p3[1] - p1[1]) * d1x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [p1[0] + d1x * t, p1[1] + d1z * t];
}

/** Nearest point on a finite segment (clamped projection). */
export function nearestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  if (L2 < EPS) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + dx * t, a[1] + dz * t];
}

/* ── Ranking / hysteresis / cycling (§4.3) ─────────────────────────────── */

export interface RankedLike {
  kind: string;
  screenDist: number;
}

/**
 * Deterministic snap priority: higher `priority[kind]` wins over a closer
 * lower-priority kind; equal priority → nearer to the pointer wins; full
 * tie → stable by kind then distance.
 */
export function rankCandidates<T extends RankedLike>(candidates: T[], priority: Record<string, number>): T[] {
  return [...candidates].sort((a, b) => {
    const pa = priority[a.kind] ?? 0;
    const pb = priority[b.kind] ?? 0;
    if (pa !== pb) return pb - pa;
    return a.screenDist - b.screenDist;
  });
}

export interface HysteresisLike extends RankedLike {
  point: XY;
  elementId?: string;
}

/**
 * Snap lock hysteresis (spec 2B.2): while the previously snapped target
 * is still within tolerance × `hysteresis`, keep it instead of jumping to
 * a new candidate — prevents flicker between overlapping endpoint/midpoint.
 * `same` decides whether a candidate IS the previous target.
 */
export function pickWithHysteresis<T extends HysteresisLike>(
  ranked: T[],
  last: T | null,
  tolerancePx: number,
  same: (cand: T, prev: T) => boolean,
  hysteresis = 1.15,
): T | null {
  if (!ranked.length) return null;
  if (last) {
    const again = ranked.find((c) => same(c, last));
    if (again && again.screenDist <= tolerancePx * hysteresis) return again;
  }
  return ranked[0];
}

/**
 * Tab-cycle step (§4.3): move the selection index forward/backward within
 * the ranked candidate list, wrapping around. Returns the next candidate.
 */
export function cycleCandidate<T>(ranked: T[], currentIndex: number, step: 1 | -1): { item: T; index: number } | null {
  if (!ranked.length) return null;
  const n = ranked.length;
  const next = ((currentIndex + step) % n + n) % n;
  return { item: ranked[next], index: next };
}

/**
 * Screen tolerance → world tolerance at the cursor's depth, so snapping
 * stays intuitive at every zoom level (§4.2 "configurable screen-space
 * snapping tolerance").
 */
export function worldPerPixel(cameraDistance: number, fovRadians: number, viewportHeightPx: number): number {
  const h = Math.max(1, viewportHeightPx);
  const dist = Math.max(1e-6, cameraDistance);
  return (2 * dist * Math.tan(fovRadians / 2)) / h;
}

/** Squared distance in XZ (avoids sqrt in hot loops). */
export function dist2(a: XY, b: XY): number {
  const dx = a[0] - b[0];
  const dz = a[1] - b[1];
  return dx * dx + dz * dz;
}

/**
 * Magnetic prefilter (§4.2 performance): is an element's AABB worth
 * visiting for a cursor at `cursor` with world tolerance `tol`?
 */
export function aabbNearCursor(
  cursor: XY,
  tol: number,
  min: XY,
  max: XY,
): boolean {
  const slack = tol * 4 + 0.05;
  return (
    cursor[0] >= min[0] - slack && cursor[0] <= max[0] + slack &&
    cursor[1] >= min[1] - slack && cursor[1] <= max[1] + slack
  );
}
