/**
 * Placement-safe height resize for Native Twins that keep their exact source mesh.
 *
 * A Height edit is a DIMENSION change. It scales the mesh along its local Y axis about
 * the element's BASE (lowest local vertex), then compensates the placement so that base
 * point stays where it was in world space. It never reads an absolute elevation, so it
 * cannot confuse Height with Base Elevation / Top Elevation, and it works wherever the
 * source origin sits (centre, base, or somewhere else) and under any linked-model transform.
 */
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** Rotate v by unit quaternion q = [x,y,z,w]. */
export function rotateByQuat(q: Q4, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Lowest local Y of a flat xyz array (the element's base in its own frame). */
export function localMinY(positions: ArrayLike<number>): number | null {
  let m = Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = Number(positions[i]);
    if (Number.isFinite(y) && y < m) m = y;
  }
  return Number.isFinite(m) ? m : null;
}

export interface ResizeInput {
  positions: ArrayLike<number>;
  position: V3;
  quaternion: Q4;
  scale: V3;
  /** Height the current scale corresponds to (the source/native height). */
  baseHeight: number;
  /** Requested height. */
  newHeight: number;
}

/**
 * New transform for a height edit, with the base point fixed in world space.
 * Returns null (caller must report, not guess) for non-finite or non-positive input.
 */
export function heightResizeTransform(i: ResizeInput): { position: V3; scale: V3 } | null {
  const { baseHeight: bh, newHeight: nh } = i;
  if (!(Number.isFinite(bh) && bh > 1e-9) || !(Number.isFinite(nh) && nh > 0)) return null;
  const y0 = localMinY(i.positions);
  if (y0 === null) return null;
  const sy = i.scale[1];
  const sy2 = sy * (nh / bh);
  // How far the base pivot would drift if we scaled about the local origin; undo it.
  const drift = rotateByQuat(i.quaternion, [0, (sy2 - sy) * y0, 0]);
  return {
    position: [i.position[0] - drift[0], i.position[1] - drift[1], i.position[2] - drift[2]],
    scale: [i.scale[0], sy2, i.scale[2]],
  };
}

/** World XZ centre of the footprint (bounding box of the placed vertices in plan). */
export function footprintCenterXZ(
  positions: ArrayLike<number>, position: V3, quaternion: Q4, scale: V3,
): [number, number] | null {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const v: V3 = [Number(positions[i]) * scale[0], Number(positions[i + 1]) * scale[1], Number(positions[i + 2]) * scale[2]];
    if (!v.every(Number.isFinite)) continue;
    const r = rotateByQuat(quaternion, v);
    const x = r[0] + position[0], z = r[2] + position[2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return Number.isFinite(x0 + x1 + z0 + z1) ? [(x0 + x1) / 2, (z0 + z1) / 2] : null;
}
