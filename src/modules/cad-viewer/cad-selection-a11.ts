/**
 * AutoCAD parity A11 — fence / lasso selection, Ctrl+click cycling, grip modes.
 *
 * Pure geometry + selection state; no DOM, no rendering. The CAD viewer
 * (src/features/cad-viewer.ts) wires these helpers to the FENCE / LASSO
 * tools, the Ctrl+click cycle and the grip-drag mode switch.
 *
 * Conventions (AutoCAD):
 * - FENCE selects every entity the fence polyline CROSSES — an open
 *   polyline; entities it merely encloses are not selected.
 * - LASSO is a freehand loop. Like the rectangle band, the drag direction
 *   decides the mode: first significant move left-to-right = window (only
 *   entities fully inside), right-to-left = crossing (anything the loop
 *   touches or encloses).
 * - Ctrl+click cycles the overlapping objects under the cursor one at a
 *   time; each further Ctrl+click at the same spot advances to the next.
 * - Grip modes: STRETCH is the existing grip drag (vertex grips stretch,
 *   centre grips move); MOVE moves the whole entity from the grip as base
 *   point; ROTATE / SCALE rotate / scale the entity about the grip, with
 *   the first significant drag direction / distance as the zero reference
 *   (the cursor starts ON the grip, so it cannot supply one); MIRROR
 *   mirrors across the line through the grip and the cursor. All modes
 *   transform the pre-drag entity absolutely, so repeated moves never
 *   drift.
 */

import type { DxfEntity } from "../drawings/dxf-types";
import { pointInPolygon } from "../drawings/hatch-patterns";
import * as M from "./viewer-math";
import { mirrorEnt, rotateEnt, scaleEnt, translateEnt } from "./modify-math";

const DEG = Math.PI / 180;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const angleOf = (a: M.Pt, b: M.Pt): number => Math.atan2(b.y - a.y, b.x - a.x) / DEG;
const dist = (a: M.Pt, b: M.Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/* ── shared segment helpers ─────────────────────────────────────────── */

type Seg = [M.Pt, M.Pt];

const polySegs = (pts: M.Pt[], closed: boolean): Seg[] => {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
};

/** Tessellated circumference of a circle / arc (degrees), as segments. */
function curveSegs(e: Extract<DxfEntity, { type: "CIRCLE" | "ARC" }>): Seg[] {
  const sweep = e.type === "CIRCLE" ? 360 : (((e.endAngle - e.startAngle) % 360) + 360) % 360 || 360;
  const n = Math.max(8, Math.ceil(sweep / 10));
  const start = e.type === "CIRCLE" ? 0 : e.startAngle;
  const pts: M.Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (start + (sweep * i) / n) * DEG;
    pts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
  }
  return polySegs(pts, false);
}

/** Segments of an entity's drawn geometry (empty for point-like entities). */
function geometrySegs(e: DxfEntity): Seg[] {
  if (e.type === "LINE" || e.type === "LWPOLYLINE") return M.entitySegments(e);
  if (e.type === "CIRCLE" || e.type === "ARC") return curveSegs(e);
  return [];
}

const segHitsSeg = (a: Seg, b: Seg): boolean => M.segSegIntersection(a[0], a[1], b[0], b[1]) !== null;

/** Does the segment touch the rectangle (endpoint inside, or crosses an edge)? */
function segHitsRect(a: M.Pt, b: M.Pt, r: M.BBox): boolean {
  const inside = (p: M.Pt): boolean => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
  if (inside(a) || inside(b)) return true;
  const corners: M.Pt[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  return polySegs(corners, true).some((edge) => segHitsSeg([a, b], edge));
}

const bboxOfPts = (pts: M.Pt[]): M.BBox => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
};

/* ── FENCE ──────────────────────────────────────────────────────────── */

/**
 * Indices of entities crossed by the fence polyline (open — consecutive
 * points only, no closing edge). Segment entities need an exact segment
 * crossing; RAY / XLINE are crossed when their infinite line meets a
 * fence segment; point-like entities are crossed when the fence passes
 * within `tol` of their anchor (POINT) or through their bounding box
 * (TEXT / INSERT / DIMENSION and anything else with extent).
 */
export function selectByFence(
  idx: M.SpatialIndex,
  entities: DxfEntity[],
  fence: M.Pt[],
  visible: (e: DxfEntity) => boolean = () => true,
  tol = 0,
): number[] {
  if (fence.length < 2) return [];
  const fenceSegs = polySegs(fence, false);
  const out: number[] = [];
  for (const i of M.queryIndexBox(idx, entities, bboxOfPts(fence))) {
    const e = entities[i];
    if (!e || !visible(e)) continue;
    if (e.type === "RAY" || e.type === "XLINE") {
      // Infinite line: crossed when it meets a fence segment at a point
      // that lies on that segment.
      let hit = false;
      for (const [a, b] of fenceSegs) {
        const c = M.lineLineIntersection(e.start, { x: e.start.x + e.direction.x, y: e.start.y + e.direction.y }, a, b);
        if (!c) continue;
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const t = l2 < 1e-18 ? 0 : ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2;
        if (t >= -1e-9 && t <= 1 + 1e-9) { hit = true; break; }
      }
      if (hit) out.push(i);
      continue;
    }
    const segs = geometrySegs(e);
    if (segs.length) {
      if (segs.some((s) => fenceSegs.some((f) => segHitsSeg(s, f)))) out.push(i);
      continue;
    }
    if (e.type === "POINT") {
      if (fenceSegs.some(([a, b]) => M.distPointToSeg(e.position, a, b).dist <= tol + 1e-12)) out.push(i);
      continue;
    }
    // TEXT / INSERT / DIMENSION / anything else with extent: the fence
    // must pass through its bounding box.
    const b = M.entityBBox(e);
    if (fenceSegs.some(([a, c]) => segHitsRect(a, c, b))) out.push(i);
  }
  return out;
}

/* ── LASSO ──────────────────────────────────────────────────────────── */

/** Lasso mode from the drag direction (same convention as the rectangle band). */
export function lassoModeFromPath(loop: M.Pt[], start: M.Pt, minDx: number): "window" | "crossing" {
  for (const p of loop) {
    const dx = p.x - start.x;
    if (Math.abs(dx) >= minDx) return dx >= 0 ? "window" : "crossing";
  }
  return "window";
}

const segCrossesLoop = (s: Seg, loop: M.Pt[]): boolean =>
  polySegs(loop, true).some((edge) => segHitsSeg(s, edge));

const segInsideLoop = (s: Seg, loop: M.Pt[]): boolean =>
  pointInPolygon(s[0], loop) && pointInPolygon(s[1], loop) && !segCrossesLoop(s, loop);

/** Fully inside: every segment inside (endpoints in, no boundary crossing). */
function entityInsideLoop(e: DxfEntity, loop: M.Pt[]): boolean {
  if (e.type === "RAY" || e.type === "XLINE") return false; // infinite lines are never fully enclosed
  const segs = geometrySegs(e);
  if (segs.length) return segs.every((s) => segInsideLoop(s, loop));
  if (e.type === "POINT") return pointInPolygon(e.position, loop);
  const b = M.entityBBox(e);
  const corners: M.Pt[] = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  return corners.every((c) => pointInPolygon(c, loop)) &&
    polySegs(corners, true).every((edge) => !segCrossesLoop(edge, loop));
}

/** Touched or enclosed: a segment crosses the boundary, or an endpoint is inside. */
function entityCrossesLoop(e: DxfEntity, loop: M.Pt[]): boolean {
  if (e.type === "RAY" || e.type === "XLINE") {
    // The infinite line passes through the loop when it meets an edge,
    // or when its anchor already lies inside it.
    if (pointInPolygon(e.start, loop)) return true;
    const far = { x: e.start.x + e.direction.x * 1e6, y: e.start.y + e.direction.y * 1e6 };
    return segCrossesLoop([e.start, far], loop);
  }
  const segs = geometrySegs(e);
  if (segs.length) {
    return segs.some((s) => segCrossesLoop(s, loop) || pointInPolygon(s[0], loop) || pointInPolygon(s[1], loop));
  }
  if (e.type === "POINT") return pointInPolygon(e.position, loop);
  const b = M.entityBBox(e);
  const corners: M.Pt[] = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  return corners.some((c) => pointInPolygon(c, loop)) ||
    polySegs(corners, true).some((edge) => segCrossesLoop(edge, loop));
}

/**
 * Indices of entities selected by the freehand loop. `mode` is "window"
 * (only entities fully inside) or "crossing" (anything the loop touches
 * or encloses). Loops with fewer than 3 points select nothing.
 */
export function selectByLasso(
  idx: M.SpatialIndex,
  entities: DxfEntity[],
  loop: M.Pt[],
  mode: "window" | "crossing",
  visible: (e: DxfEntity) => boolean = () => true,
): number[] {
  if (loop.length < 3) return [];
  const out: number[] = [];
  for (const i of M.queryIndexBox(idx, entities, bboxOfPts(loop))) {
    const e = entities[i];
    if (!e || !visible(e)) continue;
    if (mode === "window" ? entityInsideLoop(e, loop) : entityCrossesLoop(e, loop)) out.push(i);
  }
  return out;
}

/* ── Ctrl+click cycling ─────────────────────────────────────────────── */

export interface CycleState {
  /** Rounded pick point the cycle belongs to. */
  key: string;
  candidates: number[];
  pos: number;
}

/**
 * Next candidate for a Ctrl+click at `key`. Repeats at the same spot
 * advance through the candidates in pick order; a new spot (or a
 * changed candidate set) restarts at the first candidate. Returns null
 * when there is nothing under the cursor.
 */
export function cycleNext(
  candidates: number[],
  state: CycleState | null,
  key: string,
): { index: number; state: CycleState } | null {
  if (!candidates.length) return null;
  const same =
    state !== null &&
    state.key === key &&
    state.candidates.length === candidates.length &&
    state.candidates.every((c, i) => c === candidates[i]);
  const pos = same ? (state.pos + 1) % candidates.length : 0;
  return { index: candidates[pos], state: { key, candidates: [...candidates], pos } };
}

/* ── grip modes ─────────────────────────────────────────────────────── */

export type GripMode = "stretch" | "move" | "rotate" | "scale" | "mirror";
export const GRIP_MODES: GripMode[] = ["stretch", "move", "rotate", "scale", "mirror"];
export const GRIP_MODE_LABELS: Record<GripMode, string> = {
  stretch: "Stretch",
  move: "Move",
  rotate: "Rotate",
  scale: "Scale",
  mirror: "Mirror",
};
export const nextGripMode = (m: GripMode): GripMode =>
  GRIP_MODES[(GRIP_MODES.indexOf(m) + 1) % GRIP_MODES.length];

/**
 * The zero reference for rotate / scale: the angle and distance of the
 * first significant drag step away from the grip (the base point). Null
 * while the cursor is still effectively on the grip.
 */
export interface GripRef {
  angleDeg: number;
  dist: number;
}

export function captureGripRef(base: M.Pt, p: M.Pt, minDist: number): GripRef | null {
  const d = dist(base, p);
  if (!(d >= minDist)) return null;
  return { angleDeg: angleOf(base, p), dist: d };
}

/** Rotation (degrees, CCW positive) from the reference direction to the cursor. */
export function gripRotateDeg(refAngleDeg: number, base: M.Pt, to: M.Pt): number {
  return norm360(angleOf(base, to) - refAngleDeg);
}

/** Scale factor from the reference distance to the cursor distance. */
export function gripScaleFactor(refDist: number, base: M.Pt, to: M.Pt): number {
  if (!(refDist > 0)) return 1;
  return dist(base, to) / refDist;
}

/** Entity types the rotate / scale / mirror cores handle (their switch has an explicit case). */
const TRANSFORMABLE: ReadonlySet<string> = new Set([
  "INSERT", "LINE", "CIRCLE", "ARC", "LWPOLYLINE", "TEXT", "POINT", "RAY", "XLINE", "DIMENSION", "TABLE",
]);

export interface GripModeResult {
  entity: DxfEntity;
  /** Reference captured on this move (rotate / scale), or the one passed in. */
  ref: GripRef | null;
}

/**
 * Absolute transform of the pre-drag entity for one grip-drag step.
 * `ref` is the rotate/scale zero reference (null until the first
 * significant move captures it); `minRefDist` is the world distance a
 * move must cover before it counts as the reference (the viewer passes
 * a few screen pixels in world units). Returns null when the mode does
 * not apply to this grip/entity (stretch on a grip with no drag rule,
 * or rotate/scale/mirror on an unhandled type).
 */
export function applyGripMode(
  e: DxfEntity,
  mode: GripMode,
  base: M.Pt,
  ref: GripRef | null,
  to: M.Pt,
  gi: number,
  minRefDist = 1e-6,
): GripModeResult | null {
  switch (mode) {
    case "stretch": {
      const moved = M.applyGripDrag(e, gi, to);
      return moved ? { entity: moved, ref } : null;
    }
    case "move": {
      if (!TRANSFORMABLE.has(e.type)) return null;
      return { entity: translateEnt(e, to.x - base.x, to.y - base.y), ref };
    }
    case "rotate": {
      if (!TRANSFORMABLE.has(e.type)) return null;
      const r = ref ?? captureGripRef(base, to, minRefDist);
      if (!r) return { entity: e, ref: null };
      return { entity: rotateEnt(e, base.x, base.y, gripRotateDeg(r.angleDeg, base, to)), ref: r };
    }
    case "scale": {
      if (!TRANSFORMABLE.has(e.type)) return null;
      const r = ref ?? captureGripRef(base, to, minRefDist);
      if (!r) return { entity: e, ref: null };
      return { entity: scaleEnt(e, base.x, base.y, gripScaleFactor(r.dist, base, to)), ref: r };
    }
    case "mirror": {
      if (!TRANSFORMABLE.has(e.type)) return null;
      if (dist(base, to) < 1e-9) return { entity: e, ref };
      return { entity: mirrorEnt(e, base, to), ref };
    }
  }
}
