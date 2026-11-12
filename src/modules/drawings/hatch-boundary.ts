/**
 * Hatch boundary detection — "pick a point inside an enclosed area" for the
 * 2D Drawing Editor (BHATCH-style). Two tiers, both pure and testable:
 *
 * 1. **Enclosing entity** — the smallest closed object that contains the
 *    seed point (closed polyline, circle, …). Instant and exact.
 * 2. **Traced region** — the region is formed by intersecting open entities
 *    (four loose lines forming a room, a wall line crossing a rectangle…).
 *    The entities are split at every crossing into atomic edges and the face
 *    containing the seed is walked with the standard planar "next edge CCW
 *    after the reverse edge" rule; both orientations of the first hit edge
 *    are tried and the smallest traced loop that really contains the seed
 *    wins. Segments are endpoint-quantised with a gap tolerance so regions
 *    whose corners are only nearly touching still close.
 *
 * Text, points and infinite construction lines (RAY/XLINE) never bound a
 * hatch — like native CAD. Pure module — no DOM, testable in Node.
 */

import type { DxfEntity, DxfPoint } from "./dxf-types";
import { pointInPolygon, polygonArea } from "./hatch-patterns";

export interface HatchGeom {
  /** Closed entity polygons, ready for tier 1. */
  loops: DxfPoint[][];
  /** Open segments — includes the edges of the closed entities. */
  segs: Array<[DxfPoint, DxfPoint]>;
}

export type BoundaryResult =
  | { ok: true; loop: DxfPoint[]; source: "entity" | "traced"; area: number; perimeter: number }
  | { ok: false; reason: "not-found" | "too-complex"; segs?: number };

const CIRCLE_STEPS = 72;
const ARC_STEPS = 36;
const RAY_COUNT = 16;

/** Absolute tolerance used when quantising vertices (relative to the scene). */
function gapTolerance(segs: Array<[DxfPoint, DxfPoint]>, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  let d = 0;
  for (const [a, b] of segs) {
    d = Math.max(d, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y));
  }
  return Math.max(1e-9, d * 1e-6);
}

/** Entities → hatch geometry snapshot (visible filter decides what bounds a hatch). */
export function collectHatchGeometry(
  entities: DxfEntity[],
  visible: (e: DxfEntity) => boolean = () => true,
): HatchGeom {
  const loops: DxfPoint[][] = [];
  const segs: Array<[DxfPoint, DxfPoint]> = [];
  const pushPoly = (pts: DxfPoint[], closed: boolean): void => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-12);
    if (closed && clean.length >= 3) {
      if (Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-9) clean.pop();
      if (clean.length >= 3) loops.push(clean);
      for (let i = 0; i < clean.length; i++) segs.push([clean[i], clean[(i + 1) % clean.length]]);
    } else {
      for (let i = 0; i + 1 < clean.length; i++) segs.push([clean[i], clean[i + 1]]);
    }
  };
  const arcPoly = (cx: number, cy: number, r: number, a0deg: number, a1deg: number): DxfPoint[] => {
    let sweep = (a1deg - a0deg) % 360;
    if (sweep <= 0) sweep += 360;
    const out: DxfPoint[] = [];
    for (let i = 0; i <= ARC_STEPS; i++) {
      const a = (a0deg + (sweep * i) / ARC_STEPS) * (Math.PI / 180);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  };
  for (const e of entities) {
    if (!e || !visible(e)) continue;
    if (e.type === "LINE") {
      segs.push([{ x: e.start.x, y: e.start.y }, { x: e.end.x, y: e.end.y }]);
    } else if (e.type === "LWPOLYLINE") {
      pushPoly(e.points.map((p) => ({ x: p.x, y: p.y })), !!e.closed);
    } else if (e.type === "CIRCLE") {
      const pts: DxfPoint[] = [];
      for (let i = 0; i < CIRCLE_STEPS; i++) {
        const a = (i / CIRCLE_STEPS) * Math.PI * 2;
        pts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
      }
      pushPoly(pts, true);
    } else if (e.type === "ARC") {
      pushPoly(arcPoly(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false);
    }
    // TEXT, MTEXT, POINT, RAY, XLINE, LEADER-ish text records: never bound a hatch.
  }
  return { loops, segs };
}

function segSegX(
  a: DxfPoint, b: DxfPoint, c: DxfPoint, d: DxfPoint,
): DxfPoint | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

interface AtomicEdge {
  a: number;
  b: number;
}

/**
 * Detect the boundary around `seed`. Tries the enclosing-entity tier first,
 * then the traced-region tier.
 */
export function detectLoopAt(
  geom: HatchGeom,
  seed: DxfPoint,
  opts: { gapTol?: number; maxSegs?: number } = {},
): BoundaryResult {
  // ── Tier 1: smallest closed entity containing the seed ─────────────────
  let bestTier1: { loop: DxfPoint[]; area: number } | null = null;
  for (const loop of geom.loops) {
    const area = Math.abs(polygonArea(loop));
    if (area < 1e-12) continue;
    if (pointInPolygon(seed, loop) && (!bestTier1 || area < bestTier1.area)) {
      bestTier1 = { loop, area };
    }
  }
  if (bestTier1) {
    return { ok: true, loop: bestTier1.loop, source: "entity", area: bestTier1.area, perimeter: perimeterOf(bestTier1.loop) };
  }
  return traceFaceAt(geom, seed, opts);
}

function perimeterOf(loop: DxfPoint[]): number {
  let p = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/** Tier 2: split at crossings, walk the face containing the seed. */
function traceFaceAt(
  geom: HatchGeom,
  seed: DxfPoint,
  opts: { gapTol?: number; maxSegs?: number },
): BoundaryResult {
  const maxSegs = opts.maxSegs ?? 2500;
  if (geom.segs.length === 0) return { ok: false, reason: "not-found" };
  if (geom.segs.length > maxSegs) {
    return { ok: false, reason: "too-complex", segs: geom.segs.length };
  }
  const q = gapTolerance(geom.segs, opts.gapTol);
  const keyOf = (p: DxfPoint): string => `${Math.round(p.x / q)}|${Math.round(p.y / q)}`;

  // ── split segments at every crossing ────────────────────────────────────
  type Frag = { a: DxfPoint; b: DxfPoint };
  let frags: Frag[] = geom.segs.map(([a, b]) => ({ a, b })).filter((f) => Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) > 1e-12);
  const n0 = frags.length;
  for (let i = 0; i < n0; i++) {
    const s = frags[i];
    const cuts: Array<{ t: number; p: DxfPoint }> = [];
    for (let j = 0; j < n0; j++) {
      if (j === i) continue;
      const o = frags[j];
      if (!o) continue; // already split at an earlier crossing
      const x = segSegX(s.a, s.b, o.a, o.b);
      if (!x) continue;
      const t = Math.hypot(x.x - s.a.x, x.y - s.a.y);
      const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      if (len > 1e-12 && t > len * 1e-9 && t < len * (1 - 1e-9)) cuts.push({ t, p: x });
    }
    if (cuts.length) {
      cuts.sort((p, r) => p.t - r.t);
      let prev = s.a;
      for (const c of cuts) {
        frags.push({ a: prev, b: c.p });
        prev = c.p;
      }
      frags.push({ a: prev, b: s.b });
      frags[i] = null as unknown as Frag;
    }
  }
  frags = frags.filter(Boolean);

  // ── quantise vertices + build adjacency ─────────────────────────────────
  const vid = new Map<string, number>();
  const verts: DxfPoint[] = [];
  const vertexOf = (p: DxfPoint): number => {
    const k = keyOf(p);
    let id = vid.get(k);
    if (id == null) {
      id = verts.length;
      verts.push({ x: Math.round(p.x / q) * q, y: Math.round(p.y / q) * q });
      vid.set(k, id);
    }
    return id;
  };
  const edges: AtomicEdge[] = [];
  const adj = new Map<number, Map<number, true>>();
  const seen = new Set<string>();
  for (const f of frags) {
    const a = vertexOf(f.a), b = vertexOf(f.b);
    if (a === b) continue;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ a, b });
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, true);
    adj.get(b)!.set(a, true);
  }
  if (!edges.length) return { ok: false, reason: "not-found" };

  // ── face walk: next edge CCW-after the reverse edge ─────────────────────
  const TAU = Math.PI * 2;
  const walk = (startU: number, startV: number): number[] | null => {
    const seq: number[] = [startU, startV];
    let u = startU, v = startV;
    const guard = edges.length * 2 + 8;
    for (let steps = 0; steps < guard; steps++) {
      const thetaRev = Math.atan2(verts[u].y - verts[v].y, verts[u].x - verts[v].x);
      const nb = adj.get(v);
      if (!nb) return null;
      let bestW = -1, bestDelta = Infinity;
      for (const w of nb.keys()) {
        const thetaW = Math.atan2(verts[w].y - verts[v].y, verts[w].x - verts[v].x);
        let delta = ((thetaW - thetaRev) % TAU + TAU) % TAU;
        if (delta < 1e-9) delta = TAU; // the reverse edge itself: full turn (dead-end spike)
        if (delta < bestDelta - 1e-12) { bestDelta = delta; bestW = w; }
      }
      if (bestW < 0) return null;
      if (v === startU && bestW === startV) return seq; // closed back on the start half-edge
      seq.push(bestW);
      u = v; v = bestW;
    }
    return null;
  };

  const loops = new Map<string, { loop: DxfPoint[]; area: number }>();
  const consider = (raw: number[] | null): void => {
    if (!raw || raw.length < 3) return;
    const cyc = raw;
    const pts = cyc.map((id) => verts[id]);
    const area = Math.abs(polygonArea(pts));
    if (area < 1e-12) return;
    if (!pointInPolygon(seed, pts)) return;
    const sig = [...cyc].sort((a, b) => a - b).join(",");
    const prev = loops.get(sig);
    if (!prev || area < prev.area) loops.set(sig, { loop: pts, area });
  };

  // ── seed entry: cast rays, take the nearest atomic edge each time ────────
  const rayCandidates: Array<{ u: number; v: number }> = [];
  for (let r = 0; r < RAY_COUNT; r++) {
    const ang = (r / RAY_COUNT) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let bestT = Infinity, bestU = -1, bestV = -1;
    for (const e of edges) {
      const a = verts[e.a], b = verts[e.b];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const t = ((a.x - seed.x) * ey - (a.y - seed.y) * ex) / den; // along ray
      const s = ((a.x - seed.x) * dy - (a.y - seed.y) * dx) / den; // along edge
      if (t > q && t < bestT && s >= -1e-9 && s <= 1 + 1e-9) {
        bestT = t; bestU = e.a; bestV = e.b;
      }
    }
    if (bestU >= 0) rayCandidates.push({ u: bestU, v: bestV });
  }
  if (!rayCandidates.length) return { ok: false, reason: "not-found" };

  for (const cand of rayCandidates) {
    consider(walk(cand.u, cand.v));
    consider(walk(cand.v, cand.u));
  }
  let best: { loop: DxfPoint[]; area: number } | null = null;
  for (const l of loops.values()) {
    if (!best || l.area < best.area) best = l;
  }
  if (!best) return { ok: false, reason: "not-found" };
  return { ok: true, loop: best.loop, source: "traced", area: best.area, perimeter: perimeterOf(best.loop) };
}
