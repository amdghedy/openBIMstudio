/**
 * Plan-view snap feature detection.
 *
 * Given a cursor position in plan (world) coordinates, find the nearest
 * meaningful feature of any authored element:
 *
 *   endpoint     - a linear element's start or end
 *   corner       - two elements meeting at their endpoints
 *   intersection - two linear elements crossing in X-shape
 *   midpoint     - the middle of a linear element
 *   center       - the center point of a point element
 *   face         - a surface offset from the wall centerline
 *   nearest      - the closest point on any linear element
 *
 * Priority-ordered like BIM: Endpoint (100) > Intersection (95) >
 * Corner (92) > Midpoint (90) > Center (85) > Face (60) > Nearest (50).
 */

import type { AuthoredElement } from "../projects/types";
import type { PlanDimensionRef } from "../../features/plan-view-panel";
import { collectElementSnapPoints, pickElementSnapPoint } from "./element-snap-points";

export type PlanSnapKind =
  | "endpoint" | "corner" | "intersection" | "midpoint"
  | "center" | "face" | "nearest";

export interface PlanSnapHit {
  x: number;
  z: number;
  kind: PlanSnapKind;
  label: string;
  color: string;
  priority: number;
  ref?: PlanDimensionRef;
  distance: number;
}

const PRIORITY: Record<PlanSnapKind, number> = {
  endpoint:     100,
  intersection:  95,
  corner:        92,
  midpoint:      90,
  center:        85,
  face:          60,
  nearest:       50,
};

const LABEL: Record<PlanSnapKind, string> = {
  endpoint:     "Endpoint",
  intersection: "Intersection",
  corner:       "Corner",
  midpoint:     "Midpoint",
  center:       "Center",
  face:         "Face",
  nearest:      "Nearest",
};

const COLOR: Record<PlanSnapKind, string> = {
  endpoint:     "#F59E0B",
  intersection: "#EF4444",
  corner:       "#FBBF24",
  midpoint:     "#22C55E",
  center:       "#38BDF8",
  face:         "#38BDF8",
  nearest:      "#F59E0B",
};

interface Seg {
  id: string;
  ax: number; az: number;
  bx: number; bz: number;
  thick: number;
  tMid: number;
}

function linearSegments(elements: readonly AuthoredElement[]): Seg[] {
  const out: Seg[] = [];
  for (const el of elements) {
    const p = el.params;
    if (p.start && p.end) {
      out.push({
        id: el.id,
        ax: p.start[0], az: p.start[1],
        bx: p.end[0], bz: p.end[1],
        thick: p.thickness ?? 0.2,
        tMid: 0.5,
      });
    }
  }
  return out;
}

interface Pt { x: number; z: number; d: number; }

function segEndpoints(s: Seg): Pt[] {
  return [
    { x: s.ax, z: s.az, d: 0 },
    { x: s.bx, z: s.bz, d: 0 },
  ];
}

function distanceToSegment(px: number, pz: number, s: Seg): { x: number; z: number; d: number; t: number } {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const L2 = dx * dx + dz * dz || 1;
  let t = ((px - s.ax) * dx + (pz - s.az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  const x = s.ax + t * dx;
  const z = s.az + t * dz;
  return { x, z, d: Math.hypot(px - x, pz - z), t };
}

/** 2D segment-segment intersection. Returns null if parallel or out of range. */
function intersectSegments(
  a1x: number, a1z: number, a2x: number, a2z: number,
  b1x: number, b1z: number, b2x: number, b2z: number,
): { x: number; z: number } | null {
  const rx = a2x - a1x;
  const rz = a2z - a1z;
  const sx = b2x - b1x;
  const sz = b2z - b1z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = b1x - a1x;
  const qpz = b1z - a1z;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1x + rx * t, z: a1z + rz * t };
}

/** Nearest corner: two linear elements whose endpoints coincide. */
function findCorner(elements: AuthoredElement[], px: number, pz: number, tol: number): PlanSnapHit | null {
  const segs = linearSegments(elements);
  let best: PlanSnapHit | null = null;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      const aEnds: [number, number, number][] = [[a.ax, a.az, 0], [a.bx, a.bz, 1]];
      const bEnds: [number, number, number][] = [[b.ax, b.az, 0], [b.bx, b.bz, 1]];
      for (const ae of aEnds) {
        for (const be of bEnds) {
          const d = Math.hypot(ae[0] - be[0], ae[1] - be[1]);
          if (d > 0.05) continue;   // not coincident
          const dist = Math.hypot(px - ae[0], pz - ae[1]);
          if (dist > tol) continue;
          if (!best || dist < best.distance) {
            best = {
              x: ae[0], z: ae[1],
              kind: "corner",
              label: LABEL.corner,
              color: COLOR.corner,
              priority: PRIORITY.corner,
              distance: dist,
              ref: { kind: "static-boundary", x: ae[0], z: ae[1] },
            };
          }
        }
      }
    }
  }
  return best;
}

/** Nearest intersection: two linear elements crossing. */
function findIntersection(elements: AuthoredElement[], px: number, pz: number, tol: number): PlanSnapHit | null {
  const segs = linearSegments(elements);
  let best: PlanSnapHit | null = null;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      const hit = intersectSegments(a.ax, a.az, a.bx, a.bz, b.ax, b.az, b.bx, b.bz);
      if (!hit) continue;
      const dist = Math.hypot(px - hit.x, pz - hit.z);
      if (dist > tol) continue;
      if (!best || dist < best.distance) {
        best = {
          x: hit.x, z: hit.z,
          kind: "intersection",
          label: LABEL.intersection,
          color: COLOR.intersection,
          priority: PRIORITY.intersection,
          distance: dist,
          ref: { kind: "static-boundary", x: hit.x, z: hit.z },
        };
      }
    }
  }
  return best;
}

/** Nearest endpoint of any linear element. */
function findEndpoint(segs: Seg[], px: number, pz: number, tol: number): PlanSnapHit | null {
  let best: PlanSnapHit | null = null;
  for (const s of segs) {
    const ends: [number, number, "start" | "end"][] = [[s.ax, s.az, "start"], [s.bx, s.bz, "end"]];
    for (const [x, z, side] of ends) {
      const d = Math.hypot(px - x, pz - z);
      if (d > tol) continue;
      if (!best || d < best.distance) {
        best = {
          x, z,
          kind: "endpoint",
          label: LABEL.endpoint,
          color: COLOR.endpoint,
          priority: PRIORITY.endpoint,
          distance: d,
          ref: { kind: "linear-cap", elementId: s.id, side, t: side === "start" ? 0 : 1, n: 0 },
        };
      }
    }
  }
  return best;
}

/** Nearest midpoint of any linear element. */
function findMidpoint(segs: Seg[], px: number, pz: number, tol: number): PlanSnapHit | null {
  let best: PlanSnapHit | null = null;
  for (const s of segs) {
    const mx = (s.ax + s.bx) / 2;
    const mz = (s.az + s.bz) / 2;
    const d = Math.hypot(px - mx, pz - mz);
    if (d > tol) continue;
    if (!best || d < best.distance) {
      best = {
        x: mx, z: mz,
        kind: "midpoint",
        label: LABEL.midpoint,
        color: COLOR.midpoint,
        priority: PRIORITY.midpoint,
        distance: d,
        ref: { kind: "static-boundary", x: mx, z: mz, elementId: s.id },
      };
    }
  }
  return best;
}

/** Nearest point element center (columns, footings). */
function findCenter(elements: AuthoredElement[], px: number, pz: number, tol: number): PlanSnapHit | null {
  let best: PlanSnapHit | null = null;
  for (const el of elements) {
    const p = el.params;
    if (!p.point) continue;
    const d = Math.hypot(px - p.point[0], pz - p.point[1]);
    if (d > tol) continue;
    if (!best || d < best.distance) {
      best = {
        x: p.point[0], z: p.point[1],
        kind: "center",
        label: LABEL.center,
        color: COLOR.center,
        priority: PRIORITY.center,
        distance: d,
        ref: { kind: "static-boundary", x: p.point[0], z: p.point[1], elementId: el.id },
      };
    }
  }
  return best;
}

/** Nearest wall/MEP face (offset from centerline). */
function findFace(segs: Seg[], px: number, pz: number, tol: number): PlanSnapHit | null {
  let best: PlanSnapHit | null = null;
  for (const s of segs) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L;
    const nz = dx / L;
    const half = Math.max(0.02, s.thick / 2);
    const proj = distanceToSegment(px, pz, s);
    const sideT = Math.max(0.05, Math.min(0.95, proj.t));
    const cx = s.ax + dx * sideT;
    const cz = s.az + dz * sideT;
    for (const sign of [1, -1]) {
      const fx = cx + nx * half * sign;
      const fz = cz + nz * half * sign;
      const d = Math.hypot(px - fx, pz - fz);
      if (d > tol) continue;
      if (!best || d < best.distance) {
        best = {
          x: fx, z: fz,
          kind: "face",
          label: LABEL.face,
          color: COLOR.face,
          priority: PRIORITY.face,
          distance: d,
          ref: {
            kind: "linear-side", elementId: s.id, t: sideT,
            side: sign > 0 ? "left" : "right",
          },
        };
      }
    }
  }
  return best;
}

/** Nearest point on any linear element (fallback). */
function findNearest(segs: Seg[], px: number, pz: number, tol: number): PlanSnapHit | null {
  let best: PlanSnapHit | null = null;
  for (const s of segs) {
    const proj = distanceToSegment(px, pz, s);
    if (proj.d > tol) continue;
    if (!best || proj.d < best.distance) {
      best = {
        x: proj.x, z: proj.z,
        kind: "nearest",
        label: LABEL.nearest,
        color: COLOR.nearest,
        priority: PRIORITY.nearest,
        distance: proj.d,
        ref: { kind: "linear-side", elementId: s.id, t: proj.t, side: "left" },
      };
    }
  }
  return best;
}

/**
 * Find the best snap at a cursor position in world coordinates.
 *
 * @param elements  Authored elements to scan
 * @param px        Cursor X in world metres
 * @param pz        Cursor Z in world metres
 * @param tolerance Distance in world metres
 */
/**
 * Filter segments to those whose AABB overlaps the cursor plus `pad`.
 * This is the difference between O(n^2) and instant response.
 */
function segmentsNearCursor(
  segs: Seg[],
  px: number, pz: number,
  pad: number,
): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const minX = (s.ax < s.bx ? s.ax : s.bx) - pad;
    const maxX = (s.ax > s.bx ? s.ax : s.bx) + pad;
    const minZ = (s.az < s.bz ? s.az : s.bz) - pad;
    const maxZ = (s.az > s.bz ? s.az : s.bz) + pad;
    if (px >= minX && px <= maxX && pz >= minZ && pz <= maxZ) out.push(s);
  }
  return out;
}

function pointsNearCursor(
  elements: readonly AuthoredElement[],
  px: number, pz: number,
  pad: number,
): AuthoredElement[] {
  const out: AuthoredElement[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const p = el.params;
    if (!p.point) continue;
    const dx = p.point[0] - px;
    const dz = p.point[1] - pz;
    if (dx * dx + dz * dz <= pad * pad) out.push(el);
  }
  return out;
}
export function findPlanSnap(
  elements: readonly AuthoredElement[],
  px: number,
  pz: number,
  tolerance: number,
): PlanSnapHit | null {
  // 0. Element reference points (start / end / corners / vertices / jambs / centres)
  //    for every element type - what dimensions anchor to.
  {
    const near = elements.filter((el: any) => {
      const p = el?.params; if (!p) return false;
      const pad0 = tolerance + 0.5;
      if (p.start && p.end) {
        return px >= Math.min(p.start[0], p.end[0]) - pad0 - (p.thickness ?? 0.3) && px <= Math.max(p.start[0], p.end[0]) + pad0 + (p.thickness ?? 0.3)
          && pz >= Math.min(p.start[1], p.end[1]) - pad0 - (p.thickness ?? 0.3) && pz <= Math.max(p.start[1], p.end[1]) + pad0 + (p.thickness ?? 0.3);
      }
      return true; // polygon / point / hosted: cheap per-point test below
    });
    const pts = collectElementSnapPoints(near.length > 400 ? near.slice(0, 400) : near);
    const hit = pickElementSnapPoint(pts, px, pz, tolerance);
    if (hit) {
      const kind: PlanSnapKind = hit.kind === "start" || hit.kind === "end" ? "endpoint"
        : hit.kind === "center" ? "center" : hit.kind === "edge-mid" ? "midpoint" : "corner";
      return {
        x: hit.x, z: hit.z, kind, label: hit.label, color: COLOR[kind],
        priority: PRIORITY[kind], distance: hit.distance, ref: hit.ref as PlanDimensionRef,
      };
    }
  }
  const allSegs = linearSegments(elements);
  const pad = tolerance + 1;

  // Narrow down to features near the cursor BEFORE any O(n^2) work.
  const segs = segmentsNearCursor(allSegs, px, pz, pad);
  const nearPointEls = pointsNearCursor(elements, px, pz, pad);

  // Fast exit if nothing is nearby.
  if (segs.length === 0 && nearPointEls.length === 0) return null;

  // 1. Endpoint - highest priority, short-circuits everything else.
  const ep = findEndpoint(segs, px, pz, tolerance);
  if (ep) return ep;

  // 2. Intersection - only over the (small) nearby set.
  if (segs.length > 1) {
    const x = findIntersection(segsAsElements(segs), px, pz, tolerance);
    if (x) return x;
  }

  // 3. Corner - only over the (small) nearby set.
  if (segs.length > 1) {
    const c = findCorner(segsAsElements(segs), px, pz, tolerance);
    if (c) return c;
  }

  // 4. Midpoint
  const mid = findMidpoint(segs, px, pz, tolerance);
  if (mid) return mid;

  // 5. Center
  if (nearPointEls.length) {
    const cen = findCenter(nearPointEls, px, pz, tolerance);
    if (cen) return cen;
  }

  // 6. Face
  const face = findFace(segs, px, pz, tolerance);
  if (face) return face;

  // 7. Nearest - fallback.
  return findNearest(segs, px, pz, tolerance);
}

/**
 * Adapt a Seg[] back into the minimal AuthoredElement[] shape that
 * findIntersection / findCorner expect. Cheap - no allocation of the
 * full element, just the fields they read.
 */
function segsAsElements(segs: Seg[]): AuthoredElement[] {
  const out: AuthoredElement[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    out.push({
      id: s.id,
      type: "wall",
      name: "",
      params: {
        start: [s.ax, s.az],
        end: [s.bx, s.bz],
        height: 0,
        thickness: s.thick,
        elevation: 0,
      },
    } as unknown as AuthoredElement);
  }
  return out;
}

/**
 * Return an SVG string for the snap marker at the given paper size (mm).
 * Coordinates are centered at 0,0; caller wraps in a <g transform="translate(...)">.
 */
export function snapSvgMarkup(kind: PlanSnapKind, paperSize: number): string {
  const s = paperSize;
  const h = s / 2;
  const sw = Math.max(0.15, paperSize * 0.12);
  switch (kind) {
    case "endpoint":
      return '<rect x="' + (-h) + '" y="' + (-h) + '" width="' + s + '" height="' + s + '" fill="#F59E0B" stroke="#0B0D12" stroke-width="' + sw + '"/>';
    case "intersection":
      return '<path d="M' + (-h) + ' ' + (-h) + ' L' + h + ' ' + h + ' M' + h + ' ' + (-h) + ' L' + (-h) + ' ' + h + '" stroke="#EF4444" stroke-width="' + (sw * 1.6) + '" fill="none" stroke-linecap="round"/>';
    case "corner":
      return '<path d="M' + (-h) + ' ' + (-h) + ' L' + (-h) + ' ' + h + ' L' + h + ' ' + h + '" stroke="#FBBF24" stroke-width="' + (sw * 1.6) + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="' + (-h) + '" cy="' + (-h) + '" r="' + (paperSize * 0.16) + '" fill="#FBBF24"/>';
    case "midpoint":
      return '<polygon points="0,' + (-h) + ' ' + h + ',' + h + ' ' + (-h) + ',' + h + '" fill="#22C55E" stroke="#0B0D12" stroke-width="' + sw + '"/>';
    case "center":
      return '<circle cx="0" cy="0" r="' + h + '" fill="none" stroke="#38BDF8" stroke-width="' + (sw * 1.5) + '"/><circle cx="0" cy="0" r="' + (paperSize * 0.13) + '" fill="#38BDF8"/>';
    case "face":
      return '<rect x="' + (-h) + '" y="' + (-h) + '" width="' + s + '" height="' + s + '" fill="none" stroke="#38BDF8" stroke-width="' + (sw * 1.5) + '"/><circle cx="0" cy="0" r="' + (paperSize * 0.14) + '" fill="#38BDF8"/>';
    case "nearest":
    default:
      return '<circle cx="0" cy="0" r="' + (h * 0.65) + '" fill="#F59E0B" stroke="#0B0D12" stroke-width="' + (sw * 0.7) + '"/>';
  }
}