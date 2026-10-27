/**
 * Derive linear wall/beam parameters from triangle positions (local or world).
 * Used so Native Twin walls satisfy the parametric height-edit pipeline.
 */

export type PlanPt = [number, number];

export interface DerivedLinearParams {
  start: PlanPt;
  end: PlanPt;
  elevation: number;
  height: number;
  thickness: number;
  /** World-space center used for mesh placement when geometry is centered. */
  center: [number, number, number];
  /** True when a reliable baseline was recovered from geometry. */
  reliable: boolean;
}

/**
 * @param positions Flat xyz triples (local mesh space — typically centered).
 * @param worldPosition Mesh placement (added to local vertices).
 * @param worldQuaternion Optional unit quaternion [x,y,z,w].
 * @param worldScale Optional scale.
 */
export function deriveLinearParamsFromPositions(
  positions: ArrayLike<number>,
  worldPosition: [number, number, number] = [0, 0, 0],
  worldQuaternion: [number, number, number, number] = [0, 0, 0, 1],
  worldScale: [number, number, number] = [1, 1, 1],
): DerivedLinearParams | null {
  const n = Math.floor(positions.length / 3);
  if (n < 3) return null;

  const [px, py, pz] = worldPosition;
  const [sx, sy, sz] = worldScale;
  const [qx, qy, qz, qw] = worldQuaternion;

  // Rotate vector by quaternion
  const rotate = (x: number, y: number, z: number) => {
    // q * v * q^-1
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return {
      x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
    };
  };

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < n; i++) {
    let x = Number(positions[i * 3]) * sx;
    let y = Number(positions[i * 3 + 1]) * sy;
    let z = Number(positions[i * 3 + 2]) * sz;
    if (![x, y, z].every(Number.isFinite)) continue;
    const r = rotate(x, y, z);
    xs.push(r.x + px);
    ys.push(r.y + py);
    zs.push(r.z + pz);
  }
  if (xs.length < 3) return null;

  let minY = Infinity, maxY = -Infinity;
  let meanX = 0, meanZ = 0;
  for (let i = 0; i < xs.length; i++) {
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
    meanX += xs[i];
    meanZ += zs[i];
  }
  meanX /= xs.length;
  meanZ /= zs.length;
  const height = maxY - minY;
  if (!Number.isFinite(height) || height < 1e-6) return null;

  // 2D covariance on XZ for principal axis
  let cxx = 0, czz = 0, cxz = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - meanX;
    const dz = zs[i] - meanZ;
    cxx += dx * dx;
    czz += dz * dz;
    cxz += dx * dz;
  }
  // Eigenvector of larger eigenvalue
  const trace = cxx + czz;
  const det = cxx * czz - cxz * cxz;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const l1 = trace / 2 + disc;
  // (cxx - l1) * vx + cxz * vz = 0
  let dirX = cxz;
  let dirZ = l1 - cxx;
  if (Math.hypot(dirX, dirZ) < 1e-12) {
    dirX = l1 - czz;
    dirZ = cxz;
  }
  let len = Math.hypot(dirX, dirZ);
  if (len < 1e-12) {
    // Degenerate — fall back to AABB longest axis in plan
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
      minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i]);
    }
    if (maxX - minX >= maxZ - minZ) {
      dirX = 1; dirZ = 0;
    } else {
      dirX = 0; dirZ = 1;
    }
    len = 1;
  }
  dirX /= len;
  dirZ /= len;

  // Project onto axis and perpendicular
  let minP = Infinity, maxP = -Infinity;
  let minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - meanX;
    const dz = zs[i] - meanZ;
    const p = dx * dirX + dz * dirZ;
    const n = -dx * dirZ + dz * dirX;
    minP = Math.min(minP, p); maxP = Math.max(maxP, p);
    minN = Math.min(minN, n); maxN = Math.max(maxN, n);
  }
  const length = maxP - minP;
  const thickness = maxN - minN;
  if (!Number.isFinite(length) || length < 1e-4) return null;

  const start: PlanPt = [
    meanX + dirX * minP,
    meanZ + dirZ * minP,
  ];
  const end: PlanPt = [
    meanX + dirX * maxP,
    meanZ + dirZ * maxP,
  ];
  const center: [number, number, number] = [
    (start[0] + end[0]) / 2,
    (minY + maxY) / 2,
    (start[1] + end[1]) / 2,
  ];

  // Reliability: axis explains more variance than the perpendicular thickness
  const reliable = length > thickness * 1.25 && length > 0.05;

  return {
    start,
    end,
    elevation: minY,
    height,
    thickness: Math.max(thickness, 0.05),
    center,
    reliable,
  };
}
