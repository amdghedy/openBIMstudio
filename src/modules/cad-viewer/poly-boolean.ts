/**
 * Lightweight 2D polygon boolean ops for REGION / UNION / SUBTRACT / INTERSECT.
 * Not ACIS — closed polylines only, axis-aligned-friendly clipping + winding rules.
 */
export type Pt = { x: number; y: number };

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ai = poly[i], aj = poly[j];
    if ((ai.y > p.y) !== (aj.y > p.y) &&
      p.x < ((aj.x - ai.x) * (p.y - ai.y)) / (aj.y - ai.y + 1e-15) + ai.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  const u = -((a.x - b.x) * (a.y - c.y) - (a.y - b.y) * (a.x - c.x)) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** Sutherland–Hodgman clip subject against one convex clip edge. */
function clipEdge(subject: Pt[], a: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i], prev = subject[(i + subject.length - 1) % subject.length];
    const curIn = cross(a, b, cur) >= -1e-9;
    const prevIn = cross(a, b, prev) >= -1e-9;
    if (curIn) {
      if (!prevIn) {
        const hit = segIntersect(prev, cur, a, b);
        if (hit) out.push(hit);
      }
      out.push(cur);
    } else if (prevIn) {
      const hit = segIntersect(prev, cur, a, b);
      if (hit) out.push(hit);
    }
  }
  return out;
}

/** Clip subject polygon by a convex clip polygon. */
export function clipPolygon(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject.slice();
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    out = clipEdge(out, a, b);
    if (!out.length) return [];
  }
  return out;
}

function bbox(poly: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function sampleGrid(a: Pt[], b: Pt[], n = 24): Pt[] {
  const ba = bbox(a), bb = bbox(b);
  const minX = Math.min(ba.minX, bb.minX), maxX = Math.max(ba.maxX, bb.maxX);
  const minY = Math.min(ba.minY, bb.minY), maxY = Math.max(ba.maxY, bb.maxY);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p = {
        x: minX + (i / n) * (maxX - minX || 1),
        y: minY + (j / n) * (maxY - minY || 1),
      };
      pts.push(p);
    }
  }
  return pts;
}

/**
 * Approximate UNION / INTERSECT / SUBTRACT by collecting boundary candidates
 * and contouring inclusion. For convex pairs uses SH clip; for general uses
 * sampling + convex hull of included points (good enough for schedules/rooms).
 */
export function booleanPoly(
  a: Pt[],
  b: Pt[],
  op: "union" | "intersect" | "subtract",
): Pt[] {
  if (a.length < 3 || b.length < 3) return [];
  // Prefer exact clip for intersect when clip is used as convex approx
  if (op === "intersect") {
    const c1 = clipPolygon(a, b);
    if (c1.length >= 3) return c1;
    const c2 = clipPolygon(b, a);
    if (c2.length >= 3) return c2;
  }
  if (op === "subtract") {
    // A minus B: keep points of A outside B + intersection boundary samples
    const keep = a.filter((p) => !pointInPoly(p, b));
    const samples = sampleGrid(a, b, 32).filter((p) => pointInPoly(p, a) && !pointInPoly(p, b));
    const cloud = [...keep, ...samples];
    return convexHull(cloud);
  }
  // union
  const cloud = [
    ...a.filter((p) => !pointInPoly(p, b)),
    ...b.filter((p) => !pointInPoly(p, a)),
    ...sampleGrid(a, b, 28).filter((p) => pointInPoly(p, a) || pointInPoly(p, b)),
  ];
  return convexHull(cloud);
}

function convexHull(pts: Pt[]): Pt[] {
  const uniq = new Map<string, Pt>();
  for (const p of pts) uniq.set(`${p.x.toFixed(6)},${p.y.toFixed(6)}`, p);
  const arr = [...uniq.values()];
  if (arr.length < 3) return arr;
  arr.sort((p, q) => p.x - q.x || p.y - q.y);
  const lower: Pt[] = [];
  for (const p of arr) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Extrude closed polygon to a simple 3D mesh (triangle strip walls + caps) for preview. */
export function extrudeMesh(
  ring: Pt[],
  height: number,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const n = ring.length;
  if (n < 3 || height <= 0) return { positions, indices };
  for (const p of ring) positions.push(p.x, p.y, 0);
  for (const p of ring) positions.push(p.x, p.y, height);
  // bottom fan
  for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
  // top fan
  for (let i = 1; i < n - 1; i++) indices.push(n, n + i + 1, n + i);
  // walls
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  return { positions, indices };
}

export interface SolidFootprint {
  ring: Pt[];
  height: number;
  z0?: number;
}

/** Boolean two extruded footprints → new footprint solid (height rules: max for union, min for intersect). */
export function booleanSolid(
  a: SolidFootprint,
  b: SolidFootprint,
  op: "union" | "intersect" | "subtract",
): SolidFootprint | null {
  const ring = booleanPoly(a.ring, b.ring, op);
  if (ring.length < 3) return null;
  let height = a.height;
  if (op === "union") height = Math.max(a.height, b.height);
  else if (op === "intersect") height = Math.min(a.height, b.height);
  else height = a.height;
  return { ring, height, z0: a.z0 ?? 0 };
}

/** Simple box corners as ring. */
export function boxRing(x: number, y: number, w: number, d: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ];
}

/** Approximate mesh volume (prism). */
export function solidVolume(s: SolidFootprint): number {
  let a = 0;
  const r = s.ring;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) * 0.5 * s.height;
}
