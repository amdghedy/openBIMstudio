/**
 * Smart Snap & Perpendicular Link — pure engine.
 *
 * While the user drags a wall endpoint near a structural column:
 *   1. Proximity (magnetic) test in plan (X/Z).
 *   2. If the wall direction is within ±ANGLE_TOL of the face normal,
 *      force exact 90° and snap the free end onto the face segment.
 *   3. Else if near a vertical edge (corner), snap to the corner.
 *   4. Face wins over corner when both are in range and angle is OK.
 *
 * No DOM / Three.js — unit-testable in Node.
 */

export interface PlanPt {
  x: number;
  z: number;
}

export interface ColumnFacePlan {
  columnId: string;
  /** Face segment endpoints in plan. */
  a: PlanPt;
  b: PlanPt;
  /** Outward unit normal in plan. */
  normal: PlanPt;
}

export interface SmartPerpSnapResult {
  mode: "face" | "corner";
  columnId: string;
  /** Snapped free-end position in plan. */
  attach: PlanPt;
  /** Unit direction fixed → free after forcing ortho (face) or original (corner). */
  direction: PlanPt;
  /** Face outward normal (plan). */
  normal: PlanPt;
  score: number;
}

export const SMART_SNAP_ANGLE_TOL_DEG = 2;
export const SMART_SNAP_PIXELS = 14;

function dist(a: PlanPt, b: PlanPt): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function projectOnSegment(p: PlanPt, a: PlanPt, b: PlanPt): PlanPt {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const len2 = ux * ux + uz * uz || 1;
  let t = ((p.x - a.x) * ux + (p.z - a.z) * uz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * ux, z: a.z + t * uz };
}

/**
 * Build four plan faces from a rectangular column footprint centered at
 * `point` with size thickness × depth (or thickness × thickness).
 */
export function rectColumnFaces(
  columnId: string,
  point: PlanPt,
  thickness: number,
  depth?: number,
): ColumnFacePlan[] {
  const hx = Math.max(thickness, 0.05) / 2;
  const hz = Math.max(depth ?? thickness, 0.05) / 2;
  const cx = point.x;
  const cz = point.z;
  // CCW footprint corners: SW, SE, NE, NW in XZ
  const sw: PlanPt = { x: cx - hx, z: cz - hz };
  const se: PlanPt = { x: cx + hx, z: cz - hz };
  const ne: PlanPt = { x: cx + hx, z: cz + hz };
  const nw: PlanPt = { x: cx - hx, z: cz + hz };
  // Edges with outward normals
  return [
    { columnId, a: sw, b: se, normal: { x: 0, z: -1 } }, // south
    { columnId, a: se, b: ne, normal: { x: 1, z: 0 } }, // east
    { columnId, a: ne, b: nw, normal: { x: 0, z: 1 } }, // north
    { columnId, a: nw, b: sw, normal: { x: -1, z: 0 } }, // west
  ];
}

/**
 * Evaluate smart snap for a dragged wall free end.
 *
 * @param fixed  wall endpoint that is not being dragged
 * @param free   candidate free endpoint (cursor / AccuDraw result)
 * @param faces  column face segments in plan
 * @param worldRadius  magnetic threshold in metres
 */
export function evaluateSmartPerpSnap(
  fixed: PlanPt,
  free: PlanPt,
  faces: ColumnFacePlan[],
  worldRadius: number,
): SmartPerpSnapResult | null {
  if (!(worldRadius > 0) || !faces.length) return null;

  const cosTol = Math.cos((SMART_SNAP_ANGLE_TOL_DEG * Math.PI) / 180);
  let best: SmartPerpSnapResult | null = null;

  const wallLen = dist(fixed, free);
  if (wallLen < 1e-6) return null;
  const d: PlanPt = {
    x: (free.x - fixed.x) / wallLen,
    z: (free.z - fixed.z) / wallLen,
  };

  for (const f of faces) {
    const attach = projectOnSegment(free, f.a, f.b);
    const dAttach = dist(free, attach);
    if (dAttach > worldRadius) continue;

    const nLen = Math.hypot(f.normal.x, f.normal.z) || 1;
    const nx = f.normal.x / nLen;
    const nz = f.normal.z / nLen;
    const absDot = Math.abs(d.x * nx + d.z * nz);

    if (absDot >= cosTol) {
      const sign = Math.sign(d.x * nx + d.z * nz) || 1;
      const score = 1000 - dAttach;
      const cand: SmartPerpSnapResult = {
        mode: "face",
        columnId: f.columnId,
        attach,
        direction: { x: nx * sign, z: nz * sign },
        normal: { x: nx, z: nz },
        score,
      };
      if (!best || cand.score > best.score) best = cand;
    }
  }

  // Corners only when no winning face snap
  if (!best || best.mode !== "face") {
    for (const f of faces) {
      for (const c of [f.a, f.b]) {
        const dC = dist(free, c);
        if (dC > worldRadius) continue;
        const score = 500 - dC;
        const cand: SmartPerpSnapResult = {
          mode: "corner",
          columnId: f.columnId,
          attach: { x: c.x, z: c.z },
          direction: d,
          normal: { x: d.x, z: d.z },
          score,
        };
        if (!best || cand.score > best.score) best = cand;
      }
    }
  }

  return best;
}

/**
 * Screen-stable magnetic radius (metres) from a pixel tolerance.
 * Matches the approach used by AccuDraw / object snap.
 */
export function smartSnapRadiusWorld(args: {
  isOrtho: boolean;
  /** Perspective: distance camera→point. Ortho: unused. */
  distance: number;
  /** Perspective vertical FOV radians; ortho unused. */
  fovY: number;
  /** Ortho: world height of view (top-bottom)/zoom. */
  orthoHeight: number;
  viewportHeightPx: number;
  pixels?: number;
}): number {
  const px = args.pixels ?? SMART_SNAP_PIXELS;
  const h = Math.max(1, args.viewportHeightPx);
  if (args.isOrtho) {
    return (px * Math.max(args.orthoHeight, 0.01)) / h;
  }
  const dist = Math.max(0.01, args.distance);
  return (px * 2 * Math.tan(args.fovY / 2) * dist) / h;
}
