/**
 * CAD Editor — Modify Math (MOVE / COPY / ROTATE / MIRROR / SCALE / OFFSET and
 * the cutting tools: TRIM / EXTEND / BREAK / FILLET / CHAMFER / JOIN / STRETCH,
 * plus SPLINE / POLYGON / ELLIPSE / DONUT loop builders).
 *
 * Pure geometry helpers that transform or decompose `DxfEntity` objects. Every
 * function is immutable: it returns NEW entity objects and never mutates its
 * input, so the viewer's undo stack can snapshot `before` / `after` references.
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
    case "RAY":
    case "XLINE":
      // The anchor moves; the direction is relative and unchanged.
      return { ...e, start: translatePt(e.start, dx, dy) };
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
    case "RAY":
    case "XLINE": {
      // Rotate the anchor and swing the direction vector with it.
      const d = e.direction;
      return {
        ...e,
        start: rotatePt(e.start, { x: cx, y: cy }, rad),
        direction: {
          x: d.x * Math.cos(rad) - d.y * Math.sin(rad),
          y: d.x * Math.sin(rad) + d.y * Math.cos(rad),
        },
      };
    }
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
    case "RAY":
    case "XLINE": {
      // Mirror the anchor and reflect the direction through it.
      const s = mirrorPt(e.start, a, b);
      const tip = mirrorPt({ x: e.start.x + e.direction.x, y: e.start.y + e.direction.y }, a, b);
      return { ...e, start: s, direction: { x: tip.x - s.x, y: tip.y - s.y } };
    }
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
    case "RAY":
    case "XLINE":
      // Scale the anchor; a uniform scale leaves the direction parallel.
      return { ...e, start: scalePt(e.start, { x: cx, y: cy }, k) };
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
 * Curve-aware offset for polylines (kernel-style "offset with trim", absorbed
 * from the OpenCADStudio geometry-kernel approach — opencadkernel is MPL-2.0
 * and only informed the algorithm; this is an independent TS implementation):
 *
 *  1. every segment is offset by `d` on the picked side;
 *  2. adjacent offset segments are joined by infinite-line INTERSECTION, so
 *     corners are extended/trimmed exactly like DWG (no bisector overshoot
 *     on dense arc approximations — the join lands on the true offset);
 *  3. tangential/parallel joins fall back to the shared offset endpoint;
 *  4. joins further than 4·d from the source vertex (very shallow angle spikes)
 *     clamp to the classic miter cap, matching DWG's default 4× mitre limit;
 *  5. a closed loop whose offset flips orientation (the shape collapsed
 *     inward past its centroid) is refused with null — DWG's "cannot
 *     offset that" for inner offsets of circles and thin shapes.
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
    const m = closed ? n : n - 1;
    // Unit direction per segment; zero for degenerate (zero-length) ones.
    const dirs: Pt[] = [];
    for (let i = 0; i < m; i++) {
      const b = loop[(i + 1) % n];
      const dx = b.x - loop[i].x,
        dy = b.y - loop[i].y;
      const len = Math.hypot(dx, dy);
      dirs.push(len < 1e-12 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len });
    }
    // Decide global side from the first non-degenerate segment.
    let s = 1;
    for (let i = 0; i < m; i++) {
      if (dirs[i].x || dirs[i].y) {
        s = isLeft(side, loop[i], loop[(i + 1) % n]) ? 1 : -1;
        break;
      }
    }
    // Offset endpoints per segment: a→b shifted by d along the left-hand normal.
    const offA: Pt[] = [],
      offB: Pt[] = [];
    for (let i = 0; i < m; i++) {
      const dx = -dirs[i].y * d * s,
        dy = dirs[i].x * d * s;
      offA.push(P(loop[i].x + dx, loop[i].y + dy));
      offB.push(P(loop[(i + 1) % n].x + dx, loop[(i + 1) % n].y + dy));
    }
    const capDist = 4 * Math.abs(d); // DWG's default mitre ratio
    const out: DxfPoint[] = [];
    const join = (i: number, prev: number): DxfPoint => {
      const d1 = dirs[prev],
        d2 = dirs[i];
      if (!d1.x && !d1.y) return offA[i];
      if (!d2.x && !d2.y) return offB[prev];
      const den = d1.x * d2.y - d1.y * d2.x;
      let p: Pt;
      if (Math.abs(den) < 1e-12) {
        // Parallel / tangential continuation: endpoints already coincide.
        p = P((offB[prev].x + offA[i].x) / 2, (offB[prev].y + offA[i].y) / 2);
      } else {
        // Infinite-line intersection of the two offset segments.
        const t =
          ((offA[i].x - offA[prev].x) * d2.y - (offA[i].y - offA[prev].y) * d2.x) / den;
        p = P(offA[prev].x + t * d1.x, offA[prev].y + t * d1.y);
      }
      // Spike clamp: beyond the mitre cap fall back to the bisector join.
      if (Math.hypot(p.x - loop[i].x, p.y - loop[i].y) > capDist) {
        const bx = d1.x + d2.x,
          by = d1.y + d2.y;
        const bl = Math.hypot(bx, by);
        const nx = bl < 1e-9 ? d2.x : bx / bl,
          ny = bl < 1e-9 ? d2.y : by / bl;
        const cos = Math.max(0.25, nx * d1.x + ny * d1.y);
        const mlen = (d * s) / cos;
        p = P(loop[i].x + nx * mlen, loop[i].y + ny * mlen);
      }
      return p;
    };
    if (!closed) {
      out.push(offA[0]);
      for (let i = 1; i < n - 1; i++) out.push(join(i, i - 1));
      out.push(offB[m - 1]);
    } else {
      for (let i = 0; i < n; i++) out.push(join(i, (i - 1 + m) % m));
    }
    // Collapse detection on the JOINED loop: an inward offset that ends up
    // covering more (signed) area than the source has folded past the
    // centroid — DWG refuses with "cannot offset that". Outward offsets
    // legitimately grow, so only the inward direction is checked.
    if (closed) {
      const a0 = signedArea(loop);
      const a1 = signedArea(out);
      const inward = Math.sign(s) === Math.sign(a0); // left of CCW edges = inside
      if ((inward && Math.abs(a1) >= Math.abs(a0)) || a0 * a1 < 0) return null;
    }
    return out;
  };

  const pts = off(e.points);
  if (!pts) return null;
  const hatch = e.hatch ? { ...e.hatch, loops: e.hatch.loops.map((l) => off(l)).filter((l): l is DxfPoint[] => !!l) } : undefined;
  return { ...e, points: pts, hatch };
}

/** Signed area of a closed loop (positive = counter-clockwise). */
function signedArea(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i],
      q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Intersections (TRIM / EXTEND / BREAK / FILLET foundation)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Intersection of the finite segments a1→a2 and b1→b2 (0, 1 or 2 coincident → 1). */
export function segSegX(a1: Pt, a2: Pt, b1: Pt, b2: Pt, eps = 1e-9): Pt[] {
  const d1x = a2.x - a1.x,
    d1y = a2.y - a1.y,
    d2x = b2.x - b1.x,
    d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < eps) return [];
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return [];
  return [{ x: a1.x + t * d1x, y: a1.y + t * d1y }];
}

/** Intersections of the finite segment a→b with the circle (c, r). */
export function segCircleX(a: Pt, b: Pt, c: Pt, r: number, eps = 1e-9): Pt[] {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const fx = a.x - c.x,
    fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  if (A < eps) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out: Pt[] = [];
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t >= -eps && t <= 1 + eps) out.push({ x: a.x + t * dx, y: a.y + t * dy });
  }
  return out;
}

/** True when `deg` lies on the CCW sweep startAngle→endAngle of an arc. */
export function arcHasDeg(startDeg: number, endDeg: number, deg: number, eps = 1e-6): boolean {
  const n = (a: number): number => ((a % 360) + 360) % 360;
  const sweep = n(endDeg - startDeg) || 360;
  const off = n(deg - startDeg);
  return off <= sweep + eps;
}

const angleDeg = (c: Pt, p: Pt): number => Math.atan2(p.y - c.y, p.x - c.x) * RAD;

/** Segment approximations of an entity's drawable geometry. */
export function entitySegments(e: DxfEntity): Array<[Pt, Pt]> {
  switch (e.type) {
    case "LINE":
      return [[e.start, e.end]];
    case "LWPOLYLINE": {
      const n = e.points.length;
      if (n < 2) return [];
      const m = e.closed ? n : n - 1;
      const segs: Array<[Pt, Pt]> = [];
      for (let i = 0; i < m; i++) segs.push([e.points[i], e.points[(i + 1) % n]]);
      return segs;
    }
    default:
      return [];
  }
}

/** All intersections between two entities (segments, circles and arcs). */
export function entIntersections(e1: DxfEntity, e2: DxfEntity, eps = 1e-7): Pt[] {
  const out: Pt[] = [];
  const circ: Array<[Pt, number, number, number]> = []; // center, r, startDeg, sweepDeg (360 = full circle)
  const arcInfo = (e: DxfEntity): [Pt, number, number, number] | null => {
    if (e.type === "CIRCLE") return [e.center, e.radius, 0, 360];
    if (e.type === "ARC") {
      const sweep = ((e.endAngle - e.startAngle) % 360 + 360) % 360 || 360;
      return [e.center, e.radius, e.startAngle, sweep];
    }
    return null;
  };
  const pushCirc = (e: DxfEntity) => {
    const ci = arcInfo(e);
    if (ci) circ.push(ci);
  };
  pushCirc(e1);
  pushCirc(e2);
  const inArc = (ci: [Pt, number, number, number], p: Pt): boolean => {
    const [, , startDeg, sweep] = ci;
    if (sweep >= 360 - 1e-9) return true;
    return arcHasDeg(startDeg, startDeg + sweep, angleDeg(ci[0], p));
  };
  // segment × segment
  for (const s1 of entitySegments(e1))
    for (const s2 of entitySegments(e2)) out.push(...segSegX(s1[0], s1[1], s2[0], s2[1], eps));
  // segment × circle/arc
  const segEnts = [e1, e2];
  for (const se of segEnts)
    for (const [a, b] of entitySegments(se))
      for (const ci of circ) {
        for (const p of segCircleX(a, b, ci[0], ci[1], eps)) {
          // dedupe: segment belongs to this circle's entity — skip arc filter for own pairs
          if (!out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)) out.push(p);
        }
      }
  // arc filters applied after collecting seg×circ hits (segment may pair with the OTHER entity)
  // circle/arc × circle/arc
  if (circ.length === 2) {
    const [c1, r1, s1, w1] = circ[0];
    const [c2, r2, s2] = circ[1];
    const dx = c2.x - c1.x,
      dy = c2.y - c1.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-9 && d <= r1 + r2 + 1e-9 && d >= Math.abs(r1 - r2) - 1e-9) {
      const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
      const h2 = r1 * r1 - a * a;
      const h = h2 > 0 ? Math.sqrt(h2) : 0;
      const mx = c1.x + (a * dx) / d,
        my = c1.y + (a * dy) / d;
      for (const sgn of [1, -1]) {
        const p = { x: mx - (sgn * h * dy) / d, y: my + (sgn * h * dx) / d };
        const on1 = inArc(circ[0], p);
        const on2 = inArc([c2, r2, s2, ((arcInfo(e2)?.[3] ?? 360))], p);
        if (on1 && on2 && !out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)) out.push(p);
      }
    }
  }
  // Apply arc membership filter for seg×circ results: a hit only counts when it
  // lies on BOTH entities' curved geometry it touched. Simplified: keep hits that
  // lie on every arc entity involved when the segment pair produced them.
  if (circ.length) {
    return out.filter((p) => {
      for (const e of [e1, e2]) {
        const ai = arcInfo(e);
        if (ai && ai[3] < 360 - 1e-9) {
          const onCurve = Math.abs(Math.hypot(p.x - ai[0].x, p.y - ai[0].y) - ai[1]) < 1e-6;
          if (onCurve && !inArc(ai, p)) return false;
        }
      }
      return true;
    });
  }
  return out;
}

/** Distance from p to segment a→b. */
export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** True when p sits within `tol` of the entity's geometry. */
export function pointOnEntity(e: DxfEntity, p: Pt, tol: number): boolean {
  switch (e.type) {
    case "LINE":
      return distToSeg(p, e.start, e.end) <= tol;
    case "LWPOLYLINE":
      return entitySegments(e).some(([a, b]) => distToSeg(p, a, b) <= tol);
    case "CIRCLE":
      return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius) <= tol;
    case "ARC": {
      if (Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius) > tol) return false;
      return arcHasDeg(e.startAngle, e.endAngle, angleDeg(e.center, p), Math.max(0.5, (tol / Math.max(e.radius, 1e-9)) * RAD));
    }
    default:
      return false;
  }
}

/** Normalized position (0..1) of point p along the entity's path. */
export function paramAlong(e: DxfEntity, p: Pt): number {
  switch (e.type) {
    case "LINE": {
      const dx = e.end.x - e.start.x,
        dy = e.end.y - e.start.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return 0;
      return Math.max(0, Math.min(1, ((p.x - e.start.x) * dx + (p.y - e.start.y) * dy) / len2));
    }
    case "LWPOLYLINE": {
      const segs = entitySegments(e);
      if (!segs.length) return 0;
      let total = 0,
        acc = 0,
        best = 0,
        bestD = Infinity;
      for (const [a, b] of segs) {
        const d = distToSeg(p, a, b);
        if (d < bestD) {
          bestD = d;
          best = acc + Math.hypot(p.x - a.x, p.y - a.y);
        }
        acc += Math.hypot(b.x - a.x, b.y - a.y);
      }
      total = acc;
      return total > 1e-12 ? Math.max(0, Math.min(1, best / total)) : 0;
    }
    case "CIRCLE":
      return ((angleDeg(e.center, p) % 360) + 360) % 360 / 360;
    case "ARC": {
      const sweep = ((e.endAngle - e.startAngle) % 360 + 360) % 360 || 360;
      const off = ((angleDeg(e.center, p) - e.startAngle) % 360 + 360) % 360;
      return Math.max(0, Math.min(1, off / sweep));
    }
    default:
      return 0;
  }
}

const lineEnt = (e: DxfEntity): e is Extract<DxfEntity, { type: "LINE" }> => e.type === "LINE";

/**
 * TRIM: split `e` at every intersection with the cutting entities and remove
 * the piece that contains `click`. Returns the remaining pieces (0–2 for a
 * LINE, 1–2 polylines for a picked LWPOLYLINE segment); [] when nothing to trim.
 */
export function trimEntity(e: DxfEntity, click: Pt, cutters: DxfEntity[], eps = 1e-7): DxfEntity[] {
  if (lineEnt(e)) {
    const xs: number[] = [];
    for (const c of cutters) {
      if (c === e) continue;
      for (const p of entIntersections(e, c, eps)) {
        const t = paramAlong(e, p);
        if (t > 1e-6 && t < 1 - 1e-6) xs.push(t);
      }
    }
    if (!xs.length) return [];
    const tc = paramAlong(e, click);
    xs.sort((a, b) => a - b);
    // Find the cut span that contains the click: (prevX, nextX) — 0/1 act as ends.
    let lo = 0,
      hi = 1;
    for (const t of xs) {
      if (t < tc) lo = Math.max(lo, t);
      if (t > tc) {
        hi = t;
        break;
      }
    }
    if (tc < xs[0]) {
      hi = xs[0];
      lo = 0;
    } else if (tc > xs[xs.length - 1]) {
      lo = xs[xs.length - 1];
      hi = 1;
    }
    const at = (t: number) => ({ x: e.start.x + (e.end.x - e.start.x) * t, y: e.start.y + (e.end.y - e.start.y) * t });
    const pieces: DxfEntity[] = [];
    if (lo > 1e-6) pieces.push({ ...e, start: e.start, end: at(lo) });
    if (hi < 1 - 1e-6) pieces.push({ ...e, start: at(hi), end: e.end });
    return pieces;
  }
  if (e.type === "LWPOLYLINE") {
    const segs = entitySegments(e);
    // Which segment was clicked?
    let k = -1,
      kd = Infinity;
    segs.forEach(([a, b], i) => {
      const d = distToSeg(click, a, b);
      if (d < kd) {
        kd = d;
        k = i;
      }
    });
    if (k < 0) return [];
    const [sa, sb] = segs[k];
    const xs: number[] = [];
    for (const c of cutters) {
      if (c === e) continue;
      for (const p of entIntersections(e, c, eps)) {
        if (distToSeg(p, sa, sb) > 1e-6) continue;
        const t = paramAlong(e, p);
        xs.push(t);
      }
    }
    const t0 = paramAlong(e, sa),
      t1 = paramAlong(e, sb);
    const tc = paramAlong(e, click);
    const inside = xs.filter((t) => t > Math.min(t0, t1) + 1e-9 && t < Math.max(t0, t1) - 1e-9);
    const lo = inside.filter((t) => t < tc).sort((a, b) => a - b).pop() ?? Math.min(t0, t1);
    const hi = inside.filter((t) => t > tc).sort((a, b) => a - b)[0] ?? Math.max(t0, t1);
    const n = e.points.length;
    // Walk the polyline path (segment lengths) to the point at param t.
    const atT = (t: number): Pt => {
      const segs2 = entitySegments(e);
      let acc = 0;
      for (const [a, b] of segs2) {
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (l > 1e-12 && t >= acc - 1e-12 && t <= acc + l + 1e-12) {
          const f = (t - acc) / l;
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        }
        acc += l;
      }
      return { ...e.points[e.points.length - 1] };
    };
    // Build piece A: verts before the removed span + the cut point at `lo`;
    // piece B: the cut point at `hi` + verts after it.
    const pieceA: DxfPoint[] = [];
    const pieceB: DxfPoint[] = [];
    const vertT = e.points.map((q) => paramAlong(e, q));
    const aEnd = lo,
      bStart = hi;
    for (let i = 0; i < n; i++) {
      const vt = vertT[i];
      if (vt <= aEnd + 1e-9) pieceA.push(e.points[i]);
      if (vt >= bStart - 1e-9) pieceB.push(e.points[i]);
    }
    const out: DxfEntity[] = [];
    if (pieceA.length >= 2) {
      const pts = [...pieceA];
      const pa = atT(aEnd);
      if (!pts.some((q) => Math.hypot(q.x - pa.x, q.y - pa.y) < 1e-9)) pts.push(pa);
      out.push({ ...e, points: pts, closed: false, hatch: undefined });
    }
    if (pieceB.length >= 2) {
      const pts = [...pieceB];
      const pb = atT(bStart);
      if (!pts.some((q) => Math.hypot(q.x - pb.x, q.y - pb.y) < 1e-9)) pts.unshift(pb);
      out.push({ ...e, points: pts, closed: false, hatch: undefined });
    }
    return out;
  }
  return [];
}

/**
 * EXTEND: stretch the clicked end of `e` to the nearest intersection with the
 * boundary entities. Returns the extended entity or null when no boundary hit.
 */
export function extendEntity(e: DxfEntity, click: Pt, boundaries: DxfEntity[], eps = 1e-7): DxfEntity | null {
  const tryEnd = (from: Pt, dir: Pt, back: (p: Pt) => DxfEntity | null): DxfEntity | null => {
    const far = Math.hypot(dir.x, dir.y) || 1;
    const tip = { x: from.x + (dir.x / far) * 1e9, y: from.y + (dir.y / far) * 1e9 };
    let best: Pt | null = null;
    for (const b of boundaries) {
      if (b === e) continue;
      for (const p of entIntersections({ ...e, start: from, end: tip } as DxfEntity, b, eps)) {
        const d = Math.hypot(p.x - from.x, p.y - from.y);
        if (d > 1e-6 && (!best || d < Math.hypot(best.x - from.x, best.y - from.y))) best = p;
      }
    }
    return best ? back(best) : null;
  };
  if (lineEnt(e)) {
    const dS = Math.hypot(click.x - e.start.x, click.y - e.start.y);
    const dE = Math.hypot(click.x - e.end.x, click.y - e.end.y);
    const dirS = { x: e.start.x - e.end.x, y: e.start.y - e.end.y };
    const dirE = { x: e.end.x - e.start.x, y: e.end.y - e.start.y };
    return dS <= dE
      ? tryEnd(e.start, dirS, (p) => ({ ...e, start: p }))
      : tryEnd(e.end, dirE, (p) => ({ ...e, end: p }));
  }
  if (e.type === "LWPOLYLINE") {
    const n = e.points.length;
    if (n < 2 || e.closed) return null;
    const dF = Math.hypot(click.x - e.points[0].x, click.y - e.points[0].y);
    const dL = Math.hypot(click.x - e.points[n - 1].x, click.y - e.points[n - 1].y);
    if (dF <= dL) {
      const dir = { x: e.points[0].x - e.points[1].x, y: e.points[0].y - e.points[1].y };
      return tryEnd(e.points[0], dir, (p) => ({ ...e, points: [p, ...e.points.slice(1)] }));
    }
    const dir = { x: e.points[n - 1].x - e.points[n - 2].x, y: e.points[n - 1].y - e.points[n - 2].y };
    return tryEnd(e.points[n - 1], dir, (p) => ({ ...e, points: [...e.points.slice(0, n - 1), p] }));
  }
  return null;
}

/**
 * BREAK: remove the portion of `e` between the two picked points (params
 * sorted). Returns the two remaining pieces, or null when nothing remains.
 */
export function breakEntity(e: DxfEntity, p1: Pt, p2: Pt): DxfEntity[] | null {
  if (lineEnt(e)) {
    let t1 = paramAlong(e, p1),
      t2 = paramAlong(e, p2);
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t2 - t1 < 1e-9) return null;
    const at = (t: number) => ({ x: e.start.x + (e.end.x - e.start.x) * t, y: e.start.y + (e.end.y - e.start.y) * t });
    const out: DxfEntity[] = [];
    if (t1 > 1e-6) out.push({ ...e, end: at(t1) });
    if (t2 < 1 - 1e-6) out.push({ ...e, start: at(t2) });
    return out.length ? out : null;
  }
  if (e.type === "LWPOLYLINE" && !e.closed) {
    let t1 = paramAlong(e, p1),
      t2 = paramAlong(e, p2);
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t2 - t1 < 1e-9) return null;
    const vertT = e.points.map((q) => paramAlong(e, q));
    const A: DxfPoint[] = [],
      B: DxfPoint[] = [];
    e.points.forEach((q, i) => {
      if (vertT[i] <= t1 + 1e-9) A.push(q);
      if (vertT[i] >= t2 - 1e-9) B.push(q);
    });
    if (A.length < 2 && B.length < 2) return null;
    const out: DxfEntity[] = [];
    if (A.length >= 2) out.push({ ...e, points: A, hatch: undefined });
    if (B.length >= 2) out.push({ ...e, points: B, hatch: undefined });
    return out.length ? out : null;
  }
  return null;
}

/* ── FILLET / CHAMFER (two lines) ─────────────────────────────────────────── */

const lineDir = (l: Extract<DxfEntity, { type: "LINE" }>): Pt => {
  const dx = l.end.x - l.start.x,
    dy = l.end.y - l.start.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
};

/** Intersection of two infinite lines through a1→a2 and b1→b2; null when parallel. */
function infiniteX(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const [p] = segSegX(a1, a2, b1, b2);
  if (p) return p;
  const d1x = a2.x - a1.x,
    d1y = a2.y - a1.y,
    d2x = b2.x - b1.x,
    d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/** Infinite-line intersection of two LINE entities; null when parallel. */
function lineLineX(l1: Extract<DxfEntity, { type: "LINE" }>, l2: Extract<DxfEntity, { type: "LINE" }>): Pt | null {
  return infiniteX(l1.start, l1.end, l2.start, l2.end);
}

/**
 * FILLET of two LINE entities with radius r: trims both back to their tangent
 * points and returns the tangent arc. r/tan(θ/2) is the tangent offset from
 * the corner. Null when r is too large for either line or the lines are parallel.
 */
export function filletTwoLines(
  l1: Extract<DxfEntity, { type: "LINE" }>,
  l2: Extract<DxfEntity, { type: "LINE" }>,
  r: number,
): { lines: [DxfEntity, DxfEntity]; arc: Extract<DxfEntity, { type: "ARC" }> } | null {
  if (!(r > 1e-9)) return null;
  const P = lineLineX(l1, l2);
  if (!P) return null;
  const d1 = lineDir(l1),
    d2 = lineDir(l2);
  const cosHalf = Math.sqrt((1 + (d1.x * d2.x + d1.y * d2.y)) / 2); // cos(θ/2)
  if (cosHalf < 1e-6) return null;
  // Offset both lines by r toward each other; the fillet center is the corner
  // candidate whose tangent points (projections onto the lines) fall inside
  // both segments — the nearest-to-P candidate as a fallback.
  const n1 = { x: -d1.y, y: d1.x },
    n2 = { x: -d2.y, y: d2.x };
  const within = (l: Extract<DxfEntity, { type: "LINE" }>, p: Pt): boolean => {
    const dx = l.end.x - l.start.x,
      dy = l.end.y - l.start.y;
    const t = ((p.x - l.start.x) * dx + (p.y - l.start.y) * dy) / Math.max(1e-12, dx * dx + dy * dy);
    return t >= -1e-6 && t <= 1 + 1e-6;
  };
  let best: Pt | null = null;
  let bestIn = false;
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      const c = infiniteX(
        { x: l1.start.x + n1.x * r * s1, y: l1.start.y + n1.y * r * s1 },
        { x: l1.end.x + n1.x * r * s1, y: l1.end.y + n1.y * r * s1 },
        { x: l2.start.x + n2.x * r * s2, y: l2.start.y + n2.y * r * s2 },
        { x: l2.end.x + n2.x * r * s2, y: l2.end.y + n2.y * r * s2 },
      );
      if (!c) continue;
      const inSeg = within(l1, c) && within(l2, c);
      if (best == null || (inSeg && !bestIn) || (inSeg === bestIn && Math.hypot(c.x - P.x, c.y - P.y) < Math.hypot(best.x - P.x, best.y - P.y))) {
        best = c;
        bestIn = inSeg;
      }
    }
  if (!best) return null;
  const C = best;
  const proj = (l: Extract<DxfEntity, { type: "LINE" }>): Pt => {
    const dx = l.end.x - l.start.x,
      dy = l.end.y - l.start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return { ...l.start };
    const t = Math.max(0, Math.min(1e9, ((C.x - l.start.x) * dx + (C.y - l.start.y) * dy) / len2));
    return { x: l.start.x + dx * t, y: l.start.y + dy * t };
  };
  const TA = proj(l1);
  const TB = proj(l2);
  const farA = Math.hypot(l1.start.x - P.x, l1.start.y - P.y) > Math.hypot(l1.end.x - P.x, l1.end.y - P.y) ? l1.start : l1.end;
  const farB = Math.hypot(l2.start.x - P.x, l2.start.y - P.y) > Math.hypot(l2.end.x - P.x, l2.end.y - P.y) ? l2.start : l2.end;
  const na = { ...l1, start: farA, end: TA };
  const nb = { ...l2, start: farB, end: TB };
  if (Math.hypot(na.end.x - na.start.x, na.end.y - na.start.y) < r * 1e-3) return null;
  if (Math.hypot(nb.end.x - nb.start.x, nb.end.y - nb.start.y) < r * 1e-3) return null;
  const a0 = angleDeg(C, TA);
  const a1 = angleDeg(C, TB);
  // DXF arcs sweep CCW from start to end — pick the pair whose sweep stays near the corner.
  const midOf = (s: number, e: number): number => s + (((e - s) % 360) + 360) % 360 / 2;
  const mid1 = midOf(a0, a1);
  const mid2 = midOf(a1, a0);
  const pm1 = { x: C.x + r * Math.cos(mid1 * DEG), y: C.y + r * Math.sin(mid1 * DEG) };
  const pm2 = { x: C.x + r * Math.cos(mid2 * DEG), y: C.y + r * Math.sin(mid2 * DEG) };
  const dPm1 = Math.hypot(pm1.x - P.x, pm1.y - P.y);
  const dPm2 = Math.hypot(pm2.x - P.x, pm2.y - P.y);
  const arc: Extract<DxfEntity, { type: "ARC" }> =
    dPm1 <= dPm2
      ? { type: "ARC", layer: l1.layer, center: C, radius: r, startAngle: a0, endAngle: a1 }
      : { type: "ARC", layer: l1.layer, center: C, radius: r, startAngle: a1, endAngle: a0 };
  return { lines: [na, nb], arc };
}

/**
 * CHAMFER of two LINE entities: bevels the corner at distance d1 along l1 and
 * d2 along l2 (measured from the corner). Returns the two trimmed lines and
 * the connecting bar.
 */
export function chamferTwoLines(
  l1: Extract<DxfEntity, { type: "LINE" }>,
  l2: Extract<DxfEntity, { type: "LINE" }>,
  d1: number,
  d2: number,
): { lines: [DxfEntity, DxfEntity]; bar: Extract<DxfEntity, { type: "LINE" }> } | null {
  if (!(d1 > 0 && d2 > 0)) return null;
  const P = lineLineX(l1, l2);
  if (!P) return null;
  const sA = Math.hypot(l1.start.x - P.x, l1.start.y - P.y) > Math.hypot(l1.end.x - P.x, l1.end.y - P.y) ? l1.start : l1.end;
  const sB = Math.hypot(l2.start.x - P.x, l2.start.y - P.y) > Math.hypot(l2.end.x - P.x, l2.end.y - P.y) ? l2.start : l2.end;
  // Tangent points sit at d1 / d2 from the corner P, along each line toward
  // its far endpoint; the trimmed lines keep everything beyond the tangent.
  const along = (far: Pt, d: number): Pt => {
    const dx = far.x - P.x,
      dy = far.y - P.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: P.x + (dx / len) * d, y: P.y + (dy / len) * d };
  };
  const TApt = along(sA, d1);
  const TBpt = along(sB, d2);
  const na = { ...l1, start: sA, end: TApt };
  const nb = { ...l2, start: sB, end: TBpt };
  if (Math.hypot(na.end.x - na.start.x, na.end.y - na.start.y) < 1e-9) return null;
  if (Math.hypot(nb.end.x - nb.start.x, nb.end.y - nb.start.y) < 1e-9) return null;
  return { lines: [na, nb], bar: { type: "LINE", layer: l1.layer, start: TApt, end: TBpt } };
}

/* ── JOIN / SPLINE / shape loops ──────────────────────────────────────────── */

/**
 * JOIN: chain open LINE / LWPOLYLINE entities into one polyline. Returns null
 * when fewer than two connectable entities are given or the chain is broken.
 */
export function chainPolyline(list: DxfEntity[], closed = false): DxfEntity | null {
  const ok = list.filter((e): e is Extract<DxfEntity, { type: "LINE" | "LWPOLYLINE" }> =>
    e.type === "LINE" || (e.type === "LWPOLYLINE" && !e.closed && !e.hatch),
  );
  if (ok.length < 2) return null;
  const chains: DxfPoint[][] = ok.map((e) => (e.type === "LINE" ? [e.start, e.end] : [...e.points]));
  const merged: DxfPoint[] = chains.shift()!;
  let progress = true;
  while (chains.length && progress) {
    progress = false;
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      const tail = merged[merged.length - 1];
      const head = merged[0];
      const dEnd = (p: Pt): number => Math.min(Math.hypot(p.x - tail.x, p.y - tail.y), Math.hypot(p.x - head.x, p.y - head.y));
      if (dEnd(c[0]) > dEnd(c[c.length - 1])) c.reverse();
      const gapT = Math.hypot(c[0].x - tail.x, c[0].y - tail.y);
      const gapH = Math.hypot(c[0].x - head.x, c[0].y - head.y);
      if (gapT < 1e-6 && gapT <= gapH) {
        merged.push(...c.slice(1));
        chains.splice(i, 1);
        progress = true;
      } else if (gapH < 1e-6) {
        merged.unshift(...c.slice(0, c.length - 1));
        chains.splice(i, 1);
        progress = true;
      }
    }
  }
  if (chains.length) return null; // broken chain
  const base = ok[0];
  return { ...base, type: "LWPOLYLINE", points: merged, closed, hatch: undefined } as Extract<DxfEntity, { type: "LWPOLYLINE" }>;
}

/** Open Catmull–Rom spline through `pts` — `per` points per segment. */
export function catmullRom(pts: Pt[], per = 12): DxfPoint[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: DxfPoint[] = [];
  const at = (i: number): Pt => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1),
      p1 = at(i),
      p2 = at(i + 1),
      p3 = at(i + 2);
    for (let j = 0; j < per; j++) {
      const t = j / per,
        t2 = t * t,
        t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Regular n-gon inscribed in the circle (cx, cy, r), first vertex at `startDeg`. */
export function polygonLoop(cx: number, cy: number, r: number, n: number, startDeg = 90): DxfPoint[] {
  const k = Math.max(3, Math.round(n));
  const out: DxfPoint[] = [];
  for (let i = 0; i < k; i++) {
    const a = (startDeg + (360 * i) / k) * DEG;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Ellipse approximation as a closed polyline loop (48 segments). */
export function ellipseLoop(cx: number, cy: number, rx: number, ry: number, steps = 48): DxfPoint[] {
  const out: DxfPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/** Annulus loops for DONUT: [outer, inner] (even-odd fill punches the hole). */
export function donutLoops(cx: number, cy: number, rOuter: number, rInner: number): [DxfPoint[], DxfPoint[]] {
  return [ellipseLoop(cx, cy, rOuter, rOuter, 64), ellipseLoop(cx, cy, rInner, rInner, 48)];
}

/* ── LENGTHEN / DIVIDE / MEASURE ── */

/** Which end of a LINEAR entity the user grabbed (smaller arc length = start side). */
export type LengthenEnd = "start" | "end";

/** Total length of the drawable span of an entity (LINE / ARC / open LWPOLYLINE). */
export function entitySpanLength(e: DxfEntity): number {
  switch (e.type) {
    case "LINE":
      return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y);
    case "ARC": {
      const sw = norm360(e.endAngle - e.startAngle) || 360;
      return e.radius * sw * DEG;
    }
    case "LWPOLYLINE": {
      if (e.closed || e.points.length < 2) return 0;
      let len = 0;
      for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].y - e.points[i - 1].y);
      return len;
    }
    default:
      return 0;
  }
}

/** LENGTHEN (dynamic): replace the grabbed end with `to` projected on the entity's end tangent. */
export function lengthenTo(e: DxfEntity, end: LengthenEnd, to: Pt): DxfEntity | null {
  switch (e.type) {
    case "LINE": {
      // Project the cursor onto the infinite line through start→end.
      const dx = e.end.x - e.start.x,
        dy = e.end.y - e.start.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-18) return null;
      const t = ((to.x - e.start.x) * dx + (to.y - e.start.y) * dy) / len2;
      const p = P(e.start.x + dx * t, e.start.y + dy * t);
      return end === "end" ? { ...e, end: p } : { ...e, start: p };
    }
    case "ARC": {
      // Cursor angle becomes the new start/end angle; sweep keeps the CCW direction.
      const a = Math.atan2(to.y - e.center.y, to.x - e.center.x) * RAD;
      return end === "end" ? { ...e, endAngle: norm360(a) } : { ...e, startAngle: norm360(a) };
    }
    case "LWPOLYLINE": {
      if (e.closed || e.points.length < 2) return null;
      const pts = e.points.map((q) => ({ ...q }));
      if (end === "end") {
        const a = pts[pts.length - 2],
          b = pts[pts.length - 1];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) return null;
        const t = ((to.x - a.x) * dx + (to.y - a.y) * dy) / len2;
        pts[pts.length - 1] = P(a.x + dx * t, a.y + dy * t);
      } else {
        const a = pts[1],
          b = pts[0];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) return null;
        const t = ((to.x - a.x) * dx + (to.y - a.y) * dy) / len2;
        pts[0] = P(a.x + dx * t, a.y + dy * t);
      }
      return { ...e, points: pts, hatch: e.hatch ? { ...e.hatch, loops: [pts, ...e.hatch.loops.slice(1)] } : undefined };
    }
    default:
      return null;
  }
}

/** LENGTHEN <total>: set the grabbed end so the entity measures exactly `total`. */
export function lengthenTotal(e: DxfEntity, end: LengthenEnd, total: number): DxfEntity | null {
  const cur = entitySpanLength(e);
  if (cur < 1e-12 || total < 1e-9) return null;
  switch (e.type) {
    case "LINE": {
      const k = total / cur;
      const dx = e.end.x - e.start.x,
        dy = e.end.y - e.start.y;
      if (end === "end") return { ...e, end: P(e.start.x + dx * k, e.start.y + dy * k) };
      return { ...e, start: P(e.end.x - dx * k, e.end.y - dy * k) };
    }
    case "ARC": {
      const k = total / cur;
      const sw = norm360(e.endAngle - e.startAngle) || 360;
      if (end === "end") return { ...e, endAngle: norm360(e.startAngle + sw * k) };
      return { ...e, startAngle: norm360(e.endAngle - sw * k) };
    }
    case "LWPOLYLINE": {
      if (e.closed || e.points.length < 2) return null;
      // Walk from the opposite end and cut the last segment at the remainder.
      const pts = e.points.map((q) => ({ ...q }));
      let remain = total;
      if (end === "end") {
        const out: DxfPoint[] = [];
        out.push(pts[0]);
        for (let i = 1; i < pts.length && remain > 1e-12; i++) {
          const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          if (d <= remain) {
            out.push(pts[i]);
            remain -= d;
          } else {
            const t = remain / d;
            out.push(P(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t));
            remain = 0;
          }
        }
        return { ...e, points: out };
      }
      const rev = pts.slice().reverse();
      const out: DxfPoint[] = [];
      out.push(rev[0]);
      for (let i = 1; i < rev.length && remain > 1e-12; i++) {
        const d = Math.hypot(rev[i].x - rev[i - 1].x, rev[i].y - rev[i - 1].y);
        if (d <= remain) {
          out.push(rev[i]);
          remain -= d;
        } else {
          const t = remain / d;
          out.push(P(rev[i - 1].x + (rev[i].x - rev[i - 1].x) * t, rev[i - 1].y + (rev[i].y - rev[i - 1].y) * t));
          remain = 0;
        }
      }
      const fixed = out.reverse();
      return { ...e, points: fixed };
    }
    default:
      return null;
  }
}

/** DIVIDE: N-1 interior points that split the entity into N equal parts. */
export function divPoints(e: DxfEntity, n: number): Pt[] {
  if (n < 2 || n > 10000) return [];
  const total = entitySpanLength(e);
  if (total < 1e-12) return [];
  const out: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const p = pointAtSpan(e, (total * i) / n);
    if (p) out.push(p);
  }
  return out;
}

/** MEASURE: points every `spacing` along the entity, from the start. */
export function measPoints(e: DxfEntity, spacing: number): Pt[] {
  if (!(spacing > 1e-12)) return [];
  const total = entitySpanLength(e);
  if (total < 1e-12) return [];
  const out: Pt[] = [];
  for (let d = spacing; d < total - 1e-9; d += spacing) {
    const p = pointAtSpan(e, d);
    if (p) out.push(p);
  }
  return out;
}

/** Point at arc-length `d` from the entity start (LINE / ARC / open LWPOLYLINE). */
export function pointAtSpan(e: DxfEntity, d: number): Pt | null {
  switch (e.type) {
    case "LINE": {
      const len = entitySpanLength(e);
      if (len < 1e-12) return null;
      const t = d / len;
      return P(e.start.x + (e.end.x - e.start.x) * t, e.start.y + (e.end.y - e.start.y) * t);
    }
    case "ARC": {
      const sw = norm360(e.endAngle - e.startAngle) || 360;
      const len = e.radius * sw * DEG;
      if (len < 1e-12) return null;
      const a = e.startAngle + sw * (d / len);
      return P(e.center.x + e.radius * Math.cos(a * DEG), e.center.y + e.radius * Math.sin(a * DEG));
    }
    case "LWPOLYLINE": {
      if (e.closed || e.points.length < 2) return null;
      let remain = d;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1],
          b = e.points[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (seg >= remain) {
          const t = seg > 1e-18 ? remain / seg : 0;
          return P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        }
        remain -= seg;
      }
      return null;
    }
    default:
      return null;
  }
}

/* ── STRETCH ──────────────────────────────────────────────────────────────── */

/**
 * STRETCH: move every vertex of `ents` that lies inside the crossing window by
 * dp. Circles/arcs/TEXT move wholesale when their anchor is inside.
 */
export function stretchEnts(ents: DxfEntity[], win: { minX: number; minY: number; maxX: number; maxY: number }, dp: Pt): DxfEntity[] {
  const inside = (p: Pt): boolean => p.x >= win.minX && p.x <= win.maxX && p.y >= win.minY && p.y <= win.maxY;
  return ents.map((e) => {
    switch (e.type) {
      case "LINE": {
        const s = inside(e.start),
          en = inside(e.end);
        if (!s && !en) return e;
        return {
          ...e,
          start: s ? translatePt(e.start, dp.x, dp.y) : e.start,
          end: en ? translatePt(e.end, dp.x, dp.y) : e.end,
        };
      }
      case "LWPOLYLINE": {
        if (!e.points.some(inside)) return e;
        return {
          ...e,
          points: e.points.map((q) => (inside(q) ? translatePt(q, dp.x, dp.y) : q)),
          hatch: e.hatch ? mapHatch(e.hatch, (q) => (inside(q) ? translatePt(q, dp.x, dp.y) : q)) : undefined,
        };
      }
      case "CIRCLE":
      case "ARC":
        return inside(e.center) ? translateEnt(e, dp.x, dp.y) : e;
      case "TEXT":
      case "POINT":
        return inside(e.position) ? translateEnt(e, dp.x, dp.y) : e;
      case "RAY":
      case "XLINE":
        // Stretch moves the anchor; the direction is relative and unchanged.
        return inside(e.start) ? translateEnt(e, dp.x, dp.y) : e;
    }
  });
}

/* ── Multi-mode arrays ── */

/** Hard ceiling for generated entities in one array operation. */
export const MAX_ARRAY_ENTITY_COUNT = 10000;

function validateArraySource(entities: DxfEntity[], totalInstances: number): void {
  if (!entities.length) throw new RangeError("Select at least one source object.");
  if (!Number.isInteger(totalInstances) || totalInstances < 2) throw new RangeError("An array must contain at least two instances.");
  if (totalInstances * entities.length > MAX_ARRAY_ENTITY_COUNT) {
    throw new RangeError("Array exceeds the " + MAX_ARRAY_ENTITY_COUNT.toLocaleString() + " generated-entity safety limit.");
  }
}

function validateArrayCount(count: number): void {
  if (!Number.isInteger(count) || count < 2) throw new RangeError("Array count must be an integer of at least 2.");
}

function validateArrayPoint(p: Pt, label: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError(label + " must contain finite X and Y coordinates.");
}

/**
 * Rectangular array. Rows and columns include the original selection;
 * the return value contains only the additional copies.
 */
export function rectangularArrayCopies(
  entities: DxfEntity[],
  rows: number,
  columns: number,
  rowSpacing: number,
  columnSpacing: number,
): DxfEntity[] {
  validateArrayCount(rows * columns);
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) {
    throw new RangeError("Rows and columns must be positive integers.");
  }
  if (!Number.isFinite(rowSpacing) || !Number.isFinite(columnSpacing)) {
    throw new RangeError("Array spacing must be finite.");
  }
  validateArraySource(entities, rows * columns);
  const copies: DxfEntity[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (row === 0 && column === 0) continue;
      for (const entity of entities) {
        copies.push(translateEnt(entity, column * columnSpacing, row * rowSpacing));
      }
    }
  }
  return copies;
}

/**
 * Polar/circular array. Count includes the original source. A 360-degree sweep
 * does not duplicate the first item at the end; partial sweeps include both
 * ends. When rotateItems is false, each copy keeps its original orientation.
 */
export function polarArrayCopies(
  entities: DxfEntity[],
  center: Pt,
  basePoint: Pt,
  count: number,
  sweepDegrees = 360,
  rotateItems = false,
): DxfEntity[] {
  validateArrayCount(count);
  validateArrayPoint(center, "Array center");
  validateArrayPoint(basePoint, "Array base point");
  if (!Number.isFinite(sweepDegrees) || Math.abs(sweepDegrees) < 1e-9 || Math.abs(sweepDegrees) > 360 + 1e-9) {
    throw new RangeError("Polar sweep must be greater than 0 degrees and no more than 360 degrees in either direction.");
  }
  validateArraySource(entities, count);
  const closedSweep = Math.abs(Math.abs(sweepDegrees) - 360) < 1e-9;
  const divisor = closedSweep ? count : count - 1;
  const copies: DxfEntity[] = [];
  for (let item = 1; item < count; item++) {
    const angle = sweepDegrees * item / divisor;
    if (rotateItems) {
      for (const entity of entities) copies.push(rotateEnt(entity, center.x, center.y, angle));
    } else {
      const target = rotatePt(basePoint, center, angle * DEG);
      const dx = target.x - basePoint.x, dy = target.y - basePoint.y;
      for (const entity of entities) copies.push(translateEnt(entity, dx, dy));
    }
  }
  return copies;
}

/**
 * Path array along an open or closed lightweight polyline. The first path
 * vertex is the placement base point; source objects should be positioned
 * there before running the command. The path object itself is not copied.
 */
export function pathArrayCopies(
  entities: DxfEntity[],
  path: Extract<DxfEntity, { type: "LWPOLYLINE" }>,
  spacing: number,
  alignToPath = false,
): DxfEntity[] {
  if (!entities.length) throw new RangeError("Select at least one source object.");
  if (path.hatch || path.points.length < 2) throw new RangeError("Path array requires an open or closed polyline with at least two vertices.");
  if (!Number.isFinite(spacing) || spacing <= 0) throw new RangeError("Path spacing must be a positive finite number.");

  const points = path.points.map((p) => ({ x: p.x, y: p.y }));
  const segments: Array<{ a: Pt; b: Pt; length: number }> = [];
  const segmentCount = path.closed ? points.length : points.length - 1;
  let totalLength = 0;
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 1e-9) {
      segments.push({ a, b, length });
      totalLength += length;
    }
  }
  if (totalLength <= 1e-9) throw new RangeError("Path array cannot use a zero-length path.");

  const closed = !!path.closed;
  const maxCopies = Math.floor((totalLength + 1e-9) / spacing);
  const count = closed && Math.abs(maxCopies * spacing - totalLength) < 1e-9 ? maxCopies - 1 : maxCopies;
  if (count < 1) throw new RangeError("Spacing is longer than the path; no array copies would be created.");
  validateArraySource(entities, count + 1);

  const origin = points[0];
  const copies: DxfEntity[] = [];
  for (let item = 1; item <= count; item++) {
    const targetDistance = item * spacing;
    if (closed && targetDistance >= totalLength - 1e-9) break;
    let remaining = targetDistance;
    let target: Pt | null = null;
    let tangent = 0;
    for (const segment of segments) {
      if (remaining <= segment.length + 1e-9) {
        const t = Math.max(0, Math.min(1, remaining / segment.length));
        target = {
          x: segment.a.x + (segment.b.x - segment.a.x) * t,
          y: segment.a.y + (segment.b.y - segment.a.y) * t,
        };
        tangent = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x) * RAD;
        break;
      }
      remaining -= segment.length;
    }
    if (!target) continue;
    const dx = target.x - origin.x, dy = target.y - origin.y;
    for (const entity of entities) {
      const translated = translateEnt(entity, dx, dy);
      copies.push(alignToPath ? rotateEnt(translated, target.x, target.y, tangent) : translated);
    }
  }
  return copies;
}

