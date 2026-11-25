/**
 * Polyline width / bulge / Close support for the 2D CAD drawing editor
 * (AutoCAD parity A7).
 *
 * Pure and DOM-free so it can be unit-tested headlessly. The geometry core
 * (bulge circles, tessellation, arc-aware length/area/bbox) lives in
 * dxf-geometry; this module is the entity-level layer on top of it:
 *
 * - Representation: an LWPOLYLINE stores its vertices in `points` and the
 *   arc of each segment in `bulges` (index-aligned; bulges[i] is the
 *   segment from vertex i to the next, the last entry is the closing
 *   segment when closed and unused when open). Width is a constant
 *   `width` (DXF group 43) or per-vertex `startWidths`/`endWidths`
 *   (groups 40/41), also index-aligned. Segments are NEVER pre-tessellated
 *   in the stored entity: the arc survives save/reload and is tessellated
 *   only for display, picking and surgery.
 * - Width resolution: a vertex width overrides the constant width for
 *   its segment; a segment with start ≠ end width tapers linearly.
 * - Reversal: reversing a polyline negates each bulge (the arc is walked
 *   backwards) and swaps each segment's start/end widths.
 * - Surgery rule: operations that cut or rebuild segments (TRIM, EXTEND,
 *   BREAK, FILLET, CHAMFER, OFFSET) work on straight segments, so a
 *   bulged polyline is expanded first (expandPolylineBulges) — the arc
 *   shape is kept as tessellation, only its arc identity is lost for
 *   that operation. Vertex moves (grips, STRETCH, MOVE) keep bulges:
 *   the arc re-derives from the moved endpoints with the same bulge,
 *   exactly like native CAD.
 */
import type { DxfEntity, DxfPoint } from "../drawings/dxf-types";
import {
  bulgeArc,
  bulgePoints,
  normalizePolyline,
  polylineArea as geomPolylineArea,
  polylineBBox as geomPolylineBBox,
  polylineLength as geomPolylineLength,
  tessellatePolyline,
} from "../drawings/dxf-geometry";
import { arcFrom3Points, type ArcDef } from "./cad-annotation";

export type PolylineEntity = Extract<DxfEntity, { type: "LWPOLYLINE" }>;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Start/end width of segment i (vertex widths win over the constant width). */
export function segmentWidths(e: PolylineEntity, i: number): { start: number; end: number } {
  const w = e.width ?? 0;
  return {
    start: e.startWidths?.[i] ?? w,
    end: e.endWidths?.[i] ?? w,
  };
}

/** True when any segment of the polyline carries a width. */
export function polylineHasWidth(e: PolylineEntity): boolean {
  if ((e.width ?? 0) > 0) return true;
  const n = e.points.length;
  for (let i = 0; i < n; i++) {
    const w = segmentWidths(e, i);
    if (w.start > 0 || w.end > 0) return true;
  }
  return false;
}

/** Largest width on any segment (0 when the polyline has no width). */
export function polylineMaxWidth(e: PolylineEntity): number {
  let m = e.width ?? 0;
  const n = e.points.length;
  for (let i = 0; i < n; i++) {
    const w = segmentWidths(e, i);
    if (w.start > m) m = w.start;
    if (w.end > m) m = w.end;
  }
  return m;
}

/**
 * Width fields for a polyline built from per-segment widths: when every
 * segment shares one start = end width, collapse to a single constant
 * `width` (DXF group 43); otherwise keep the per-vertex arrays
 * (groups 40/41). Zero widths collapse to no width at all.
 */
export function widthFieldsForSegments(
  startW: number[], endW: number[],
): { width?: number; startWidths?: number[]; endWidths?: number[] } {
  const n = Math.max(startW.length, endW.length);
  if (n === 0) return {};
  const s = (i: number): number => (isFiniteNum(startW[i]) && startW[i] > 0 ? startW[i] : 0);
  const en = (i: number): number => (isFiniteNum(endW[i]) && endW[i] > 0 ? endW[i] : 0);
  if (n > 0 && ![...Array(n).keys()].some((i) => s(i) > 0 || en(i) > 0)) return {};
  const first = s(0);
  const uniform = first > 0 && ![...Array(n).keys()].some((i) => s(i) !== first || en(i) !== first);
  if (uniform) return { width: first };
  return {
    startWidths: [...Array(n).keys()].map((i) => s(i)),
    endWidths: [...Array(n).keys()].map((i) => en(i)),
  };
}

/** Build a stored polyline from drafted segments (bulges/widths optional). */
export function buildPolylineEntity(opts: {
  layer: string;
  props: Record<string, unknown>;
  points: DxfPoint[];
  bulges?: number[];
  startWidths?: number[];
  endWidths?: number[];
  width?: number;
  closed: boolean;
}): PolylineEntity {
  const { layer, props, points, closed } = opts;
  const ent: PolylineEntity = {
    type: "LWPOLYLINE",
    layer,
    ...(props as Partial<PolylineEntity>),
    points: points.map((p) => ({ x: p.x, y: p.y })),
    closed,
  } as PolylineEntity;
  const bulges = (opts.bulges ?? []).slice(0, points.length);
  if (bulges.some((b) => b)) ent.bulges = bulges;
  if (opts.width != null && opts.width > 0) ent.width = opts.width;
  else {
    const fields = widthFieldsForSegments(opts.startWidths ?? [], opts.endWidths ?? []);
    if (fields.width != null) ent.width = fields.width;
    if (fields.startWidths) ent.startWidths = fields.startWidths;
    if (fields.endWidths) ent.endWidths = fields.endWidths;
  }
  return normalizePolyline(ent);
}

/**
 * Full vertex reversal (PEDIT R / REVERSE): segment j of the reversed
 * polyline is old segment (n-2-j) walked backwards, so its bulge negates
 * and its start/end widths swap; the closing segment (closed only) is
 * old segment (n-1) walked backwards. Straight polylines reverse exactly
 * as before — only the bookkeeping is new.
 */
export function reversePolylineEntity(e: PolylineEntity): PolylineEntity {
  const n = e.points.length;
  if (n < 2) return { ...e, points: e.points.slice() };
  const points = e.points.slice().reverse();
  const closed = !!e.closed;
  const segCount = closed ? n : n - 1;
  const bulges = new Array<number>(n).fill(0);
  const startW = new Array<number>(n).fill(0);
  const endW = new Array<number>(n).fill(0);
  for (let j = 0; j < segCount; j++) {
    // New segment j is old segment (segCount - 1 - j) walked backwards:
    // for open polylines segCount = n-1, so old index n-2-j; for closed
    // segCount = n, so old index n-1-j — the same expression.
    const old = segCount - 1 - j;
    // Negating a 0 bulge would give -0, which deep-equals 0 but is not
    // Object.is-equal and would round-trip as a spurious group 42.
    const b = e.bulges?.[old] ?? 0;
    bulges[j] = b === 0 ? 0 : -b;
    const w = segmentWidths(e, old);
    startW[j] = w.end;
    endW[j] = w.start;
  }
  const out: PolylineEntity = { ...e, points, closed };
  if (bulges.some((b) => b !== 0)) out.bulges = bulges;
  else delete (out as Partial<PolylineEntity>).bulges;
  // Only the first segCount entries are segments — the last entry of an
  // open polyline is unused (0), and passing it would break the uniform
  // collapse (a constant width would come back as per-vertex arrays).
  const fields = widthFieldsForSegments(startW.slice(0, segCount), endW.slice(0, segCount));
  if (fields.width != null) { out.width = fields.width; delete out.startWidths; delete out.endWidths; }
  else if (fields.startWidths) { out.startWidths = fields.startWidths; out.endWidths = fields.endWidths; delete out.width; }
  else { delete out.width; delete out.startWidths; delete out.endWidths; }
  return out;
}

/**
 * Close or open a polyline. Closing adds a straight closing edge (its
 * bulge is forced to 0) whose widths continue the last segment into the
 * first; opening leaves the closing segment's bookkeeping in place but
 * unused (the writer ignores it for open polylines).
 */
export function withClosed(e: PolylineEntity, closed: boolean): PolylineEntity {
  const n = e.points.length;
  const out: PolylineEntity = { ...e, closed };
  if (closed && n >= 2) {
    if (out.bulges) {
      const bulges = out.bulges.slice();
      bulges[n - 1] = 0;
      out.bulges = bulges.some((b) => b !== 0) ? bulges : undefined;
    }
    if (out.startWidths || out.endWidths) {
      const last = segmentWidths(e, n - 2 < 0 ? 0 : n - 2);
      const first = segmentWidths(e, 0);
      const startW = (out.startWidths ?? new Array<number>(n).fill(0)).slice();
      const endW = (out.endWidths ?? new Array<number>(n).fill(0)).slice();
      startW[n - 1] = last.end;
      endW[n - 1] = first.start;
      out.startWidths = startW;
      out.endWidths = endW;
    }
  }
  return normalizePolyline(out);
}

/** Set a constant width on a polyline (PEDIT W): per-vertex widths go away. */
export function withConstantWidth(e: PolylineEntity, width: number): PolylineEntity {
  const out: PolylineEntity = { ...e };
  delete out.startWidths;
  delete out.endWidths;
  if (width > 0) out.width = width;
  else delete out.width;
  return out;
}

/**
 * Tessellate every bulged segment into straight sub-segments, keeping the
 * arc SHAPE (widths are interpolated along each arc) but dropping the arc
 * identity. The operation segment surgery (TRIM / EXTEND / BREAK / FILLET /
 * CHAMFER / OFFSET) needs: those tools rebuild points from straight
 * segments, and carrying a bulge through them would silently move the arc.
 * A bulge-free polyline is returned unchanged.
 */
export function expandPolylineBulges(e: PolylineEntity): PolylineEntity {
  const n = e.points.length;
  if (n < 2 || !e.bulges?.some((b) => b)) return e;
  const closed = !!e.closed;
  const segCount = closed ? n : n - 1;
  const hadVertexWidths = !!(e.startWidths || e.endWidths);
  const points: DxfPoint[] = [];
  const startW: number[] = [];
  const endW: number[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = e.points[i], b = e.points[(i + 1) % n];
    const bg = e.bulges[i] ?? 0;
    const w = segmentWidths(e, i);
    const mid = bg ? bulgePoints(a, b, bg) : [];
    const verts = [a, ...mid, b];
    for (let k = 0; k < verts.length - 1; k++) {
      const t0 = k / (verts.length - 1), t1 = (k + 1) / (verts.length - 1);
      if (k === 0) points.push({ ...verts[0] });
      points.push({ ...verts[k + 1] });
      startW.push(w.start + (w.end - w.start) * t0);
      endW.push(w.start + (w.end - w.start) * t1);
    }
  }
  if (closed) points.pop(); // the last sub-segment ends on the first vertex
  const out: PolylineEntity = { ...e, points, closed };
  delete out.bulges;
  if (!hadVertexWidths) {
    // Constant width (if any) survives untouched — every sub-segment
    // shares it, so the single group-43 value still describes it.
    delete out.startWidths;
    delete out.endWidths;
  } else {
    delete out.width;
    out.startWidths = startW;
    out.endWidths = endW;
  }
  return normalizePolyline(out);
}

/** Bulge of the arc an ArcDef describes: tan of a quarter of its sweep. */
export function bulgeFromArcDef(def: ArcDef): number {
  const sweep = (((def.endAngle - def.startAngle) % 360) + 360) % 360 || 360;
  return Math.tan(((sweep / 4) * Math.PI) / 180);
}

/**
 * Bulge of the arc segment through `through` from `p0` to `p1`
 * (the PLINE Arc option, 3-point arc). null when the points are
 * collinear — no arc exists.
 */
export function arcSegmentBulge(p0: { x: number; y: number }, through: { x: number; y: number }, p1: { x: number; y: number }): number | null {
  const def = arcFrom3Points(p0, through, p1);
  if (!def) return null;
  // arcFrom3Points swaps start/end when the arc runs clockwise, so the
  // def's CCW sweep always passes through `through` — but the bulge is
  // signed by the direction from p0 to p1: positive when the arc runs
  // counter-clockwise from p0, negative when clockwise. Returning the
  // unsigned tan(sweep/4) here would draw the complementary arc (through
  // the wrong side of the chord) for every clockwise arc segment.
  const a0 = (Math.atan2(p0.y - def.center.y, p0.x - def.center.x) * 180) / Math.PI;
  const norm = (d: number): number => ((d % 360) + 360) % 360;
  const startsAtP0 = Math.abs(norm(a0 - def.startAngle)) < 1e-6;
  const sweep = (((def.endAngle - def.startAngle) % 360) + 360) % 360 || 360;
  const mag = Math.tan(((sweep / 4) * Math.PI) / 180);
  return startsAtP0 ? mag : -mag;
}

/** Per-source-segment display runs: tessellated points + end widths. */
export interface PolyDisplaySegment {
  points: DxfPoint[];
  startWidth: number;
  endWidth: number;
}
export function displaySegments(e: PolylineEntity): PolyDisplaySegment[] {
  const n = e.points.length;
  if (n < 2) return [];
  const closed = !!e.closed;
  const segCount = closed ? n : n - 1;
  const out: PolyDisplaySegment[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = e.points[i], b = e.points[(i + 1) % n];
    const bg = e.bulges?.[i] ?? 0;
    const w = segmentWidths(e, i);
    const points = bg ? [a, ...bulgePoints(a, b, bg), b] : [a, b];
    out.push({ points, startWidth: w.start, endWidth: w.end });
  }
  return out;
}

/** Display vertices for a polyline (tessellated when bulged). */
export function displayPoints(e: PolylineEntity): DxfPoint[] {
  return tessellatePolyline(e.points, e.bulges, !!e.closed);
}

/** True (arc-aware) length of a stored polyline. */
export function polylineLength(e: PolylineEntity): number {
  return geomPolylineLength(e.points, e.bulges, !!e.closed);
}

/** True (arc-aware) area of a stored closed polyline (0 when open). */
export function polylineArea(e: PolylineEntity): number {
  return geomPolylineArea(e.points, e.bulges, !!e.closed);
}

/** Bounding box of a stored polyline, arcs and stroke width included. */
export function polylineBBox(e: PolylineEntity): { minX: number; minY: number; maxX: number; maxY: number } {
  return geomPolylineBBox(e.points, e.bulges, !!e.closed, polylineMaxWidth(e) / 2);
}

/** The ARC entity a bulged segment explodes into (EXPLODE). */
export function bulgeSegmentArc(
  p0: DxfPoint, p1: DxfPoint, bulge: number, layer: string,
): Extract<DxfEntity, { type: "ARC" }> | null {
  const arc = bulgeArc(p0, p1, bulge);
  if (!arc) return null;
  return {
    type: "ARC", layer,
    center: { x: arc.center.x, y: arc.center.y },
    radius: arc.radius, startAngle: arc.startAngleDeg, endAngle: arc.endAngleDeg,
  };
}
