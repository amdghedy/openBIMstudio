/**
 * Grip axis lock — pure math for Shift-constrained endpoint dragging.
 *
 * When the user drags an endpoint grip (the blue shape handles drawn by
 * wall-handles.ts, or the sphere grips in authoring.ts) holding Shift locks
 * the PERPENDICULAR direction: the dragged endpoint may only slide along the
 * element's own axis — the infinite line through the fixed (opposite)
 * endpoint and the dragged endpoint's original position. The element therefore
 * only gets longer or shorter instead of drifting sideways, exactly like a
 * constrained BIM grip edit.
 *
 * No imports — this module is compiled standalone by tests/grip-axis-lock.test.cjs.
 */

export interface AxisLock {
  /** Fixed (opposite) endpoint — the axis line passes through this point. */
  ox: number;
  oz: number;
  /** Unit direction of the axis (origin → dragged endpoint's original spot). */
  dx: number;
  dz: number;
}

export interface XZ {
  x: number;
  z: number;
}

/**
 * Build an axis lock from the fixed endpoint and the dragged endpoint
 * (ground/XZ coordinates). Returns null for a zero-length element —
 * there is no meaningful axis to lock to.
 */
export function makeAxisLock(fixed: XZ, dragged: XZ): AxisLock | null {
  const vx = dragged.x - fixed.x;
  const vz = dragged.z - fixed.z;
  const len = Math.hypot(vx, vz);
  if (!isFinite(len) || len < 1e-9) return null;
  return { ox: fixed.x, oz: fixed.z, dx: vx / len, dz: vz / len };
}

/** Signed distance along the axis from its origin (the fixed endpoint). */
export function axisT(lock: AxisLock, pt: XZ): number {
  return (pt.x - lock.ox) * lock.dx + (pt.z - lock.oz) * lock.dz;
}

/** Project a free point onto the axis line (perpendicular dropped). */
export function projectOnAxis(lock: AxisLock, pt: XZ): { x: number; z: number; t: number } {
  const t = axisT(lock, pt);
  return { x: lock.ox + lock.dx * t, z: lock.oz + lock.dz * t, t };
}

/** Perpendicular (off-axis) distance of a point from the axis line. */
export function axisPerpDist(lock: AxisLock, pt: XZ): number {
  const t = axisT(lock, pt);
  return Math.hypot(pt.x - (lock.ox + lock.dx * t), pt.z - (lock.oz + lock.dz * t));
}

/**
 * Snap a Shift-locked drag onto a candidate endpoint that is (nearly)
 * collinear with the axis — lets the user stretch the element exactly onto
 * another element's endpoint while the perpendicular direction is locked.
 * The returned point is the candidate's projection ONTO THE AXIS, so the
 * lock is never violated even if the candidate is slightly off-axis.
 *
 * @param t          current constrained position along the axis (from projectOnAxis)
 * @param candidates candidate endpoints in world XZ
 * @param tolWorld   snap tolerance in world units (derived from screen px)
 * @returns the constrained point (on the axis), or null when nothing is in range
 */
export function snapAlongAxis(
  lock: AxisLock,
  t: number,
  candidates: XZ[],
  tolWorld: number,
): { x: number; z: number } | null {
  let bestCt = 0;
  let best = false;
  for (const c of candidates) {
    if (axisPerpDist(lock, c) > tolWorld) continue;
    const ct = axisT(lock, c);
    if (Math.abs(ct - t) > tolWorld) continue;
    if (!best || Math.abs(ct - t) < Math.abs(bestCt - t)) {
      bestCt = ct;
      best = true;
    }
  }
  if (!best) return null;
  return { x: lock.ox + lock.dx * bestCt, z: lock.oz + lock.dz * bestCt };
}
