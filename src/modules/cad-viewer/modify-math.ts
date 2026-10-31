/**
 * CAD Viewer — Modify Math (MOVE / COPY / ROTATE / MIRROR / SCALE / OFFSET).
 *
 * Pure geometry helpers that transform `DxfEntity` objects. Every function is
 * immutable: it returns a NEW entity object and never mutates its input, so the
 * viewer's undo stack can snapshot `before` / `after` entity references.
 *
 * Supported entity types: LINE, CIRCLE, ARC, LWPOLYLINE (incl. hatch loops),
 * TEXT and POINT — the full set the CAD viewer renders.
 */

import type { DxfEntity, DxfPoint, DxfHatch } from "../drawings/dxf-types";

export interface Pt {
  x: number;
  y: number;
}

const P = (x: number, y: number): DxfPoint => ({ x, y });
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* ── Points ── */

export function translatePt(p: Pt, dx: number, dy: number): Pt {
  return { x: p.x + dx, y: p.y + dy };
}

export function rotatePt(p: Pt, c: Pt, rad: number): Pt {
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  const dx = p.x - c.x,
    dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function mirrorPt(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { x: p.x, y: p.y };
  // Projection of (p - a) onto the line direction, doubled → reflection.
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const fx = a.x + t * dx,
    fy = a.y + t * dy; // foot of perpendicular
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

export function scalePt(p: Pt, c: Pt, k: number): Pt {
  return { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k };
}

/* ── Hatch loops ── */

function mapHatch(h: DxfHatch, f: (p: Pt) => Pt): DxfHatch {
  return { ...h, loops: h.loops.map((loop) => loop.map(f)) };
}

/* ── Entity transforms ── */

export function translateEnt(e: DxfEntity, dx: number, dy: number): DxfEntity {
  switch (e.type) {
    case "LINE":
      return { ...e, start: translatePt(e.start, dx, dy), end: translatePt(e.end, dx, dy) };
    case "CIRCLE":
      return { ...e, center: translatePt(e.center, dx, dy) };
    case "ARC":
      return { ...e, center: translatePt(e.center, dx, dy) };
    case "LWPOLYLINE":
      return {
        ...e,
        points: e.points.map((q) => translatePt(q, dx, dy)),
        hatch: e.hatch ? mapHatch(e.hatch, (q) => translatePt(q, dx, dy)) : undefined,
      };
    case "TEXT":
      return { ...e, position: translatePt(e.position, dx, dy) };
    case "POINT":
      return { ...e, position: translatePt(e.position, dx, dy) };
  }
}

/** Rotates counter-clockwise by `deg` around (cx, cy). */
export function rotateEnt(e: DxfEntity, cx: number, cy: number, deg: number): DxfEntity {
  const rad = deg * DEG;
  switch (e.type) {
    case "LINE":
      return {
        ...e,
        start: rotatePt(e.start, { x: cx, y: cy }, rad),
        end: rotatePt(e.end, { x: cx, y: cy }, rad),
      };
    case "CIRCLE":
      return { ...e, center: rotatePt(e.center, { x: cx, y: cy }, rad) };
    case "ARC": {
      const c = rotatePt(e.center, { x: cx, y: cy }, rad);
      return { ...e, center: c, startAngle: norm360(e.startAngle + deg), endAngle: norm360(e.endAngle + deg) };
    }
    case "LWPOLYLINE":
      return {
        ...e,
        points: e.points.map((q) => rotatePt(q, { x: cx, y: cy }, rad)),
        hatch: e.hatch ? mapHatch(e.hatch, (q) => rotatePt(q, { x: cx, y: cy }, rad)) : undefined,
      };
    case "TEXT":
      return {
        ...e,
        position: rotatePt(e.position, { x: cx, y: cy }, rad),
        rotation: norm360((e.rotation ?? 0) + deg),
      };
    case "POINT":
      return { ...e, position: rotatePt(e.position, { x: cx, y: cy }, rad) };
  }
}

/** Mirrors across the infinite line through a→b. Text stays readable (MIRRTEXT=0). */
export function mirrorEnt(e: DxfEntity, a: Pt, b: Pt): DxfEntity {
  switch (e.type) {
    case "LINE":
      return { ...e, start: mirrorPt(e.start, a, b), end: mirrorPt(e.end, a, b) };
    case "CIRCLE":
      return { ...e, center: mirrorPt(e.center, a, b) };
    case "ARC": {
      // Reflect the two angle points; mirroring reverses sweep direction,
      // so the mirrored start angle comes from the original end point.
      const c = mirrorPt(e.center, a, b);
      const s = mirrorPt(
        { x: e.center.x + e.radius * Math.cos(e.startAngle * DEG), y: e.center.y + e.radius * Math.sin(e.startAngle * DEG) },
        a,
        b,
      );
      const t = mirrorPt(
        { x: e.center.x + e.radius * Math.cos(e.endAngle * DEG), y: e.center.y + e.radius * Math.sin(e.endAngle * DEG) },
        a,
        b,
      );
      return {
        ...e,
        center: c,
        // Mirroring reverses the sweep direction, so the mirrored arc runs
        // from the mirrored END point back to the mirrored START point.
        startAngle: norm360(Math.atan2(t.y - c.y, t.x - c.x) * RAD),
        endAngle: norm360(Math.atan2(s.y - c.y, s.x - c.x) * RAD),
      };
    }
    case "LWPOLYLINE":
      return {
        ...e,
        points: e.points.map((q) => mirrorPt(q, a, b)),
        hatch: e.hatch ? mapHatch(e.hatch, (q) => mirrorPt(q, a, b)) : undefined,
      };
    case "TEXT":
      // Keep text upright & readable — mirror only its anchor point.
      return { ...e, position: mirrorPt(e.position, a, b) };
    case "POINT":
      return { ...e, position: mirrorPt(e.position, a, b) };
  }
}

export function scaleEnt(e: DxfEntity, cx: number, cy: number, k: number): DxfEntity {
  if (!Number.isFinite(k) || k <= 0) return e;
  switch (e.type) {
    case "LINE":
      return { ...e, start: scalePt(e.start, { x: cx, y: cy }, k), end: scalePt(e.end, { x: cx, y: cy }, k) };
    case "CIRCLE":
      return { ...e, center: scalePt(e.center, { x: cx, y: cy }, k), radius: e.radius * k };
    case "ARC":
      return { ...e, center: scalePt(e.center, { x: cx, y: cy }, k), radius: e.radius * k };
    case "LWPOLYLINE":
      return {
        ...e,
        points: e.points.map((q) => scalePt(q, { x: cx, y: cy }, k)),
        hatch: e.hatch ? mapHatch(e.hatch, (q) => scalePt(q, { x: cx, y: cy }, k)) : undefined,
      };
    case "TEXT":
      return { ...e, position: scalePt(e.position, { x: cx, y: cy }, k), height: e.height * k };
    case "POINT":
      return { ...e, position: scalePt(e.position, { x: cx, y: cy }, k) };
  }
}

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

/* ── OFFSET ── */

/**
 * Returns a copy of `e` offset by distance `d` toward the side where `side`
 * lies. Returns null when the entity cannot be offset (TEXT / POINT) or when
 * the offset would collapse the shape (e.g. circle radius ≤ 0).
 */
export function offsetEnt(e: DxfEntity, d: number, side: Pt): DxfEntity | null {
  if (!Number.isFinite(d) || d === 0) return null;
  switch (e.type) {
    case "LINE":
      return offsetLine(e, d, side);
    case "CIRCLE":
      return offsetCircle(e, d, side);
    case "ARC":
      return offsetArc(e, d, side);
    case "LWPOLYLINE":
      return offsetPolyline(e, d, side);
    default:
      return null; // TEXT / POINT cannot be offset
  }
}

/** Unit normal of segment a→b (left-hand positive). */
function segNormal(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: -dy / len, y: dx / len };
}

/** True when `p` is on the left side of the directed segment a→b. */
function isLeft(p: Pt, a: Pt, b: Pt): boolean {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 0;
}

function offsetLine(e: Extract<DxfEntity, { type: "LINE" }>, d: number, side: Pt): DxfEntity {
  const n = segNormal(e.start, e.end);
  const s = isLeft(side, e.start, e.end) ? 1 : -1;
  const dx = n.x * d * s,
    dy = n.y * d * s;
  return { ...e, start: P(e.start.x + dx, e.start.y + dy), end: P(e.end.x + dx, e.end.y + dy) };
}

function offsetCircle(e: Extract<DxfEntity, { type: "CIRCLE" }>, d: number, side: Pt): DxfEntity | null {
  const dist = Math.hypot(side.x - e.center.x, side.y - e.center.y);
  const r = dist >= e.radius ? e.radius + d : e.radius - d;
  if (r <= 1e-9) return null;
  return { ...e, radius: r };
}

function offsetArc(e: Extract<DxfEntity, { type: "ARC" }>, d: number, side: Pt): DxfEntity | null {
  const dist = Math.hypot(side.x - e.center.x, side.y - e.center.y);
  const r = dist >= e.radius ? e.radius + d : e.radius - d;
  if (r <= 1e-9) return null;
  return { ...e, radius: r };
}

/**
 * Miter offset for polylines: every vertex slides along the angle-bisector
 * normal so adjacent segments stay joined (AutoCAD-style sharp corners).
 * Works for open and closed loops; hatch boundary loops are offset too.
 */
function offsetPolyline(
  e: Extract<DxfEntity, { type: "LWPOLYLINE" }>,
  d: number,
  side: Pt,
): DxfEntity | null {
  const off = (loop: DxfPoint[]): DxfPoint[] | null => {
    const n = loop.length;
    if (n < 2) return null;
    const closed = !!e.closed && n > 2;
    const segN: Pt[] = [];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) segN.push(segNormal(loop[i], loop[(i + 1) % n]));
    // Decide global side from the first non-degenerate segment.
    let s = 1;
    for (const nn of segN) {
      if (nn.x || nn.y) {
        const a = loop[0];
        const b = loop[1 % n];
        s = isLeft(side, a, b) ? 1 : -1;
        break;
      }
    }
    const out: DxfPoint[] = [];
    for (let i = 0; i < n; i++) {
      const prev = closed ? segN[(i - 1 + m) % m] : segN[Math.max(0, i - 1)];
      const next = closed ? segN[i % m] : segN[Math.min(m - 1, i)];
      let bx: number, by: number;
      if (!prev.x && !prev.y) { bx = next.x; by = next.y; }
      else if (!next.x && !next.y) { bx = prev.x; by = prev.y; }
      else {
        bx = prev.x + next.x;
        by = prev.y + next.y;
        const bl = Math.hypot(bx, by);
        if (bl < 1e-9) { bx = next.x; by = next.y; } // 180° reversal
        else { bx /= bl; by /= bl; }
      }
      // Miter length = d / cos(half-angle between the two normals).
      const cos = Math.max(0.25, bx * prev.x + by * prev.y);
      const mlen = (d * s) / cos;
      out.push(P(loop[i].x + bx * mlen, loop[i].y + by * mlen));
    }
    return out;
  };

  const pts = off(e.points);
  if (!pts) return null;
  const hatch = e.hatch ? { ...e.hatch, loops: e.hatch.loops.map((l) => off(l)).filter((l): l is DxfPoint[] => !!l) } : undefined;
  return { ...e, points: pts, hatch };
}
