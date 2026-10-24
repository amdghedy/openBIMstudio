/** Pure helpers for editing a closed polygon boundary (floor, roof, slab, terrain...). */
export type Pt = [number, number];

export const MIN_BOUNDARY_VERTICES = 3;

/** Signed area (shoelace). Positive = counter-clockwise in (x, z). */
export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/** Midpoint of edge i (between vertex i and i+1, wrapping). */
export function edgeMidpoint(poly: Pt[], i: number): Pt {
  const a = poly[i], b = poly[(i + 1) % poly.length];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** New polygon with a vertex inserted on edge `edge` at `pt`; new vertex index = edge + 1. */
export function insertVertex(poly: Pt[], edge: number, pt: Pt): Pt[] {
  const out = poly.map((p) => [p[0], p[1]] as Pt);
  out.splice(edge + 1, 0, [pt[0], pt[1]]);
  return out;
}

/** New polygon without vertex i, or null when that would leave fewer than 3 vertices. */
export function removeVertex(poly: Pt[], i: number): Pt[] | null {
  if (poly.length <= MIN_BOUNDARY_VERTICES || i < 0 || i >= poly.length) return null;
  return poly.filter((_, k) => k !== i).map((p) => [p[0], p[1]] as Pt);
}

/** New polygon with vertex i moved to pt. */
export function moveVertex(poly: Pt[], i: number, pt: Pt): Pt[] {
  return poly.map((p, k) => (k === i ? [pt[0], pt[1]] : [p[0], p[1]]) as Pt);
}

/** Nearest vertex within tolerance, or -1. */
export function hitVertex(poly: Pt[], x: number, z: number, tol: number): number {
  let best = -1, bd = tol;
  poly.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d <= bd) { bd = d; best = i; } });
  return best;
}

/** True when two segments properly cross (shared endpoints and touching do not count). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < -1e-12 && o3 * o4 < -1e-12;
}

/** A boundary is valid when it has area and no two non-adjacent edges cross. */
export function isValidBoundary(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < MIN_BOUNDARY_VERTICES) return false;
  if (Math.abs(polygonArea(poly)) < 1e-6) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}
