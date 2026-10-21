/** Pure helpers for walk mode (no THREE, unit-tested). */

/** Remove the velocity component pushing into a wall (slide along it). Normal need not face the walker. */
export function slideVelocity(vx: number, vz: number, nx: number, nz: number): [number, number] {
  const len = Math.hypot(nx, nz);
  if (len < 1e-9) return [vx, vz];
  nx /= len; nz /= len;
  let d = vx * nx + vz * nz;
  // Orient the normal against the motion.
  if (d > 0) { nx = -nx; nz = -nz; d = -d; }
  return [vx - d * nx, vz - d * nz];
}

/** True when a horizontal ray hit blocks movement: close enough and the surface is wall-like (not a floor/ramp). */
export function isBlockingHit(distance: number, normalY: number, radius: number, travel: number): boolean {
  return distance <= radius + travel && Math.abs(normalY) < 0.7;
}

export function clampSpeedFactor(f: number): number {
  return Math.min(4, Math.max(0.25, f));
}

/** Yaw (about +Y, forward = (-sin, -cos)) for a horizontal direction; null when it is vertical. */
export function yawFromDirection(dx: number, dz: number): number | null {
  if (Math.hypot(dx, dz) < 1e-6) return null;
  return Math.atan2(-dx, -dz);
}

/** Nearest level index at or above/below the current eye-ground height; dir = +1 up, -1 down. */
export function nextLevelElevation(levels: number[], groundY: number, dir: 1 | -1): number | null {
  const sorted = [...levels].sort((a, b) => a - b);
  const eps = 0.05;
  if (dir > 0) return sorted.find((e) => e > groundY + eps) ?? null;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < groundY - eps) return sorted[i];
  return null;
}
