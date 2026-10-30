/** Pure helpers for IFC-native style editing of Native Twins (Length, Rotation). */

export type Vec2 = [number, number];

/** Move the END point so the baseline has `newLength`, keeping start and direction. */
export function endpointForLength(start: Vec2, end: Vec2, newLength: number): Vec2 | null {
  if (!(newLength > 1e-6) || !isFinite(newLength)) return null;
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return [start[0] + newLength, start[1]];
  const k = newLength / len;
  return [start[0] + dx * k, start[1] + dz * k];
}

export function baselineLength(start?: Vec2, end?: Vec2): number {
  if (!start || !end) return 0;
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

/** Rotate point p (x,z) about pivot by `deg` around world Y (three.js convention). */
export function rotatePlanPoint(p: Vec2, pivot: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const x = p[0] - pivot[0], z = p[1] - pivot[1];
  return [pivot[0] + x * c + z * s, pivot[1] - x * s + z * c];
}

export function normalizeDeg(d: number): number {
  const r = ((d % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** Y-axis quaternion [x,y,z,w] for `deg`. */
export function yQuat(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

export function mulQuat(a: number[], b: number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** New object position/quaternion after rotating `deg` about a vertical axis through pivot (x,z). */
export function rotateTransformAboutPivot(
  position: [number, number, number],
  quaternion: [number, number, number, number],
  pivot: Vec2,
  deg: number,
) {
  const p = rotatePlanPoint([position[0], position[2]], pivot, deg);
  return {
    position: [p[0], position[1], p[1]] as [number, number, number],
    quaternion: mulQuat(yQuat(deg), quaternion),
  };
}

/** Vertical shift of a Native Twin from an elevation / level-constraint edit (0 when no baseline recorded). */
export function twinElevationShift(elevation: unknown, baseElevation: unknown): number {
  const e = Number(elevation), b = Number(baseElevation);
  if (baseElevation == null || !Number.isFinite(e) || !Number.isFinite(b)) return 0;
  return e - b;
}
