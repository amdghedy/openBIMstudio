/**
 * AutoCAD FILLET / CHAMFER trim math + in-tool option parsing (parity item A6).
 *
 * The CAD viewer used to fillet/chamfer two LINEs only (`filletTwoLines` /
 * `chamferTwoLines` in modify-math.ts), with the radius / distances settable
 * only from the command line. This module generalises the trim math to the
 * curves AutoCAD accepts — LINE, ARC and the picked segment of an
 * LWPOLYLINE — and parses the in-tool option keywords (R / D / T / TRIM /
 * NOTRIM) the viewer accepts while a FILLET / CHAMFER pick is active.
 *
 * Geometry model: every operand is reduced to a *support* (an infinite line
 * or a circle) plus a *span* (the drawable part of it: a line segment, an
 * arc sweep, or one polyline segment). A fillet of radius r is a circle of
 * radius r tangent to both supports; candidates are enumerated by offsetting
 * each support by ±r (offset lines, grown/shrunk circles) and intersecting
 * the results, then ranked by closeness to the corner (the supports'
 * intersection nearest the two pick points) — the same ranking the old
 * line/line code used. A candidate is valid only when both tangent points
 * fall on the picked spans and the kept part of each operand stays
 * non-degenerate. A chamfer measures d1 / d2 from the corner — the
 * supports' intersection nearest the picks — along each span toward its far
 * end, and joins the two cut points with a bar.
 *
 * Trimming an LWPOLYLINE moves the corner-side vertex of the picked segment
 * to the tangent / cut point (the neighbouring segment follows the moved
 * vertex, exactly as a re-aimed polyline vertex). Two adjacent segments of
 * the SAME open polyline share their corner vertex, so they cannot both
 * move it: that case splits the polyline into two open polylines at the
 * corner, joined by the fillet arc / chamfer bar. A closed polyline in that
 * case is rejected — splitting it would need wrap-around handling.
 *
 * Circles are rejected, not faked: trimming a closed circle at a single
 * tangent point leaves no second cut point, so a circle fillet needs
 * separate geometry (which side of the circle survives is undefined from
 * one tangent point alone). Use an ARC — trim the circle first.
 *
 * Radius 0 is a real AutoCAD case, not an error: both operands are trimmed
 * square to the corner and no arc is added.
 *
 * Pure functions; no DOM, no viewer state — node-testable. Every function
 * is immutable: it returns NEW entity objects and never mutates its input.
 */

import type { DxfEntity, DxfPoint } from "../drawings/dxf-types";

export interface Pt {
  x: number;
  y: number;
}

export type FilletOperand = {
  /** The picked entity (LINE, ARC or LWPOLYLINE). */
  entity: DxfEntity;
  /** World point where the user picked the entity — disambiguates corners. */
  pick: Pt;
  /** LWPOLYLINE only: which segment was picked (index into points). */
  segmentIndex?: number;
};

export interface FilletOptions {
  /** AutoCAD TRIMMODE: true trims both operands to the tangent points. */
  trim: boolean;
}

export type FilletOutcome =
  | {
      ok: true;
      /** Entities `commitReplace` must remove (deduped by identity). */
      before: DxfEntity[];
      /** Entities `commitReplace` must insert (trimmed copies + arc/bar). */
      after: DxfEntity[];
      /** "ARC" for a real fillet, "LINE" for a chamfer bar, null for radius 0. */
      addedKind: "ARC" | "LINE" | null;
    }
  | { ok: false; reason: string };

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const EPS = 1e-9;

function clean(v: number): number {
  if (!Number.isFinite(v)) return v;
  const n = Number(v.toPrecision(15));
  return Object.is(n, -0) ? 0 : n;
}

const pt = (x: number, y: number): Pt => ({ x: clean(x), y: clean(y) });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const angleDeg = (c: Pt, p: Pt): number => Math.atan2(p.y - c.y, p.x - c.x) * RAD;
const norm360 = (a: number): number => {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
};
/** CCW distance in degrees from angle a to angle b. */
const ccwDist = (a: number, b: number): number => norm360(b - a);

/* ── Supports (infinite line / circle) ─────────────────────────────────── */

type Support =
  | { kind: "line"; p: Pt; dir: Pt }
  | { kind: "circle"; center: Pt; radius: number };

type LineSupport = Extract<Support, { kind: "line" }>;
type CircleSupport = Extract<Support, { kind: "circle" }>;

/** Intersection of two infinite lines; null when parallel. */
function infiniteLineX(l1: LineSupport, l2: LineSupport): Pt | null {
  const d1 = l1.dir,
    d2 = l2.dir;
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((l2.p.x - l1.p.x) * d2.y - (l2.p.y - l1.p.y) * d2.x) / den;
  return pt(l1.p.x + t * d1.x, l1.p.y + t * d1.y);
}

/** Intersections of an infinite line with a circle (0, 1 or 2 points). */
function lineCircleX(l: LineSupport, c: CircleSupport): Pt[] {
  const rel = sub(l.p, c.center);
  const b = dot(rel, l.dir);
  const cc = dot(rel, rel) - c.radius * c.radius;
  const disc = b * b - cc;
  if (disc < -1e-9) return [];
  if (Math.abs(disc) <= 1e-9) return [pt(l.p.x - b * l.dir.x, l.p.y - b * l.dir.y)];
  const s = Math.sqrt(disc);
  return [
    pt(l.p.x + (-b - s) * l.dir.x, l.p.y + (-b - s) * l.dir.y),
    pt(l.p.x + (-b + s) * l.dir.x, l.p.y + (-b + s) * l.dir.y),
  ];
}

/** Intersections of two circles (0, 1 or 2 points). */
function circleCircleX(c1: CircleSupport, c2: CircleSupport): Pt[] {
  const d = dist(c1.center, c2.center);
  const r1 = c1.radius,
    r2 = c2.radius;
  if (d < EPS) return []; // concentric (or identical) — no single intersection
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const mid = add(c1.center, scale(unit(sub(c2.center, c1.center)), a));
  if (Math.abs(h2) <= 1e-9) return [mid];
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  const perp = unit({ x: -(c2.center.y - c1.center.y), y: c2.center.x - c1.center.x });
  return [add(mid, scale(perp, h)), add(mid, scale(perp, -h))];
}

/** All intersections of two supports (0–2 points). */
function supportIntersections(s1: Support, s2: Support): Pt[] {
  if (s1.kind === "line" && s2.kind === "line") {
    const p = infiniteLineX(s1, s2);
    return p ? [p] : [];
  }
  if (s1.kind === "line" && s2.kind === "circle") return lineCircleX(s1, s2);
  if (s1.kind === "circle" && s2.kind === "line") return lineCircleX(s2, s1);
  if (s1.kind === "circle" && s2.kind === "circle") return circleCircleX(s1, s2);
  return [];
}

/* ── Curves (support + drawable span) ───────────────────────────────────── */

interface Curve {
  kind: "LINE" | "ARC" | "LWPOLYLINE";
  entity: DxfEntity;
  support: Support;
  contains(p: Pt): boolean;
  /** The two endpoints of the drawable span. */
  ends(): [Pt, Pt];
  /** Distance along the span between two on-span points. */
  along(a: Pt, b: Pt): number;
  /** Point at distance d from `from`, walking toward `toward` along the span; null if it runs off the span. */
  walk(from: Pt, toward: Pt, d: number): Pt | null;
  /**
   * Trimmed copy of the entity keeping the side that contains `keep`, cut
   * at `cut` (both on the span). `keep` is normally the far end.
   */
  trimTo(cut: Pt, keep: Pt): DxfEntity | null;
  /** LWPOLYLINE only: the picked segment index. */
  segmentIndex?: number;
}

function lineCurve(e: Extract<DxfEntity, { type: "LINE" }>): Curve {
  const dir = unit(sub(e.end, e.start));
  const segLen = dist(e.start, e.end);
  const tol = 1e-6 * Math.max(1, segLen);
  const param = (p: Pt): number => {
    const dx = e.end.x - e.start.x,
      dy = e.end.y - e.start.y;
    const l2 = dx * dx + dy * dy;
    return l2 < 1e-24 ? 0 : ((p.x - e.start.x) * dx + (p.y - e.start.y) * dy) / l2;
  };
  return {
    kind: "LINE",
    entity: e,
    support: { kind: "line", p: { ...e.start }, dir },
    contains(p: Pt): boolean {
      const t = param(p);
      if (t < -1e-6 || t > 1 + 1e-6) return false;
      const q = { x: e.start.x + (e.end.x - e.start.x) * t, y: e.start.y + (e.end.y - e.start.y) * t };
      return dist(p, q) <= tol;
    },
    ends(): [Pt, Pt] {
      return [{ ...e.start }, { ...e.end }];
    },
    along(a: Pt, b: Pt): number {
      return dist(a, b);
    },
    walk(from: Pt, toward: Pt, d: number): Pt | null {
      const total = dist(from, toward);
      if (d < -1e-9 || d > total + 1e-9) return null;
      if (total < EPS) return d < EPS ? { ...from } : null;
      const u = unit(sub(toward, from));
      const q = pt(from.x + u.x * d, from.y + u.y * d);
      return this.contains(q) ? q : null;
    },
    trimTo(cut: Pt, keep: Pt): DxfEntity | null {
      const kept = dist(keep, e.start) <= dist(keep, e.end) ? { ...e.start } : { ...e.end };
      if (dist(kept, cut) < EPS) return null;
      return { ...e, start: kept, end: { ...cut } };
    },
  };
}

function arcCurve(e: Extract<DxfEntity, { type: "ARC" }>): Curve {
  const R = e.radius;
  const start = norm360(e.startAngle);
  const sweep = ccwDist(start, norm360(e.endAngle)) || 360;
  const startPt = pt(e.center.x + R * Math.cos(start * DEG), e.center.y + R * Math.sin(start * DEG));
  const endPt = pt(e.center.x + R * Math.cos(norm360(e.endAngle) * DEG), e.center.y + R * Math.sin(norm360(e.endAngle) * DEG));
  const angTol = 1e-7; // degrees
  const rel = (a: number): number => ccwDist(start, norm360(a));
  const onCircle = (p: Pt): boolean => Math.abs(dist(p, e.center) - R) <= 1e-6 * Math.max(1, R);
  return {
    kind: "ARC",
    entity: e,
    support: { kind: "circle", center: { ...e.center }, radius: R },
    contains(p: Pt): boolean {
      return onCircle(p) && rel(angleDeg(e.center, p)) <= sweep + angTol;
    },
    ends(): [Pt, Pt] {
      return [{ ...startPt }, { ...endPt }];
    },
    along(a: Pt, b: Pt): number {
      // Distance between two on-span points measured along the sweep.
      return Math.abs(rel(angleDeg(e.center, a)) - rel(angleDeg(e.center, b))) * DEG * R;
    },
    walk(from: Pt, toward: Pt, d: number): Pt | null {
      if (d < -1e-9) return null;
      const aFrom = angleDeg(e.center, from);
      const aTo = angleDeg(e.center, toward);
      const ccw = ccwDist(aFrom, aTo);
      // Toward the end side the walk is CCW; toward the start side it is CW.
      const dir = ccw <= sweep + angTol ? 1 : -1;
      const total = dir === 1 ? ccw * DEG * R : (360 - ccw) * DEG * R;
      if (d > total + 1e-9) return null;
      const a = norm360(aFrom + dir * (d / R) * RAD);
      const q = pt(e.center.x + R * Math.cos(a * DEG), e.center.y + R * Math.sin(a * DEG));
      return this.contains(q) ? q : null;
    },
    trimTo(cut: Pt, keep: Pt): DxfEntity | null {
      const aCut = angleDeg(e.center, cut);
      // `keep` is always one of the two endpoints here (the far end), so
      // Euclidean distance to the endpoints identifies the kept side.
      const keepStartSide = dist(keep, startPt) <= dist(keep, endPt);
      if (dist(cut, keep) < EPS) return null;
      // Keep the original angle representation on the kept side (the
      // codebase writes raw atan2 degrees, (-180, 180], straight to DXF);
      // only the cut side takes the freshly computed angle.
      const next: Extract<DxfEntity, { type: "ARC" }> = keepStartSide
        ? { ...e, startAngle: e.startAngle, endAngle: aCut }
        : { ...e, startAngle: aCut, endAngle: e.endAngle };
      // A trimmed arc must still sweep forward; a zero sweep means the cut ate the whole arc.
      if (ccwDist(next.startAngle, next.endAngle) < 1e-9) return null;
      return next;
    },
  };
}

function polylineSegmentCurve(
  e: Extract<DxfEntity, { type: "LWPOLYLINE" }>,
  segmentIndex: number,
): Curve {
  const n = e.points.length;
  const closed = !!e.closed;
  const segCount = closed ? n : n - 1;
  const i = ((segmentIndex % segCount) + segCount) % segCount;
  const a = e.points[i];
  const b = e.points[(i + 1) % n];
  const base = lineCurve({ type: "LINE", layer: e.layer, start: { ...a }, end: { ...b } } as Extract<
    DxfEntity,
    { type: "LINE" }
  >);
  return {
    kind: "LWPOLYLINE",
    entity: e,
    support: base.support,
    segmentIndex: i,
    contains: (p: Pt) => base.contains(p),
    ends: () => base.ends(),
    along: (a2: Pt, b2: Pt) => base.along(a2, b2),
    walk: (from: Pt, toward: Pt, d: number) => base.walk(from, toward, d),
    trimTo(cut: Pt, keep: Pt): DxfEntity | null {
      // Move the corner-side vertex of the picked segment (the endpoint
      // farther from `keep`) to the cut point; the neighbouring segment
      // follows the moved vertex, so the polyline stays continuous.
      const moveIdx = dist(keep, a) <= dist(keep, b) ? (i + 1) % n : i;
      const points = e.points.map((p, k) => (k === moveIdx ? { ...cut } : { ...p }));
      if (dist(points[i], points[(i + 1) % n]) < EPS) return null;
      return { ...e, points, native: undefined, nativeSig: undefined };
    },
  };
}

/** Build the curve for one operand, or the reason it cannot be used. */
function curveOf(op: FilletOperand): Curve | { ok: false; reason: string } {
  const e = op.entity;
  switch (e.type) {
    case "LINE":
      return lineCurve(e);
    case "ARC": {
      const sweep = ccwDist(norm360(e.startAngle), norm360(e.endAngle)) || 360;
      if (sweep >= 360 - 1e-9) {
        return { ok: false, reason: "FILLET / CHAMFER: a full-circle arc has no ends to trim — use an ARC with a real sweep, or a CIRCLE trimmed to an arc first." };
      }
      if (!(e.radius > EPS)) {
        return { ok: false, reason: "FILLET / CHAMFER: that arc has no radius to trim against." };
      }
      return arcCurve(e);
    }
    case "LWPOLYLINE": {
      if (e.hatch) return { ok: false, reason: "FILLET / CHAMFER: hatch boundaries cannot be filleted." };
      const n = e.points.length;
      if (n < 2) return { ok: false, reason: "FILLET / CHAMFER: that polyline has no segments." };
      const segCount = e.closed ? n : n - 1;
      if (segCount < 1) return { ok: false, reason: "FILLET / CHAMFER: that polyline has no segments." };
      const seg = op.segmentIndex ?? 0;
      if (!Number.isInteger(seg) || seg < 0 || seg >= segCount) {
        return { ok: false, reason: "FILLET / CHAMFER: no polyline segment was picked." };
      }
      return polylineSegmentCurve(e, seg);
    }
    case "CIRCLE":
      return {
        ok: false,
        reason:
          "FILLET / CHAMFER: circles are not supported — trimming a closed circle at one tangent point leaves no second cut point. Trim the circle to an ARC first, then fillet the arc.",
      };
    default:
      return { ok: false, reason: `FILLET / CHAMFER supports LINE, ARC and polyline segments — not ${e.type}.` };
  }
}

function isCurve(x: Curve | { ok: false; reason: string }): x is Curve {
  return (x as Curve).support !== undefined;
}

/** Tangent point of a fillet circle (centre C) on one operand's support. */
function tangentPoint(curve: Curve, c: Pt): Pt | null {
  const s = curve.support;
  if (s.kind === "line") {
    const t = dot(sub(c, s.p), s.dir);
    return pt(s.p.x + s.dir.x * t, s.p.y + s.dir.y * t);
  }
  const d = sub(c, s.center);
  if (len(d) < EPS) return null;
  const u = unit(d);
  return pt(s.center.x + u.x * s.radius, s.center.y + u.y * s.radius);
}

/** All candidate centres of a radius-r circle tangent to both supports. */
function filletCenters(s1: Support, s2: Support, r: number): Pt[] {
  const out: Pt[] = [];
  const push = (ps: Pt[]): void => {
    for (const p of ps) if (!out.some((q) => dist(q, p) < 1e-9)) out.push(p);
  };
  if (s1.kind === "line" && s2.kind === "line") {
    const n1 = { x: -s1.dir.y, y: s1.dir.x };
    const n2 = { x: -s2.dir.y, y: s2.dir.x };
    for (const a of [1, -1])
      for (const b of [1, -1]) {
        const o1: LineSupport = { kind: "line", p: add(s1.p, scale(n1, r * a)), dir: s1.dir };
        const o2: LineSupport = { kind: "line", p: add(s2.p, scale(n2, r * b)), dir: s2.dir };
        const p = infiniteLineX(o1, o2);
        if (p) push([p]);
      }
    return out;
  }
  if (s1.kind === "line" && s2.kind === "circle") return filletCentersLineCircle(s1, s2, r);
  if (s1.kind === "circle" && s2.kind === "line") return filletCentersLineCircle(s2, s1, r);
  // circle + circle
  if (s1.kind !== "circle" || s2.kind !== "circle") return out;
  for (const a of [1, -1])
    for (const b of [1, -1]) {
      const r1 = s1.radius + a * r;
      const r2 = s2.radius + b * r;
      if (r1 <= EPS || r2 <= EPS) continue;
      push(circleCircleX({ kind: "circle", center: s1.center, radius: r1 }, { kind: "circle", center: s2.center, radius: r2 }));
    }
  return out;
}

function filletCentersLineCircle(
  l: LineSupport,
  c: CircleSupport,
  r: number,
): Pt[] {
  const out: Pt[] = [];
  const n = { x: -l.dir.y, y: l.dir.x };
  for (const a of [1, -1]) {
    const off: LineSupport = { kind: "line", p: add(l.p, scale(n, r * a)), dir: l.dir };
    for (const b of [1, -1]) {
      const rr = c.radius + b * r;
      if (rr <= EPS) continue;
      for (const p of lineCircleX(off, { kind: "circle", center: c.center, radius: rr })) {
        if (!out.some((q) => dist(q, p) < 1e-9)) out.push(p);
      }
    }
  }
  return out;
}

/**
 * The corner: the supports' intersection nearest the two pick points.
 * Null when the supports never meet (parallel lines, disjoint circles).
 */
function cornerPoint(s1: Support, s2: Support, pick1: Pt, pick2: Pt): Pt | null {
  const xs = supportIntersections(s1, s2);
  if (!xs.length) return null;
  let best = xs[0];
  let bestD = dist(best, pick1) + dist(best, pick2);
  for (const x of xs.slice(1)) {
    const d = dist(x, pick1) + dist(x, pick2);
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

/**
 * The endpoint of a span to KEEP after trimming at `cut`: the corner-side
 * endpoint is removed, the other one stays. The corner side is the endpoint
 * nearest the corner (the supports' intersection); when the supports never
 * meet, it is the endpoint nearest the other operand's tangent point — the
 * side facing the other object. (Measuring from the cut itself is wrong:
 * a cut past the span midpoint is nearer the far end than the corner end.)
 * On an exact tie, keep the end farther along the span from the cut.
 */
function keptEnd(curve: Curve, cut: Pt, corner: Pt | null, otherCut: Pt): Pt {
  const [e0, e1] = curve.ends();
  const near = corner ?? otherCut;
  const d0 = dist(e0, near);
  const d1 = dist(e1, near);
  if (Math.abs(d0 - d1) < 1e-9) {
    return curve.along(cut, e0) >= curve.along(cut, e1) ? e0 : e1;
  }
  return d0 < d1 ? e1 : e0;
}

/** Pick the arc sweep that stays near the corner (same rule as modify-math). */
function arcNear(c: Pt, r: number, t1: Pt, t2: Pt, near: Pt): Extract<DxfEntity, { type: "ARC" }> {
  const a0 = angleDeg(c, t1);
  const a1 = angleDeg(c, t2);
  const midOf = (s: number, e: number): number => s + ((((e - s) % 360) + 360) % 360) / 2;
  const pm = (m: number): Pt => pt(c.x + r * Math.cos(m * DEG), c.y + r * Math.sin(m * DEG));
  const d1 = dist(pm(midOf(a0, a1)), near);
  const d2 = dist(pm(midOf(a1, a0)), near);
  return d1 <= d2
    ? { type: "ARC", layer: "", center: { ...c }, radius: r, startAngle: a0, endAngle: a1 }
    : { type: "ARC", layer: "", center: { ...c }, radius: r, startAngle: a1, endAngle: a0 };
}

/** Nearest segment of a polyline to a point (index + closest point + distance). */
export function nearestPolylineSegment(
  points: Pt[],
  p: Pt,
  closed = false,
): { index: number; point: Pt; distance: number } {
  let best = { index: 0, point: { ...points[0] }, distance: Infinity };
  const segCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = pt(a.x + dx * t, a.y + dy * t);
    const d = dist(p, q);
    if (d < best.distance) best = { index: i, point: q, distance: d };
  }
  return best;
}

/** Same-polyline adjacent-segment case: do both picks share one vertex? */
function sharedVertex(
  a: FilletOperand,
  b: FilletOperand,
): { vertex: number; segA: number; segB: number } | null {
  if (a.entity !== b.entity || a.entity.type !== "LWPOLYLINE") return null;
  const e = a.entity;
  if (e.closed) return null;
  const sa = a.segmentIndex ?? 0;
  const sb = b.segmentIndex ?? 0;
  if (sa === sb) return null;
  if (Math.abs(sa - sb) !== 1) return null;
  return { vertex: Math.max(sa, sb), segA: sa, segB: sb };
}

function dedupe<T>(list: T[]): T[] {
  return [...new Set(list)];
}

/** Same-entity guard: two picks on one entity are only meaningful for an
 * LWPOLYLINE (two different segments). Returns a rejection, or null. */
function sameEntityCheck(aOp: FilletOperand, bOp: FilletOperand, verb: string): FilletOutcome | null {
  if (aOp.entity !== bOp.entity) return null;
  const e = aOp.entity;
  if (e.type !== "LWPOLYLINE") {
    return { ok: false, reason: `${verb}: select two different objects.` };
  }
  const sa = aOp.segmentIndex ?? 0;
  const sb = bOp.segmentIndex ?? 0;
  if (sa === sb) {
    return { ok: false, reason: `${verb}: select two different objects.` };
  }
  const segCount = e.closed ? e.points.length : e.points.length - 1;
  const adjacent = Math.abs(sa - sb) === 1 || (e.closed && ((sa === 0 && sb === segCount - 1) || (sb === 0 && sa === segCount - 1)));
  if (adjacent && e.closed) {
    return {
      ok: false,
      reason: `${verb}: those two segments share a vertex of a closed polyline — splitting it there is not supported. Explode the polyline (XPLODEPL) and fillet the lines instead.`,
    };
  }
  return null;
}

/* ── FILLET ─────────────────────────────────────────────────────────────── */

export function filletEntities(
  aOp: FilletOperand,
  bOp: FilletOperand,
  radius: number,
  opts: FilletOptions,
): FilletOutcome {
  if (!Number.isFinite(radius) || radius < 0) {
    return { ok: false, reason: "FILLET: radius must be ≥ 0." };
  }
  const same = sameEntityCheck(aOp, bOp, "FILLET");
  if (same) return same;
  const c1 = curveOf(aOp);
  if (!isCurve(c1)) return c1;
  const c2 = curveOf(bOp);
  if (!isCurve(c2)) return c2;
  const split = sharedVertex(aOp, bOp);
  const corner = cornerPoint(c1.support, c2.support, aOp.pick, bOp.pick);

  // Radius 0: trim both operands square to the corner, no arc.
  if (radius <= EPS) {
    if (!corner || !c1.contains(corner) || !c2.contains(corner)) {
      return { ok: false, reason: "FILLET: those objects do not meet at a corner to trim square." };
    }
    if (split) return splitOutcome(aOp, bOp, split, corner, corner, null);
    return trimOutcome(aOp, bOp, c1, c2, corner, corner, null, opts.trim, corner);
  }

  const centers = filletCenters(c1.support, c2.support, radius);
  if (!centers.length) {
    return { ok: false, reason: "FILLET: no tangent arc of that radius touches both objects (they may be parallel)." };
  }
  const minKept = radius * 1e-3;
  let best: { c: Pt; t1: Pt; t2: Pt; score: number; pickScore: number } | null = null;
  for (const c of centers) {
    const t1 = tangentPoint(c1, c);
    const t2 = tangentPoint(c2, c);
    if (!t1 || !t2) continue;
    if (!c1.contains(t1) || !c2.contains(t2)) continue;
    // A zero-chord "fillet" is a circle through the corner tangent to both
    // curves at the corner itself — it trims nothing and adds a zero-length
    // arc. The tangent points must be distinct for a real fillet.
    if (dist(t1, t2) < 1e-9 * Math.max(1, radius)) continue;
    if (c1.along(t1, keptEnd(c1, t1, corner, t2)) < minKept || c2.along(t2, keptEnd(c2, t2, corner, t1)) < minKept) continue;
    const score = corner ? dist(c, corner) : dist(t1, aOp.pick) + dist(t2, bOp.pick);
    const pickScore = dist(t1, aOp.pick) + dist(t2, bOp.pick);
    // Nearest the corner wins; the picks break exact ties (crossing lines
    // have four tangent circles at the same distance from the corner, one
    // per quadrant — the picks say which quadrant the user meant).
    const better =
      !best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && pickScore < best.pickScore - 1e-9);
    if (better) best = { c, t1, t2, score, pickScore };
  }
  if (!best) {
    return { ok: false, reason: "FILLET: radius is too large for those objects — the tangent points fall outside them." };
  }
  const arc = arcNear(best.c, radius, best.t1, best.t2, corner ?? { x: (aOp.pick.x + bOp.pick.x) / 2, y: (aOp.pick.y + bOp.pick.y) / 2 });
  arc.layer = aOp.entity.layer;
  if (split) return splitOutcome(aOp, bOp, split, best.t1, best.t2, arc);
  return trimOutcome(aOp, bOp, c1, c2, best.t1, best.t2, arc, opts.trim, corner);
}

/**
 * Build the before/after lists for a trim (or no-trim) outcome. When both
 * operands are the same entity (non-adjacent segments of one polyline),
 * the two trims fold onto one copy: the second trim is re-derived from the
 * already-trimmed entity, so each vertex moves once.
 */
function trimOutcome(
  aOp: FilletOperand,
  bOp: FilletOperand,
  c1: Curve,
  c2: Curve,
  cut1: Pt,
  cut2: Pt,
  added: DxfEntity | null,
  trim: boolean,
  corner: Pt | null,
): FilletOutcome {
  const before = dedupe([aOp.entity, bOp.entity]);
  const addedKind = added ? ((added.type === "ARC" ? "ARC" : "LINE") as "ARC" | "LINE") : null;
  if (!trim) {
    const after = [...before];
    if (added) after.push(added);
    return { ok: true, before, after, addedKind };
  }
  if (aOp.entity === bOp.entity) {
    const first = c1.trimTo(cut1, keptEnd(c1, cut1, corner, cut2));
    if (!first) return { ok: false, reason: "FILLET / CHAMFER: those objects are too short to trim." };
    const c2b = curveOf({ entity: first, pick: bOp.pick, segmentIndex: bOp.segmentIndex });
    if (!isCurve(c2b)) return c2b;
    const second = c2b.trimTo(cut2, keptEnd(c2, cut2, corner, cut1));
    if (!second) return { ok: false, reason: "FILLET / CHAMFER: those objects are too short to trim." };
    const after = [second];
    if (added) after.push(added);
    return { ok: true, before, after, addedKind };
  }
  const t1 = c1.trimTo(cut1, keptEnd(c1, cut1, corner, cut2));
  const t2 = c2.trimTo(cut2, keptEnd(c2, cut2, corner, cut1));
  if (!t1 || !t2) return { ok: false, reason: "FILLET / CHAMFER: those objects are too short to trim." };
  const after = [t1, t2];
  if (added) after.push(added);
  return { ok: true, before, after, addedKind };
}

/**
 * Two adjacent segments of one open polyline: split the polyline at the
 * shared vertex into two open polylines (each trimmed to its cut point) and
 * bridge them with the arc / bar. No-trim keeps the polyline whole.
 */
function splitOutcome(
  aOp: FilletOperand,
  bOp: FilletOperand,
  split: { vertex: number; segA: number; segB: number },
  cutA: Pt,
  cutB: Pt,
  added: DxfEntity | null,
): FilletOutcome {
  const e = aOp.entity as Extract<DxfEntity, { type: "LWPOLYLINE" }>;
  const before = [aOp.entity];
  if (!added) {
    // Radius 0 with a split: both cuts are the corner itself, so the split
    // would produce two polylines meeting at the corner — the same shape
    // the polyline already has. Keep the polyline whole instead.
    return { ok: true, before, after: [aOp.entity], addedKind: null };
  }
  // cutA belongs to segA, cutB to segB. The lower-index segment is the
  // "before" piece, the higher-index one the "after" piece.
  const first = split.segA < split.segB ? { cut: cutA } : { cut: cutB };
  const second = split.segA < split.segB ? { cut: cutB } : { cut: cutA };
  const v = split.vertex;
  const head: DxfPoint[] = [...e.points.slice(0, v), { ...first.cut }];
  const tail: DxfPoint[] = [{ ...second.cut }, ...e.points.slice(v + 1)];
  if (head.length < 2 || tail.length < 2) {
    return { ok: false, reason: "FILLET / CHAMFER: that polyline vertex is too close to an end to fillet." };
  }
  const headEnt: DxfEntity = { ...e, points: head, native: undefined, nativeSig: undefined };
  const tailEnt: DxfEntity = { ...e, points: tail, native: undefined, nativeSig: undefined };
  return {
    ok: true,
    before,
    after: [headEnt, tailEnt, added],
    addedKind: added.type === "ARC" ? "ARC" : "LINE",
  };
}

/**
 * The chamfer cut point: distance d from the corner toward the far end.
 * Arcs walk along the sweep and stay on the span; lines / polyline
 * segments are measured on the infinite line, so a cut short of the
 * trimmed-away near end extends the line back out to the cut point.
 */
function chamferCut(curve: Curve, corner: Pt, far: Pt, d: number): Pt | null {
  if (curve.kind === "ARC") return curve.walk(corner, far, d);
  const total = dist(corner, far);
  if (total < EPS || d > total + 1e-9) return null;
  const u = unit(sub(far, corner));
  return pt(corner.x + u.x * d, corner.y + u.y * d);
}

/* ── CHAMFER ────────────────────────────────────────────────────────────── */

export function chamferEntities(
  aOp: FilletOperand,
  bOp: FilletOperand,
  d1: number,
  d2: number,
  opts: FilletOptions,
): FilletOutcome {
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || !(d1 > 0) || !(d2 > 0)) {
    return { ok: false, reason: "CHAMFER: distances must be greater than zero." };
  }
  const same = sameEntityCheck(aOp, bOp, "CHAMFER");
  if (same) return same;
  const c1 = curveOf(aOp);
  if (!isCurve(c1)) return c1;
  const c2 = curveOf(bOp);
  if (!isCurve(c2)) return c2;
  const split = sharedVertex(aOp, bOp);
  const corner = cornerPoint(c1.support, c2.support, aOp.pick, bOp.pick);
  if (!corner) {
    return { ok: false, reason: "CHAMFER: those objects do not meet — chamfer distances are measured from where they intersect." };
  }
  // An ARC must actually reach the corner: its distances are measured
  // along the sweep, which is undefined past the arc's ends. A LINE or
  // polyline segment may already have been trimmed past the corner (e.g.
  // by an earlier fillet) — AutoCAD then measures from the corner where
  // the extensions meet, and extends the line to the cut point if the
  // distance is shorter than the trimmed-away part.
  if ((c1.kind === "ARC" && !c1.contains(corner)) || (c2.kind === "ARC" && !c2.contains(corner))) {
    return { ok: false, reason: "CHAMFER: those objects do not meet at a corner on the picked spans." };
  }
  const far1 = keptEnd(c1, corner, corner, corner);
  const far2 = keptEnd(c2, corner, corner, corner);
  const len1 = c1.along(corner, far1);
  const len2 = c2.along(corner, far2);
  if (d1 > len1 + 1e-9 || d2 > len2 + 1e-9) {
    return { ok: false, reason: "CHAMFER: distances are too large for those objects." };
  }
  const cut1 = chamferCut(c1, corner, far1, d1);
  const cut2 = chamferCut(c2, corner, far2, d2);
  if (!cut1 || !cut2) {
    return { ok: false, reason: "CHAMFER: distances are too large for those objects." };
  }
  const bar: Extract<DxfEntity, { type: "LINE" }> = {
    type: "LINE",
    layer: aOp.entity.layer,
    start: { ...cut1 },
    end: { ...cut2 },
  };
  if (split) return splitOutcome(aOp, bOp, split, cut1, cut2, bar);
  return trimOutcome(aOp, bOp, c1, c2, cut1, cut2, bar, opts.trim, corner);
}

/* ── In-tool option parsing ─────────────────────────────────────────────── */

/**
 * What the viewer should do with one command-line entry typed while a
 * FILLET / CHAMFER pick is active. This is the prompting state machine,
 * testable without a browser: bare numbers never reach it (they go to the
 * pendingNumeric radius / distance handler), only the option keywords do.
 *
 *   FILLET:  R [value] — (re-)prompt / set the radius; T — toggle Trim;
 *            TRIM / NOTRIM — set Trim explicitly.
 *   CHAMFER: D [d1 [d2]] — (re-)prompt / set the distances; T / TRIM /
 *            NOTRIM — as above.
 */
export type PromptAction =
  | { action: "promptRadius" }
  | { action: "setRadius"; value: number }
  | { action: "promptDistances" }
  | { action: "setDistance1"; value: number }
  | { action: "setDistances"; d1: number; d2: number }
  | { action: "toggleTrim" }
  | { action: "setTrim"; value: boolean }
  | { action: "invalid"; message: string }
  | { action: "none" };

export function parseFilletChamferOption(raw: string, kind: "fillet" | "chamfer"): PromptAction {
  const tokens = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { action: "none" };
  const head = tokens[0];
  const num = (i: number): number | null => {
    const v = Number(tokens[i]);
    return tokens[i] !== undefined && Number.isFinite(v) ? v : null;
  };
  if (head === "T") return { action: "toggleTrim" };
  if (head === "TRIM") return { action: "setTrim", value: true };
  if (head === "NOTRIM") return { action: "setTrim", value: false };
  if (kind === "fillet") {
    if (head === "R" || head === "RADIUS") {
      if (tokens.length === 1) return { action: "promptRadius" };
      const v = num(1);
      if (v === null || v < 0) return { action: "invalid", message: "FILLET: radius must be ≥ 0." };
      return { action: "setRadius", value: v };
    }
    return { action: "none" };
  }
  // chamfer
  if (head === "D" || head === "DISTANCE" || head === "DIST") {
    if (tokens.length === 1) return { action: "promptDistances" };
    const v1 = num(1);
    if (v1 === null || v1 <= 0) return { action: "invalid", message: "CHAMFER: distances must be greater than zero." };
    if (tokens.length === 2) return { action: "setDistance1", value: v1 };
    const v2 = num(2);
    if (v2 === null || v2 <= 0) return { action: "invalid", message: "CHAMFER: distances must be greater than zero." };
    return { action: "setDistances", d1: v1, d2: v2 };
  }
  return { action: "none" };
}
