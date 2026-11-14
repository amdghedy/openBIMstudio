/**
 * Universal 3D Grips Engine — pure planning and application of grip edits.
 *
 * This module is the reusable core that the 3D interaction layers consume
 * (authoring.ts grips for object categories, wall-handles.ts SVG overlay for
 * wall-like elements). It owns:
 *
 *   - grip planning: which grips an element's parameters offer
 *     (move, rotate, height, elevation, edge, scale) and where they sit
 *   - grip application: applying a drag target to parameters with
 *     validation — non-finite input and missing geometry return null,
 *     degenerate results are rejected with an explicit warning instead of
 *     silently producing broken geometry
 *
 * It is pure math over plain data — no three.js, no DOM — so tests compile
 * and run it standalone (tests/grips-engine.test.cjs).
 *
 * The existing per-category interaction systems (endpoint stretch, polygon
 * vertex/insert drags, footprint resize, hosted-offset) remain in authoring.ts
 * and wall-handles.ts; this engine extends them rather than replacing them.
 */
import { isValidBoundary, polygonArea, type Pt } from "../views/boundary-edit";

export type EngineGripKind = "move" | "rotate" | "height" | "elevation" | "edge" | "scale";

export interface EngineGrip {
  kind: EngineGripKind;
  /** World XZ position at the element's base elevation. */
  position: Pt;
  /** Polygon edge index for "edge" grips. */
  edgeIndex?: number;
  /** Human-readable label used by numeric entry and diagnostics. */
  label: string;
}

/** Minimal parameter shape the engine operates on (subset of AuthoredElement["params"]). */
export interface GripParams {
  start?: Pt;
  end?: Pt;
  polygon?: Pt[];
  point?: Pt;
  height?: number;
  elevation?: number;
}

export interface GripEditResult {
  params: GripParams;
  /** Explicit, user-facing notices about clamped or rejected parts of the edit. */
  warnings: string[];
}

export const MIN_GRIP_HEIGHT = 0.01;
/** Scale results below this plan area are rejected as degenerate. */
export const MIN_GRIP_AREA = 1e-4;

function isFinitePt(p: Pt | undefined): p is Pt {
  return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function isFinitePolygon(poly: Pt[] | undefined): poly is Pt[] {
  return !!poly && poly.length > 0 && poly.every(isFinitePt);
}

/** Clone every geometry-bearing key of the params (deep, finite-checked). */
function cloneGeometry(p: GripParams): GripParams {
  const out: GripParams = {};
  if (p.start) out.start = [p.start[0], p.start[1]];
  if (p.end) out.end = [p.end[0], p.end[1]];
  if (p.point) out.point = [p.point[0], p.point[1]];
  if (p.polygon) out.polygon = p.polygon.map((v) => [v[0], v[1]] as Pt);
  if (p.height !== undefined) out.height = p.height;
  if (p.elevation !== undefined) out.elevation = p.elevation;
  return out;
}

/** Polygon centroid (area-weighted; falls back to vertex mean for tiny slivers). */
export function polygonCentroid(poly: Pt[]): Pt {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    const cross = x1 * z2 - x2 * z1;
    a += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const v of poly) { sx += v[0]; sz += v[1]; }
    return [sx / poly.length, sz / poly.length];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** Midpoint of a linear element (start/end) — null when geometry is missing. */
export function linearMidpoint(p: GripParams): Pt | null {
  if (!isFinitePt(p.start) || !isFinitePt(p.end)) return null;
  return [(p.start[0] + p.end[0]) / 2, (p.start[1] + p.end[1]) / 2];
}

/** In-plan centre used by move/rotate/scale grips. */
export function gripCentre(p: GripParams): Pt | null {
  if (isFinitePolygon(p.polygon) && p.polygon.length >= 3) return polygonCentroid(p.polygon);
  const mid = linearMidpoint(p);
  if (mid) return mid;
  if (isFinitePt(p.point)) return [p.point[0], p.point[1]];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Grip planning
// ─────────────────────────────────────────────────────────────────────────

/**
 * Plan the engine-managed grips for an element's parameters.
 *
 *  - linear (start & end): move (midpoint), height (top mid), elevation (base mid)
 *  - polygon (≥3 vertices): move (centroid), rotate (centroid, offset), scale
 *    (centroid, offset), height (top centroid), elevation (base centroid),
 *    one edge grip per boundary edge (offset outward)
 *  - point: height + elevation (the point grip itself is the move grip)
 *
 * Returns [] when the parameters carry no editable geometry.
 */
export function planGrips(p: GripParams, opts?: { scaleOffset?: number; rotateOffset?: number }): EngineGrip[] {
  const grips: EngineGrip[] = [];
  if (!isFinitePt(p.start) && !isFinitePt(p.end) && !isFinitePt(p.point) && !isFinitePolygon(p.polygon)) {
    return grips;
  }

  const c = gripCentre(p);
  if (!c) return grips;
  const scaleOffset = opts?.scaleOffset ?? 0.6;
  const rotateOffset = opts?.rotateOffset ?? 0.45;

  if (isFinitePolygon(p.polygon) && p.polygon.length >= 3) {
    const poly = p.polygon;
    grips.push({ kind: "move", position: c, label: "Move" });
    grips.push({ kind: "rotate", position: [c[0] + rotateOffset, c[1]], label: "Rotate" });
    grips.push({ kind: "scale", position: [c[0] - scaleOffset, c[1]], label: "Scale" });
    // Edge grips sit just outside the boundary on each edge's outward normal.
    const centre = polygonCentroid(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const len = Math.hypot(ex, ez);
      if (len < 1e-9) continue; // degenerate edge — no grip
      const nx = ez / len, nz = -ex / len;
      // Outward = away from the centroid. Keep the offset ≥ 0.2 m so edge
      // grips never coincide with the on-edge vertex-insert grips.
      const sign = (mx - centre[0]) * nx + (mz - centre[1]) * nz >= 0 ? 1 : -1;
      const off = Math.max(0.2, Math.min(0.25, len * 0.15));
      grips.push({
        kind: "edge",
        edgeIndex: i,
        position: [mx + nx * off * sign, mz + nz * off * sign],
        label: `Edge ${i + 1}`,
      });
    }
  } else if (isFinitePt(p.start) && isFinitePt(p.end)) {
    grips.push({ kind: "move", position: c, label: "Move" });
  }

  const h = Number(p.height);
  if (Number.isFinite(h) && h > 0) {
    grips.push({ kind: "height", position: c, label: "Height" });
  }
  const e = Number(p.elevation);
  if (Number.isFinite(e)) {
    grips.push({ kind: "elevation", position: [c[0] + 0.3, c[1] + 0.3], label: "Elevation" });
  }
  return grips;
}

// ─────────────────────────────────────────────────────────────────────────
// Parametric transforms
// ─────────────────────────────────────────────────────────────────────────

/** Translate every plan-geometry key by (dx, dz). Null on non-finite input. */
export function translateParams(p: GripParams, dx: number, dz: number): GripParams | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
  const out = cloneGeometry(p);
  if (out.start) out.start = [out.start[0] + dx, out.start[1] + dz];
  if (out.end) out.end = [out.end[0] + dx, out.end[1] + dz];
  if (out.point) out.point = [out.point[0] + dx, out.point[1] + dz];
  if (out.polygon) out.polygon = out.polygon.map((v) => [v[0] + dx, v[1] + dz] as Pt);
  return out;
}

/** Rotate every plan-geometry key about (cx, cz) by angleRad. Null on bad input. */
export function rotateParams(p: GripParams, cx: number, cz: number, angleRad: number): GripParams | null {
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(angleRad)) return null;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const rot = (v: Pt): Pt => {
    const dx = v[0] - cx, dz = v[1] - cz;
    return [cx + dx * cos - dz * sin, cz + dx * sin + dz * cos];
  };
  const out = cloneGeometry(p);
  if (out.start) out.start = rot(out.start);
  if (out.end) out.end = rot(out.end);
  if (out.point) out.point = rot(out.point);
  if (out.polygon) out.polygon = out.polygon.map(rot);
  return out;
}

/** Uniform polygon scale about (cx, cz). Returns warnings for degenerate results. */
export function scalePolygon(
  poly: Pt[], cx: number, cz: number, factor: number,
): { polygon: Pt[]; warnings: string[] } | null {
  if (!isFinitePolygon(poly) || poly.length < 3) return null;
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(factor)) return null;
  const warnings: string[] = [];
  if (factor <= 0) {
    warnings.push("Scale factor must be positive — edit rejected");
    return null;
  }
  const out = poly.map((v) => [cx + (v[0] - cx) * factor, cz + (v[1] - cz) * factor] as Pt);
  if (!isValidBoundary(out) || Math.abs(polygonArea(out)) < MIN_GRIP_AREA) {
    warnings.push("Scaled boundary would be degenerate — edit rejected, original kept");
    return { polygon: poly.map((v) => [v[0], v[1]] as Pt), warnings };
  }
  return { polygon: out, warnings };
}

/** Translate both vertices of polygon edge `edgeIndex`. Rejects invalid results. */
export function translatePolygonEdge(
  poly: Pt[], edgeIndex: number, dx: number, dz: number,
): { polygon: Pt[]; warnings: string[] } | null {
  if (!isFinitePolygon(poly) || poly.length < 3) return null;
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= poly.length) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
  const out = poly.map((v) => [v[0], v[1]] as Pt);
  const j = (edgeIndex + 1) % out.length;
  out[edgeIndex] = [out[edgeIndex][0] + dx, out[edgeIndex][1] + dz];
  out[j] = [out[j][0] + dx, out[j][1] + dz];
  if (!isValidBoundary(out)) {
    return {
      polygon: poly.map((v) => [v[0], v[1]] as Pt),
      warnings: ["Edge move would self-intersect the boundary — edit rejected, original kept"],
    };
  }
  return { polygon: out, warnings: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// Grip application
// ─────────────────────────────────────────────────────────────────────────

export interface ApplyGripOpts {
  /** Pointer world position driving the edit (move/rotate/scale/edge). */
  target?: Pt;
  /** Exact height (m) for "height" grips (numeric entry or vertical drag). */
  height?: number;
  /** Exact elevation (m) for "elevation" grips. */
  elevation?: number;
  /** Exact rotation (radians) for "rotate" grips (numeric entry). */
  angleRad?: number;
  /** Exact uniform scale factor for "scale" grips (numeric entry). */
  scaleFactor?: number;
  /** Polygon edge index for "edge" grips. */
  edgeIndex?: number;
  /** Rotation centre override; defaults to the gripCentre of the params. */
  centre?: Pt;
}

/**
 * Apply an engine grip edit to params.
 *
 * Returns null when the edit is not applicable (non-finite target, missing
 * geometry, unknown grip) — callers keep the pre-drag state. Returns
 * warnings when a part of the edit was clamped or rejected so nothing is
 * silently lost.
 */
export function applyEngineGrip(
  kind: EngineGripKind,
  p: GripParams,
  opts: ApplyGripOpts,
): GripEditResult | null {
  const warnings: string[] = [];

  if (kind === "height") {
    const h = Number(opts.height);
    if (!Number.isFinite(h)) return null;
    const clamped = Math.max(MIN_GRIP_HEIGHT, h);
    if (clamped !== h) warnings.push(`Height clamped to minimum ${MIN_GRIP_HEIGHT} m`);
    const out = cloneGeometry(p);
    out.height = clamped;
    return { params: out, warnings };
  }

  if (kind === "elevation") {
    const e = Number(opts.elevation);
    if (!Number.isFinite(e)) return null;
    const out = cloneGeometry(p);
    out.elevation = e;
    return { params: out, warnings };
  }

  if (kind === "move") {
    if (!isFinitePt(opts.target)) return null;
    const c = gripCentre(p);
    if (!c) return null;
    const moved = translateParams(p, opts.target[0] - c[0], opts.target[1] - c[1]);
    if (!moved) return null;
    return { params: moved, warnings };
  }

  if (kind === "rotate") {
    if (!isFinitePolygon(p.polygon) || p.polygon.length < 3) return null;
    const angle = Number(opts.angleRad);
    if (!Number.isFinite(angle)) return null;
    const c = opts.centre ?? gripCentre(p);
    if (!c) return null;
    const rotated = rotateParams(p, c[0], c[1], angle);
    if (!rotated) return null;
    return { params: rotated, warnings };
  }

  if (kind === "scale") {
    if (!isFinitePolygon(p.polygon) || p.polygon.length < 3) return null;
    const c = opts.centre ?? gripCentre(p);
    if (!c) return null;
    let factor: number;
    if (Number.isFinite(opts.scaleFactor)) {
      factor = Number(opts.scaleFactor);
    } else {
      if (!isFinitePt(opts.target)) return null;
      const d0 = Math.hypot(c[0] - p.polygon[0][0], c[1] - p.polygon[0][1]);
      const d1 = Math.hypot(opts.target[0] - c[0], opts.target[1] - c[1]);
      if (d0 < 1e-9) return null;
      factor = d1 / d0;
    }
    const scaled = scalePolygon(p.polygon, c[0], c[1], factor);
    if (!scaled) return null;
    const out = cloneGeometry(p);
    out.polygon = scaled.polygon;
    return { params: out, warnings: [...warnings, ...scaled.warnings] };
  }

  if (kind === "edge") {
    if (!isFinitePolygon(p.polygon) || p.polygon.length < 3) return null;
    if (!isFinitePt(opts.target) || !Number.isInteger(opts.edgeIndex)) return null;
    const ei = opts.edgeIndex as number;
    const poly = p.polygon;
    const a = poly[ei], b = poly[(ei + 1) % poly.length];
    if (!isFinitePt(a) || !isFinitePt(b)) return null;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const moved = translatePolygonEdge(poly, ei, opts.target[0] - mx, opts.target[1] - mz);
    if (!moved) return null;
    const out = cloneGeometry(p);
    out.polygon = moved.polygon;
    return { params: out, warnings: [...warnings, ...moved.warnings] };
  }

  return null;
}
