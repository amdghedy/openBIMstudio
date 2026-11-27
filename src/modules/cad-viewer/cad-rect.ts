/**
 * Rectangle variants (AutoCAD RECTANG parity, 2D-8).
 *
 * Pure and DOM-free so it can be unit-tested headlessly. The geometry core
 * is here; the viewer (`src/features/cad-viewer.ts`) only owns the prompt
 * flow (option keywords, pendingNumeric handlers) and attaches the result
 * to a closed LWPOLYLINE.
 *
 * AutoCAD RECTANG options, in the order the command offers them:
 * - Chamfer: two distances (first along the length edges, second along
 *   the width edges). Setting a chamfer clears the fillet radius, and
 *   vice versa — the two are mutually exclusive, like native CAD.
 * - Elevation: DXF group 38 — the Z of the rectangle's plane. The
 *   vertices carry the same Z, mirroring what the DXF reader does with
 *   group 38 on import (`z: d.n(38)` per vertex).
 * - Fillet: one radius, applied to all four corners as true arcs: the
 *   polyline keeps 8 vertices and a bulge of tan(22.5°) on each arc
 *   segment (a 90° arc), so the arc survives save/reload and is
 *   tessellated only for display, picking and surgery — the A7 rule.
 * - Thickness: DXF group 39 — extrusion depth along +Z. Stored on the
 *   entity; the 2D viewer draws the plan outline (no 3D extrusion view).
 * - Width: constant polyline width (DXF group 43), every segment.
 * - Area: the area plus one dimension (length or width); the other
 *   dimension is derived and the second pick fixes only the direction.
 *
 * Clamping: a fillet radius larger than half the shorter side, or a
 * chamfer distance larger than half its side, is clamped to that half
 * (two cuts on one edge must not overlap) and the applied value is
 * returned so the caller can log the clamp instead of silently
 * changing the user's number.
 */
import type { DxfPoint } from "../drawings/dxf-types";

/** A rectangle's four corners in counter-clockwise order (y-up). */
export type RectCorners = [DxfPoint, DxfPoint, DxfPoint, DxfPoint];

export interface RectOptions {
  /** Chamfer distances: d1 along the length edges, d2 along the width edges. */
  chamfer?: { d1: number; d2: number };
  /** Fillet radius; 0/absent = square corners. */
  fillet?: number;
  /** Constant polyline width (DXF group 43); 0/absent = hairline. */
  width?: number;
  /** Elevation (DXF group 38); 0/absent = the XY plane. */
  elevation?: number;
  /** Thickness (DXF group 39); 0/absent = flat. */
  thickness?: number;
}

export interface RectBuild {
  points: DxfPoint[];
  /** Bulges index-aligned with `points`; present only for filleted corners. */
  bulges?: number[];
  /** Constant width (DXF 43) when set. */
  width?: number;
  /** Elevation (DXF 38) when set; the points carry the same Z. */
  elevation?: number;
  /** Thickness (DXF 39) when set. */
  thickness?: number;
  /** Radius actually applied (clamped to half the shorter side). */
  appliedFillet?: number;
  /** Distances actually applied (each clamped to half its side). */
  appliedChamfer?: { d1: number; d2: number };
}

/** Axis-aligned corners, counter-clockwise from the lower-left. */
export function axisCorners(p1: DxfPoint, p2: DxfPoint): RectCorners {
  const x0 = Math.min(p1.x, p2.x), x1 = Math.max(p1.x, p2.x);
  const y0 = Math.min(p1.y, p2.y), y1 = Math.max(p1.y, p2.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

const sub = (a: DxfPoint, b: DxfPoint): DxfPoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: DxfPoint, b: DxfPoint): DxfPoint => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: DxfPoint, s: number): DxfPoint => ({ x: a.x * s, y: a.y * s });
const len = (a: DxfPoint): number => Math.hypot(a.x, a.y);
const unit = (a: DxfPoint): DxfPoint => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
const dot = (a: DxfPoint, b: DxfPoint): number => a.x * b.x + a.y * b.y;
const cross = (a: DxfPoint, b: DxfPoint): number => a.x * b.y - a.y * b.x;

/**
 * Build the closed LWPOLYLINE body of a rectangle from its four CCW
 * corners. A plain rectangle is 4 vertices; chamfer/fillet cut every
 * corner, giving 8 vertices (arcs for fillet, straight cuts for chamfer).
 * A degenerate (zero-width or zero-height) rectangle stays 4 plain
 * vertices — the corner cuts have no edge to cut.
 */
export function buildRect(corners: RectCorners, opts: RectOptions = {}): RectBuild {
  const [A, B, C, D] = corners;
  const length = len(sub(B, A));
  const widthSide = len(sub(C, B));
  const z = opts.elevation && opts.elevation !== 0 ? opts.elevation : undefined;
  const withZ = (p: DxfPoint): DxfPoint => (z !== undefined ? { ...p, z } : { ...p });
  const base: RectBuild = {
    points: [],
    ...(opts.width && opts.width > 0 ? { width: opts.width } : {}),
    ...(z !== undefined ? { elevation: z } : {}),
    ...(opts.thickness && opts.thickness > 0 ? { thickness: opts.thickness } : {}),
  };
  if (length < 1e-9 || widthSide < 1e-9) {
    return { ...base, points: corners.map(withZ) };
  }
  const fillet = opts.fillet && opts.fillet > 0 ? Math.min(opts.fillet, length / 2, widthSide / 2) : 0;
  const chamfer = opts.chamfer
    ? {
        d1: Math.min(Math.max(0, opts.chamfer.d1), length / 2),
        d2: Math.min(Math.max(0, opts.chamfer.d2), widthSide / 2),
      }
    : null;
  if (fillet > 0) {
    const points: DxfPoint[] = [];
    const bulges: number[] = [];
    for (let i = 0; i < 4; i++) {
      const corner = corners[i];
      const prev = corners[(i + 3) % 4];
      const next = corners[(i + 1) % 4];
      const uIn = unit(sub(corner, prev));
      const uOut = unit(sub(next, corner));
      const pIn = sub(corner, scale(uIn, fillet));
      const pOut = add(corner, scale(uOut, fillet));
      // Fillet centre: on the interior bisector, r / sin(θ/2) from the
      // corner, where θ is the angle between the two edges (90° here).
      const theta = Math.atan2(Math.abs(cross(uIn, uOut)), dot(uIn, uOut));
      const bisector = unit(sub(uOut, uIn));
      const centre = add(corner, scale(bisector, fillet / Math.sin(theta / 2)));
      // The arc from pIn to pOut subtends the same θ; bulge =
      // tan(θ/4), positive when the walk is counter-clockwise.
      const a = sub(pIn, centre), b = sub(pOut, centre);
      const included = Math.atan2(Math.abs(cross(a, b)), dot(a, b));
      const bulge = Math.tan(included / 4) * (cross(a, b) >= 0 ? 1 : -1);
      points.push(withZ(pIn), withZ(pOut));
      bulges.push(bulge, 0);
    }
    return { ...base, points, bulges, appliedFillet: fillet };
  }
  if (chamfer && (chamfer.d1 > 0 || chamfer.d2 > 0)) {
    // Edges 0 and 2 run along the length, edges 1 and 3 along the width:
    // the first distance cuts the length edges, the second the width edges.
    const points: DxfPoint[] = [];
    for (let i = 0; i < 4; i++) {
      const corner = corners[i];
      const prev = corners[(i + 3) % 4];
      const next = corners[(i + 1) % 4];
      const uIn = unit(sub(corner, prev));
      const uOut = unit(sub(next, corner));
      const dIn = (i + 3) % 4 === 0 || (i + 3) % 4 === 2 ? chamfer.d1 : chamfer.d2;
      const dOut = i === 0 || i === 2 ? chamfer.d1 : chamfer.d2;
      points.push(withZ(sub(corner, scale(uIn, dIn))), withZ(add(corner, scale(uOut, dOut))));
    }
    return { ...base, points, appliedChamfer: chamfer };
  }
  return { ...base, points: corners.map(withZ) };
}

export interface RectAreaBuild {
  corners: RectCorners;
  build: RectBuild;
  /** Length along the direction of the second pick. */
  length: number;
  /** Width perpendicular to it. */
  width: number;
}

/**
 * Area mode: the rectangle has the given area and one known dimension;
 * the other is derived (width = area / length, or length = area /
 * width). The second pick fixes only the direction of the length side —
 * its distance from the first corner is ignored, like native CAD.
 * Throws on a non-positive area or dimension.
 */
export function buildRectArea(
  first: DxfPoint,
  second: DxfPoint,
  area: number,
  fixed: { kind: "length"; value: number } | { kind: "width"; value: number },
  opts: RectOptions = {},
): RectAreaBuild {
  if (!Number.isFinite(area) || area <= 0) throw new Error("RECT: area must be greater than zero.");
  if (!Number.isFinite(fixed.value) || fixed.value <= 0) throw new Error("RECT: the given dimension must be greater than zero.");
  const length = fixed.kind === "length" ? fixed.value : area / fixed.value;
  const width = fixed.kind === "length" ? area / fixed.value : fixed.value;
  const dir = sub(second, first);
  const u = len(dir) > 1e-12 ? unit(dir) : { x: 1, y: 0 };
  const v = { x: -u.y, y: u.x };
  const corners: RectCorners = [
    { ...first },
    add(first, scale(u, length)),
    add(add(first, scale(u, length)), scale(v, width)),
    add(first, scale(v, width)),
  ];
  return { corners, build: buildRect(corners, opts), length, width };
}

export type RectOptionAction =
  | { action: "none" }
  | { action: "invalid"; message: string }
  | { action: "promptChamfer" }
  | { action: "setChamfer1"; value: number }
  | { action: "setChamfer"; d1: number; d2: number }
  | { action: "promptFillet" }
  | { action: "setFillet"; value: number }
  | { action: "promptElevation" }
  | { action: "setElevation"; value: number }
  | { action: "promptThickness" }
  | { action: "setThickness"; value: number }
  | { action: "promptWidth" }
  | { action: "setWidth"; value: number }
  | { action: "promptArea" }
  | { action: "setArea"; value: number };

/**
 * RECTANG option keywords, typed at the first-corner prompt — the same
 * shape as parseFilletChamferOption (A6): a bare keyword arms the value
 * prompt, an inline value sets it, a bad value is invalid, anything
 * else is none so the entry dispatches normally. Single letters are the
 * AutoCAD option keys (C/E/F/T/W/A); full words are accepted too.
 */
export function parseRectOption(raw: string): RectOptionAction {
  const tokens = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { action: "none" };
  const head = tokens[0];
  const num = (i: number): number | null => {
    const v = Number(tokens[i]);
    return tokens[i] !== undefined && Number.isFinite(v) ? v : null;
  };
  const needNonNegative = (v: number | null, what: string): RectOptionAction | null => {
    if (v === null || v < 0) return { action: "invalid", message: `RECT: ${what} must be zero or greater.` };
    return null;
  };
  const needPositive = (v: number | null, what: string): RectOptionAction | null => {
    if (v === null || v <= 0) return { action: "invalid", message: `RECT: ${what} must be greater than zero.` };
    return null;
  };
  if (head === "C" || head === "CHAMFER") {
    if (tokens.length === 1) return { action: "promptChamfer" };
    const bad = needPositive(num(1), "chamfer distances");
    if (bad) return bad;
    if (tokens.length === 2) return { action: "setChamfer1", value: num(1)! };
    const bad2 = needPositive(num(2), "chamfer distances");
    if (bad2) return bad2;
    return { action: "setChamfer", d1: num(1)!, d2: num(2)! };
  }
  if (head === "F" || head === "FILLET") {
    if (tokens.length === 1) return { action: "promptFillet" };
    const bad = needNonNegative(num(1), "fillet radius");
    if (bad) return bad;
    return { action: "setFillet", value: num(1)! };
  }
  if (head === "E" || head === "ELEVATION") {
    if (tokens.length === 1) return { action: "promptElevation" };
    const v = num(1);
    if (v === null) return { action: "invalid", message: "RECT: elevation must be a number." };
    return { action: "setElevation", value: v };
  }
  if (head === "T" || head === "THICKNESS") {
    if (tokens.length === 1) return { action: "promptThickness" };
    const bad = needNonNegative(num(1), "thickness");
    if (bad) return bad;
    return { action: "setThickness", value: num(1)! };
  }
  if (head === "W" || head === "WIDTH") {
    if (tokens.length === 1) return { action: "promptWidth" };
    const bad = needNonNegative(num(1), "line width");
    if (bad) return bad;
    return { action: "setWidth", value: num(1)! };
  }
  if (head === "A" || head === "AREA") {
    if (tokens.length === 1) return { action: "promptArea" };
    const bad = needPositive(num(1), "area");
    if (bad) return bad;
    return { action: "setArea", value: num(1)! };
  }
  return { action: "none" };
}
