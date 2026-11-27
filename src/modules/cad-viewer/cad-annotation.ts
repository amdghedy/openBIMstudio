/**
 * Annotation geometry for the 2D CAD drawing editor (AutoCAD parity A10).
 *
 * Pure and DOM-free so it can be unit-tested headlessly:
 *
 * 1. Arc variants — the ARC tool used to be 3-point only. These builders
 *    cover AutoCAD's ARC options: start-center-end, start-end-angle,
 *    start-end-radius, center-start-angle and center-start-length.
 * 2. Ordinate axis — DIMORDINATE's X/Y datum is decided by the leader
 *    endpoint, the way AutoCAD does it (the leader endpoint's dominant
 *    offset from the feature point).
 * 3. Leader arrowhead — the Leader tool's arrow: a filled triangle at
 *    the arrow point, pointing back along the leader.
 *
 * Arc convention (matches the DXF ARC entity and the viewer's renderer):
 * an arc is stored as { center, radius, startAngle, endAngle } with the
 * arc drawn counter-clockwise from startAngle to endAngle. A clockwise
 * arc is stored with its start and end angles swapped, so the CCW sweep
 * draws the same geometric arc — the entity has no inherent direction.
 * Angles are degrees; the sweep is always 0 < sweep < 360.
 */
import type { DxfEntity, DxfPoint } from "../drawings/dxf-types";

export interface Pt {
  x: number;
  y: number;
}

export interface ArcDef {
  center: Pt;
  radius: number;
  /** Degrees, counter-clockwise from here to endAngle. */
  startAngle: number;
  /** Degrees. */
  endAngle: number;
}

const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const toRad = (d: number): number => (d * Math.PI) / 180;
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const angOf = (c: Pt, p: Pt): number => toDeg(Math.atan2(p.y - c.y, p.x - c.x));

/** Point `p` rotated about `c` by `angleDeg` (counter-clockwise when positive). */
export function rotatePoint(c: Pt, p: Pt, angleDeg: number): Pt {
  const a = toRad(angleDeg);
  const dx = p.x - c.x, dy = p.y - c.y;
  const cos = Math.cos(a), sin = Math.sin(a);
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/**
 * The classic 3-point arc (the ARC tool's original flow): circumcentre of
 * the three points, start/end angles from the first and third points.
 * Real fix in passing: the old inline code never checked which side of the
 * chord the middle point sits on, so a clockwise 3-point arc rendered as
 * the complementary counter-clockwise arc. The sweep is now chosen so the
 * drawn arc passes through the middle point — swap start/end when the
 * middle point is on the clockwise side.
 */
export function arcFrom3Points(p1: Pt, p2: Pt, p3: Pt): ArcDef | null {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) <= 1e-9) return null; // collinear — no circle through them
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const center = { x: ux, y: uy };
  const radius = Math.hypot(ax - ux, ay - uy);
  if (!Number.isFinite(radius) || radius < 1e-9) return null;
  let startAngle = angOf(center, p1);
  let endAngle = angOf(center, p3);
  // Does the counter-clockwise sweep from start to end pass through p2?
  const sweep = norm360(endAngle - startAngle) || 360;
  const midRel = norm360(angOf(center, p2) - startAngle);
  if (midRel > sweep + 1e-9) {
    // Middle point is on the clockwise side — swap so the CCW sweep draws
    // the arc through it.
    const t = startAngle;
    startAngle = endAngle;
    endAngle = t;
  }
  return { center, radius, startAngle, endAngle };
}

/**
 * Start-Center-End (and Center-Start-End — same geometry): the radius comes
 * from centre→start; the end point defines its angle, not the radius.
 */
export function arcFromStartCenterEnd(start: Pt, center: Pt, end: Pt): ArcDef | null {
  const radius = dist(center, start);
  if (!Number.isFinite(radius) || radius < 1e-9) return null;
  if (dist(center, end) < 1e-9) return null; // end point at the centre — no angle
  return { center, radius, startAngle: angOf(center, start), endAngle: angOf(center, end) };
}

function arcFromChord(
  start: Pt,
  end: Pt,
  radius: number,
  center: Pt,
  ccw: boolean,
): ArcDef {
  return ccw
    ? { center, radius, startAngle: angOf(center, start), endAngle: angOf(center, end) }
    : { center, radius, startAngle: angOf(center, end), endAngle: angOf(center, start) };
}

/**
 * Start-End-Angle: the arc through start/end subtending the given included
 * angle. Positive angle draws counter-clockwise from start to end (the
 * centre sits left of the start→end direction); a negative angle draws
 * clockwise (centre right, angles stored swapped). |angle| must be in
 * (0, 360) — a full circle is not an arc.
 */
export function arcFromStartEndAngle(start: Pt, end: Pt, angleDeg: number): ArcDef | null {
  const chord = dist(start, end);
  const abs = Math.abs(angleDeg);
  if (!Number.isFinite(chord) || chord < 1e-9 || abs < 1e-9 || abs >= 360) return null;
  const half = toRad(abs / 2);
  const radius = chord / (2 * Math.sin(half));
  const h = (chord / 2) / Math.tan(half);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = (end.x - start.x) / chord, dy = (end.y - start.y) / chord;
  const nx = -dy, ny = dx; // left normal of the start→end direction
  const sgn = angleDeg > 0 ? 1 : -1;
  const center = { x: mid.x + nx * h * sgn, y: mid.y + ny * h * sgn };
  return arcFromChord(start, end, radius, center, angleDeg > 0);
}

/**
 * Start-End-Radius: the arc through start/end with the given radius.
 * Positive radius draws counter-clockwise from start to end (centre left
 * of the start→end direction, the minor arc); a negative radius draws
 * clockwise (centre right, angles stored swapped). |radius| must be at
 * least half the chord, or no such arc exists.
 */
export function arcFromStartEndRadius(start: Pt, end: Pt, radius: number): ArcDef | null {
  const chord = dist(start, end);
  if (!Number.isFinite(chord) || chord < 1e-9 || !Number.isFinite(radius)) return null;
  const r = Math.abs(radius);
  if (r < chord / 2 - 1e-9) return null;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = (end.x - start.x) / chord, dy = (end.y - start.y) / chord;
  const nx = -dy, ny = dx;
  const sgn = radius > 0 ? 1 : -1;
  const center = { x: mid.x + nx * h * sgn, y: mid.y + ny * h * sgn };
  return arcFromChord(start, end, r, center, radius > 0);
}

/**
 * Center-Start-Angle: the arc about `center` from `start`, sweeping the
 * given included angle. Positive angle is counter-clockwise; a negative
 * angle sweeps clockwise (angles stored swapped).
 */
export function arcFromCenterStartAngle(center: Pt, start: Pt, angleDeg: number): ArcDef | null {
  const radius = dist(center, start);
  const abs = Math.abs(angleDeg);
  if (!Number.isFinite(radius) || radius < 1e-9 || abs < 1e-9 || abs >= 360) return null;
  const end = rotatePoint(center, start, angleDeg);
  return angleDeg > 0
    ? { center, radius, startAngle: angOf(center, start), endAngle: angOf(center, end) }
    : { center, radius, startAngle: angOf(center, end), endAngle: angOf(center, start) };
}

/**
 * Center-Start-Length: the arc about `center` from `start` whose chord is
 * `length` long (the minor arc, counter-clockwise). Length must be in
 * (0, diameter].
 */
export function arcFromCenterStartLength(center: Pt, start: Pt, length: number): ArcDef | null {
  const radius = dist(center, start);
  if (!Number.isFinite(radius) || radius < 1e-9 || !Number.isFinite(length) || length <= 1e-9) return null;
  if (length > 2 * radius + 1e-9) return null; // longer than the diameter
  const sweep = 2 * Math.asin(Math.min(1, length / (2 * radius)));
  const end = rotatePoint(center, start, toDeg(sweep));
  return { center, radius, startAngle: angOf(center, start), endAngle: angOf(center, end) };
}

/**
 * DIMORDINATE's datum, decided by the leader endpoint the way AutoCAD does
 * it: the dominant offset from the feature point. A mostly-horizontal
 * leader measures the X coordinate; a mostly-vertical one the Y coordinate.
 */
export function ordinateAxis(feature: Pt, leaderEnd: Pt): "x" | "y" {
  const dx = Math.abs(leaderEnd.x - feature.x);
  const dy = Math.abs(leaderEnd.y - feature.y);
  return dx >= dy ? "x" : "y";
}

/**
 * Leader arrowhead: a filled triangle whose tip sits exactly on the arrow
 * point and whose base trails back toward `from` (the landing end). Same
 * construction as the reader's native dimension arrows (closed polyline
 * with a solid hatch), so it renders and exports identically.
 * Returns null when the leader has no direction.
 */
export function buildLeaderArrowhead(
  tip: DxfPoint,
  from: DxfPoint,
  size: number,
): (Extract<DxfEntity, { type: "LWPOLYLINE" }> & { layer: string }) | null {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const s = Math.max(1e-9, size);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  const dx = (tip.x - from.x) / len, dy = (tip.y - from.y) / len;
  const px = -dy, py = dx;
  const base = { x: tip.x - dx * s, y: tip.y - dy * s };
  const half = s * 0.32;
  const points: DxfPoint[] = [
    { x: tip.x, y: tip.y },
    { x: base.x + px * half, y: base.y + py * half },
    { x: base.x - px * half, y: base.y - py * half },
  ];
  return {
    type: "LWPOLYLINE",
    layer: "",
    points,
    closed: true,
    hatch: { solid: true, loops: [points] },
  } as Extract<DxfEntity, { type: "LWPOLYLINE" }> & { layer: string };
}

/* ───────────────────── Annotation scale (2D-30) ─────────────────────
 *
 * AutoCAD's CANNOSCALE: the current annotation scale. An annotative
 * object stores its paper height and renders at paper height × the
 * scale factor in model space, so the same text reads at the same
 * paper size whatever the viewport scale. Here the factor is the
 * number after the colon: CANNOSCALE 1:50 → factor 50; a bare number
 * is the factor itself (CANNOSCALE 2 → factor 2). The general form
 * A:B → factor B/A covers 1:1, 1:50 and 2:1 alike.
 *
 * Two deliberate boundaries, so a scaled annotation never double-scales:
 * - TEXT/MTEXT (including dimension and leader text, which are TEXT
 *   entities) keep their nominal stored height; the paint path
 *   multiplies the rendered height by the factor.
 * - Dimension and leader arrowheads are baked geometry, so they are
 *   sized by the factor at creation (the dimension style's arrowSize
 *   via the viewer's dimStyleOf, the leader's arrowSize at the pick).
 * The helpers below are pure so the node suite can prove them. */

/** Largest annotation-scale factor accepted (same bound as the session sanitize). */
export const MAX_ANNO_SCALE = 10000;

/** Standard scales the status-bar button cycles through (factors). */
export const ANNO_SCALE_CYCLE: readonly number[] = [1, 2, 5, 10, 20, 50, 100];

/** True when `v` is a usable annotation-scale factor. */
export function isValidAnnoScale(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_ANNO_SCALE;
}

/**
 * Parse a CANNOSCALE argument: a bare factor ("2" → 2) or a ratio
 * ("1:50" → 50, "2:1" → 0.5). Returns null for anything that is not a
 * positive ratio — empty, non-numeric, zero or negative parts, a factor
 * above MAX_ANNO_SCALE.
 */
export function parseAnnoScale(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 2) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const factor = parts.length === 2 ? nums[1] / nums[0] : nums[0];
  return isValidAnnoScale(factor) ? factor : null;
}

/** Render a factor the way AutoCAD shows the scale: 50 → "1:50", 1 → "1:1", 0.5 → "2:1". */
export function formatAnnoScale(scale: number): string {
  const trim = (n: number): string => {
    const s = String(Math.round(n * 1e6) / 1e6);
    return s;
  };
  if (!Number.isFinite(scale) || scale <= 0) return "1:1";
  return scale >= 1 ? `1:${trim(scale)}` : `${trim(1 / scale)}:1`;
}

/** Next scale in the status-bar cycle: the first listed factor above the current one, else back to 1. */
export function nextAnnoScale(current: number): number {
  return ANNO_SCALE_CYCLE.find((s) => s > current) ?? 1;
}
