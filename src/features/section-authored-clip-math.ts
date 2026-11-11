/**
 * Pure maths for cutting AUTHORED meshes with 3D section planes (no THREE).
 *
 * The app has two geometry worlds: IFC/fragment models (clipped by ThatOpen's
 * Clipper via per-material clipping planes) and authored elements — plain
 * three.js meshes in the authoring group, which the Clipper never touches.
 * These helpers power the bridge that makes authored walls, columns, slabs
 * and MEP react to the same section planes as fragments:
 *
 *   • extractClipperPlanes — read THREE-style planes out of the many Clipper
 *     item shapes across SDK versions, validating as we go;
 *   • planesKey — cheap change detection so the per-frame sync can skip the
 *     material walk while the user only orbits;
 *   • worldFaceNormal — local face normal → world space (inverse-transpose
 *     of the upper 3×3, so scaled meshes still get correct normals);
 *   • flipTowardCamera — Revit behavior: the cut keeps the side the user is
 *     looking at, so the plane normal must point away from the camera.
 */

export type V3 = { x: number; y: number; z: number };

export interface PlaneLike {
  normal: V3;
  constant: number;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asPlane(v: unknown): PlaneLike | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const n = p.normal as Record<string, unknown> | undefined;
  if (!n || !isNum(n.x) || !isNum(n.y) || !isNum(n.z)) return null;
  if (!isNum(p.constant)) return null;
  return { normal: { x: n.x, y: n.y, z: n.z }, constant: p.constant };
}

/**
 * Collect planes from Clipper items regardless of SDK shape:
 *   { plane } | { three: { plane } } | { three: plane } | plane | { planes: [...] }
 * Invalid or plane-less items are skipped; nested arrays flatten.
 */
export function extractClipperPlanes(items: unknown[]): PlaneLike[] {
  const out: PlaneLike[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 3) return;
    const direct = asPlane(v);
    if (direct) {
      out.push(direct);
      return;
    }
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.planes)) {
      for (const p of o.planes) visit(p, depth + 1);
      return;
    }
    visit(o.plane, depth + 1);
    visit(o.three, depth + 1);
  };
  for (const it of items) visit(it, 0);
  return out;
}

/** Stable change-detection key (3 decimal places per component). */
export function planesKey(planes: PlaneLike[]): string {
  return planes
    .map((p) =>
      `${p.normal.x.toFixed(3)},${p.normal.y.toFixed(3)},${p.normal.z.toFixed(3)}|${p.constant.toFixed(3)}`,
    )
    .sort()
    .join(";");
}

/**
 * Transform a local face normal to world space. THREE matrices are
 * column-major; the world normal needs the inverse-transpose of the upper
 * 3×3 (handles non-uniform scaling correctly), then normalization.
 */
export function worldFaceNormal(n: V3, m: number[]): V3 {
  // Upper 3×3 from the COLUMN-MAJOR 4×4: S[r][c] = m[c*4 + r].
  const s00 = m[0], s01 = m[4], s02 = m[8];
  const s10 = m[1], s11 = m[5], s12 = m[9];
  const s20 = m[2], s21 = m[6], s22 = m[10];

  // Inverse via adjugate (row-major inv[]).
  const b01 = s22 * s11 - s12 * s21;
  const b11 = -s22 * s10 + s12 * s20;
  const b21 = s21 * s10 - s11 * s20;
  const det = s00 * b01 + s01 * b11 + s02 * b21;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    return normalize3(n);
  }
  const inv = [
    b01 / det, (-s22 * s01 + s02 * s21) / det, (s12 * s01 - s02 * s11) / det,
    b11 / det, (s22 * s00 - s02 * s20) / det, (-s12 * s00 + s02 * s10) / det,
    b21 / det, (-s21 * s00 + s01 * s20) / det, (s11 * s00 - s01 * s10) / det,
  ];
  // World normal = (S⁻¹)ᵀ · n:  w_i = Σ_j inv[j][i] * n_j.
  const wx = inv[0] * n.x + inv[3] * n.y + inv[6] * n.z;
  const wy = inv[1] * n.x + inv[4] * n.y + inv[7] * n.z;
  const wz = inv[2] * n.x + inv[5] * n.y + inv[8] * n.z;
  return normalize3({ x: wx, y: wy, z: wz });
}

function normalize3(v: V3): V3 {
  const l = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(l) || l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Flip the plane normal so it points AWAY from the camera: the clipper keeps
 * n·p + c >= 0, i.e. the side the normal points to — which must be the side
 * the user is on. Negate when the normal points along the camera direction.
 */
export function flipTowardCamera(n: V3, camDir: V3): V3 {
  const dot = n.x * camDir.x + n.y * camDir.y + n.z * camDir.z;
  return dot > 0 ? { x: -n.x, y: -n.y, z: -n.z } : { x: n.x, y: n.y, z: n.z };
}

/**
 * Plane through `point` with the given (already camera-facing) normal — the
 * clipper keeps the camera side. THREE.Plane keeps n·p + constant >= 0, so
 * constant = -point·normal.
 */
export function planeThroughPoint(n: V3, point: V3): PlaneLike {
  return {
    normal: { x: n.x, y: n.y, z: n.z },
    constant: -(n.x * point.x + n.y * point.y + n.z * point.z),
  };
}
