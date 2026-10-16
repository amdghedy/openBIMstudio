/**
 * Pure geometry helpers used by rule implementations.
 * Everything is metres / radians; conversion is a caller concern.
 */
import * as THREE from "three";

export interface Pt3 { x: number; y: number; z: number; }

export function distance(a: Pt3, b: Pt3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

/** Horizontal distance, ignoring Y. Use for egress travel paths. */
export function distanceXZ(a: Pt3, b: Pt3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Total length of an ordered polyline. */
export function polylineLength(points: Pt3[]): number {
  if (points.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distanceXZ(points[i - 1], points[i]);
  return sum;
}

/** AABB from min/max arrays returned by Fragments getBoxes(). */
export function boxFromArray(b: number[] | THREE.Box3): THREE.Box3 | null {
  if (b instanceof THREE.Box3) return b;
  if (!Array.isArray(b) || b.length < 6) return null;
  return new THREE.Box3(
    new THREE.Vector3(b[0], b[1], b[2]),
    new THREE.Vector3(b[3], b[4], b[5]),
  );
}

/**
 * Ground-plane footprint from a 3D box: returns the rectangle in XZ and
 * the vertical extent separately. Useful for fire egress and accessibility
 * rules that care about plan geometry.
 */
export function footprint(box: THREE.Box3): {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  height: number;
  widthX: number;
  widthZ: number;
  centerX: number;
  centerZ: number;
} {
  return {
    minX: box.min.x, maxX: box.max.x,
    minZ: box.min.z, maxZ: box.max.z,
    height: box.max.y - box.min.y,
    widthX: box.max.x - box.min.x,
    widthZ: box.max.z - box.min.z,
    centerX: (box.min.x + box.max.x) / 2,
    centerZ: (box.min.z + box.max.z) / 2,
  };
}

/** Slope in radians from a rise and a run (both metres). */
export function slopeAngle(rise: number, run: number): number {
  if (run <= 1e-9) return Math.PI / 2;
  return Math.atan(rise / Math.abs(run));
}

/** Convert a 4×4 column-major matrix (Three.js) to YXZ euler degrees. */
export function yawFromMatrix(m: number[] | Float32Array): number {
  const m4 = new THREE.Matrix4().fromArray(Array.from(m));
  const e = new THREE.Euler().setFromRotationMatrix(m4, "YXZ");
  return (e.y * 180) / Math.PI;
}