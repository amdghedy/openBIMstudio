/** Pure helpers for section planes (no THREE). A plane keeps points where n.p + constant >= 0. */
export interface PlaneLike { normal: { x: number; y: number; z: number }; constant: number }
export type Axis = "x" | "y" | "z";

const len = (n: PlaneLike["normal"]) => Math.hypot(n.x, n.y, n.z) || 1;

/** Signed distance of the plane from the world origin along its (unit) normal. */
export function planeOffset(p: PlaneLike): number {
  return -p.constant / len(p.normal);
}

/** Move the plane so its offset along the normal is exactly `d` metres. */
export function setPlaneOffset(p: PlaneLike, d: number): void {
  p.constant = -d * len(p.normal);
}

/** Move by delta metres along the normal. */
export function nudgePlane(p: PlaneLike, delta: number): void {
  setPlaneOffset(p, planeOffset(p) + delta);
}

/** Flip which side is cut away. The plane stays in the same place. */
export function reversePlane(p: PlaneLike): void {
  p.normal.x = -p.normal.x; p.normal.y = -p.normal.y; p.normal.z = -p.normal.z;
  p.constant = -p.constant;
}

/** Re-aim at a world axis, keeping the same world position along that axis and the same side. */
export function alignPlaneToAxis(p: PlaneLike, axis: Axis, anchor: { x: number; y: number; z: number }): void {
  const sign = (p.normal[axis] ?? 0) < 0 ? -1 : 1;
  p.normal.x = axis === "x" ? sign : 0;
  p.normal.y = axis === "y" ? sign : 0;
  p.normal.z = axis === "z" ? sign : 0;
  p.constant = -(anchor[axis] * sign);
}

/** Which world axis the normal points along, or null if it is oblique. */
export function dominantAxis(p: PlaneLike, tol = 1e-3): Axis | null {
  const l = len(p.normal);
  for (const a of ["x", "y", "z"] as Axis[]) if (Math.abs(Math.abs(p.normal[a]) / l - 1) < tol) return a;
  return null;
}

/** Plane for the modal: axis + position, optionally reversed. */
export function planeForAxis(axis: Axis, pos: number, reversed: boolean): PlaneLike {
  const s = reversed ? -1 : 1;
  const normal = { x: 0, y: 0, z: 0 };
  normal[axis] = s;
  return { normal, constant: -pos * s };
}
