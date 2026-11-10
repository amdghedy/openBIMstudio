/**
 * Polygon math for filled / masking regions — pure, DOM-free, unit-testable.
 *
 * Filled regions are closed polygons in a 2D plane (plan view uses world XZ
 * mapped to XY with y = -z before calling in). Utilities here are generic:
 * points are {x, y} pairs on one 2D plane, polygons are closed implicitly
 * (last vertex connects back to the first).
 */

export interface PolyPt {
  x: number;
  y: number;
}

export interface PolyBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Segment2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Even-odd ray-cast point-in-polygon (works for concave polygons). */
export function pointInPolygon(x: number, y: number, poly: readonly PolyPt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonBBox(poly: readonly PolyPt[]): PolyBBox {
  const bb: PolyBBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of poly) {
    if (p.x < bb.minX) bb.minX = p.x;
    if (p.y < bb.minY) bb.minY = p.y;
    if (p.x > bb.maxX) bb.maxX = p.x;
    if (p.y > bb.maxY) bb.maxY = p.y;
  }
  if (!isFinite(bb.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return bb;
}

/** Signed area (shoelace). Positive = counter-clockwise in a y-up plane. */
export function polygonSignedArea(poly: readonly PolyPt[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  }
  return s / 2;
}

export function translatePolygon(poly: readonly PolyPt[], dx: number, dy: number): PolyPt[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Intersection parameter t of segment ab with segment cd, or null.
 * Returns t in [0,1] along ab (u along cd is computed internally).
 */
function segSegT(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number | null {
  const rx = bx - ax, ry = by - ay;
  const sx = dx - cx, sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Clip one segment to an arbitrary (possibly concave) polygon.
 * Returns the inside sub-segments as [t0, t1] intervals along ab.
 *
 * Method: collect all boundary-crossing parameters, sort them, and keep every
 * span whose midpoint is inside the polygon (even-odd). Robust for concave
 * boundaries without decomposing the polygon.
 */
export function clipSegmentToPolygonIntervals(
  a: PolyPt, b: PolyPt, poly: readonly PolyPt[],
): Array<[number, number]> {
  const ts: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const t = segSegT(a.x, a.y, b.x, b.y, poly[j].x, poly[j].y, poly[i].x, poly[i].y);
    if (t != null) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const cuts = [0, ...ts, 1];
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const mid = { x: a.x + (b.x - a.x) * (t0 + t1) / 2, y: a.y + (b.y - a.y) * (t0 + t1) / 2 };
    if (pointInPolygon(mid.x, mid.y, poly)) intervals.push([t0, t1]);
  }
  return intervals;
}

/** Clip pattern lines to a polygon; returns only the inside parts. */
export function clipLinesToPolygon(
  lines: readonly Segment2D[],
  poly: readonly PolyPt[],
): Segment2D[] {
  const out: Segment2D[] = [];
  for (const l of lines) {
    const a: PolyPt = { x: l.x1, y: l.y1 };
    const b: PolyPt = { x: l.x2, y: l.y2 };
    for (const [t0, t1] of clipSegmentToPolygonIntervals(a, b, poly)) {
      out.push({
        x1: a.x + (b.x - a.x) * t0, y1: a.y + (b.y - a.y) * t0,
        x2: a.x + (b.x - a.x) * t1, y2: a.y + (b.y - a.y) * t1,
      });
    }
  }
  return out;
}
