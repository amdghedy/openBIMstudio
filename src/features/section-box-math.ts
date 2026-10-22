/** Pure maths for the section box (no THREE; unit-tested). */

export type V3 = { x: number; y: number; z: number };
export type Axis = "x" | "y" | "z";
export interface Bounds { min: V3; max: V3 }

/**
 * Parameter t along the infinite line P(t) = linePoint + t * lineDir that is
 * closest to the ray (rayOrigin + s * rayDir). Used to drag a face handle
 * along its axis under the mouse. Returns null when the ray is parallel to the axis.
 */
export function closestParamOnLine(rayOrigin: V3, rayDir: V3, linePoint: V3, lineDir: V3): number | null {
  const d1 = rayDir, d2 = lineDir;
  const r = { x: rayOrigin.x - linePoint.x, y: rayOrigin.y - linePoint.y, z: rayOrigin.z - linePoint.z };
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z;
  const e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z;
  const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
  const c = d1.x * r.x + d1.y * r.y + d1.z * r.z;
  const f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
  const denom = a * e - b * b;
  if (Math.abs(denom) < 1e-9 * a * e) return null;
  // Closest points: s on the ray, t on the line.
  return (a * f - b * c) / denom;
}

/** Move one face of a box to `value`, keeping at least `minSize` thickness. */
export function moveBoxFace(b: Bounds, axis: Axis, sign: 1 | -1, value: number, minSize = 0.1): Bounds {
  const min = { ...b.min }, max = { ...b.max };
  if (sign < 0) min[axis] = Math.min(value, max[axis] - minSize);
  else max[axis] = Math.max(value, min[axis] + minSize);
  return { min, max };
}

/** Handle edge length that keeps a roughly constant on-screen size. */
export function handleSize(cameraDistance: number, boxMaxDim: number): number {
  const s = cameraDistance * 0.035;
  return Math.min(Math.max(s, 0.1), Math.max(boxMaxDim * 0.25, 0.3));
}
