/**
 * Exact mesh queries used by the clash engine. Pure: Float32Array triangles
 * (9 floats each), no three.js, no DOM.
 *
 *  - triTriDistance  : exact minimum distance between two triangles (0 when they intersect)
 *  - pointInMesh     : is a point inside a closed mesh (ray-crossing, 3 directions, majority vote)
 *  - containedPoints : sample surface points of A that lie inside the solid B
 */
import { triTriIntersect, type Tri } from "./geometry";

type V = [number, number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vtx = (t: Tri, i: number): V => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];

/** Squared distance from point p to triangle (a,b,c) (Ericson, Real-Time Collision Detection). */
export function pointTriDist2(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); const q: V = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; const d = sub(p, q); return dot(d, d); }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); const q: V = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; const d = sub(p, q); return dot(d, d); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const bc = sub(c, b); const q: V = [b[0] + w * bc[0], b[1] + w * bc[1], b[2] + w * bc[2]]; const d = sub(p, q); return dot(d, d);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const q: V = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  const d = sub(p, q);
  return dot(d, d);
}

/** Squared distance between segments p1-q1 and p2-q2 (Ericson). */
export function segSegDist2(p1: V, q1: V, p2: V, q2: V): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) { return dot(r, r); }
  if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const c1: V = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: V = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const d = sub(c1, c2);
  return dot(d, d);
}

/** Exact minimum distance between two triangles; 0 if they intersect. */
export function triTriDistance(T1: Tri, T2: Tri): number {
  if (triTriIntersect(T1, T2)) return 0;
  const A = [vtx(T1, 0), vtx(T1, 1), vtx(T1, 2)];
  const B = [vtx(T2, 0), vtx(T2, 1), vtx(T2, 2)];
  let best = Infinity;
  for (const p of A) best = Math.min(best, pointTriDist2(p, B[0], B[1], B[2]));
  for (const p of B) best = Math.min(best, pointTriDist2(p, A[0], A[1], A[2]));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    best = Math.min(best, segSegDist2(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3]));
  }
  return Math.sqrt(best);
}

/** Möller–Trumbore ray/triangle test for t > eps. */
function rayHitsTri(o: V, d: V, t: Tri): boolean {
  const a = vtx(t, 0), b = vtx(t, 1), c = vtx(t, 2);
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return false;
  return dot(e2, q) * inv > 1e-9;
}

/** Three fixed, deliberately "irrational" directions so rays rarely graze edges of axis-aligned geometry. */
const DIRS: V[] = [
  [0.5773, 0.3571, 0.7341],
  [-0.2671, 0.8123, -0.5211],
  [0.1913, -0.6427, 0.7431],
];

/** Inside test by ray-crossing with a 2-of-3 vote. Meaningful for closed meshes only. */
export function pointInMesh(tris: readonly Tri[], p: V): boolean {
  let inside = 0;
  for (const d of DIRS) {
    let hits = 0;
    for (const t of tris) if (rayHitsTri(p, d, t)) hits++;
    if (hits % 2 === 1) inside++;
  }
  return inside >= 2;
}

/**
 * If the surfaces of A and B never cross, A is either entirely inside B or entirely outside.
 * Sample a few points of A (triangle centroids spread over its triangle list) and
 * report whether they are inside the closed solid B.
 */
export function meshInsideMesh(a: readonly Tri[], b: readonly Tri[], samples = 3): { inside: boolean; point: V | null } {
  if (!a.length || !b.length) return { inside: false, point: null };
  const n = Math.min(samples, a.length);
  let votes = 0;
  let first: V | null = null;
  for (let k = 0; k < n; k++) {
    const t = a[Math.floor((k * a.length) / n)];
    const p: V = [(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3];
    if (pointInMesh(b, p)) { votes++; if (!first) first = p; }
  }
  return { inside: votes * 2 > n, point: first };
}
