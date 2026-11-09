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

/**
 * Dimensions of the BIM-style double-headed section-box arrow, in local handle
 * units (a face plane is 0.6 × 0.6). The arrow is built along local +Z —
 * which each face's rotation maps onto the outward face normal — and is
 * pre-lifted so it straddles the face: the inner head pokes slightly into
 * the crop, the outer head stands proud of the plane.
 */
export const ARROW_SPEC = {
  /** Cylindrical shaft length. */
  shaftLen: 0.34,
  /** Shaft radius. */
  shaftR: 0.014,
  /** Cone head length (one at each end). */
  coneLen: 0.12,
  /** Cone head radius. */
  coneR: 0.05,
  /** Outward lift baked into the arrow geometry (0 = centred on the face). */
  lift: 0.18,
} as const;

/** Tip-to-tip arrow length in local units. */
export function arrowTotalLength(s = ARROW_SPEC): number {
  return s.shaftLen + 2 * s.coneLen;
}

/** Outward unit normal of a box face — the direction its drag arrow points. */
export function faceNormal(axis: Axis, sign: 1 | -1): V3 {
  return {
    x: axis === "x" ? sign : 0,
    y: axis === "y" ? sign : 0,
    z: axis === "z" ? sign : 0,
  };
}

/** World-space centre of a box face (where the drag plane and its arrow sit). */
export function faceCenter(b: Bounds, axis: Axis, sign: 1 | -1): V3 {
  const c: V3 = {
    x: (b.min.x + b.max.x) / 2,
    y: (b.min.y + b.max.y) / 2,
    z: (b.min.z + b.max.z) / 2,
  };
  c[axis] = sign < 0 ? b.min[axis] : b.max[axis];
  return c;
}

/** Per-face drag handle definition: axis + sign + the rotation that maps the
 *  handle's local +Z onto the face's outward normal (single-axis rotations). */
export interface FaceDef {
  axis: Axis;
  sign: 1 | -1;
  rotation: [number, number, number];
  label: string;
}

/**
 * The six faces of the section box. Each rotation must map local +Z onto
 * faceNormal(axis, sign) — the arrow heads and the quad normal both rely on
 * this contract (guarded by tests/section-box.test.cjs).
 */
export const FACE_DEFS: FaceDef[] = [
  { axis: "x", sign: -1, rotation: [0, -Math.PI / 2, 0], label: "−X face" },
  { axis: "x", sign: 1, rotation: [0, Math.PI / 2, 0], label: "+X face" },
  { axis: "y", sign: -1, rotation: [Math.PI / 2, 0, 0], label: "−Y face (bottom)" },
  { axis: "y", sign: 1, rotation: [-Math.PI / 2, 0, 0], label: "+Y face (top)" },
  { axis: "z", sign: -1, rotation: [Math.PI, 0, 0], label: "−Z face" },
  { axis: "z", sign: 1, rotation: [0, 0, 0], label: "+Z face" },
];
