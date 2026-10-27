/**
 * Orientation-preserving plan deformation for Digital Twin source meshes.
 *
 * Source meshes are usually stored with identity quaternion and world-oriented
 * vertices. Scaling the Three.js X/Z axes shears diagonal walls. Instead we
 * scale along the wall's recovered length and thickness axes in the XZ plane
 * while leaving Y to the vertical height resize.
 */

export type V3 = [number, number, number];
export type PlanPt = [number, number];

export interface PlanAxes {
  /** Unit direction along the wall/beam in XZ (world). */
  along: [number, number];
  /** Unit direction of thickness in XZ (world), left-handed normal of along. */
  thick: [number, number];
  /** Plan origin used as scale pivot (typically footprint centre). */
  origin: [number, number];
}

/** Build plan axes from start/end baseline (world XZ). */
export function planAxesFromBaseline(start: PlanPt, end: PlanPt): PlanAxes | null {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-8)) return null;
  const along: [number, number] = [dx / len, dz / len];
  const thick: [number, number] = [-along[1], along[0]];
  const origin: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return { along, thick, origin };
}

/**
 * Deform local (identity-quat) positions for length/thickness ratios.
 * Positions are assumed to be in the same frame as transform.position will place them
 * (typically centred local space). For world-oriented centred meshes, pass the
 * mesh's placement position as worldPivot so plan axes (world) map correctly.
 *
 * @param positions Flat xyz (not mutated)
 * @param axes Plan axes in world XZ
 * @param worldPivot World position of the local origin (transform.position)
 * @param lengthRatio newLength / baseLength
 * @param thicknessRatio newThickness / baseThickness
 */
export function deformPlanDimensions(
  positions: ArrayLike<number>,
  axes: PlanAxes,
  worldPivot: V3,
  lengthRatio: number,
  thicknessRatio: number,
): Float32Array {
  const out = new Float32Array(positions.length);
  const lr = Number.isFinite(lengthRatio) && lengthRatio > 1e-6 ? lengthRatio : 1;
  const tr = Number.isFinite(thicknessRatio) && thicknessRatio > 1e-6 ? thicknessRatio : 1;
  if (Math.abs(lr - 1) < 1e-9 && Math.abs(tr - 1) < 1e-9) {
    out.set(positions as ArrayLike<number>);
    return out;
  }
  const [ax, az] = axes.along;
  const [tx, tz] = axes.thick;
  const [ox, oz] = axes.origin;
  const [px, , pz] = worldPivot;

  for (let i = 0; i + 2 < positions.length; i += 3) {
    const lx = Number(positions[i]);
    const ly = Number(positions[i + 1]);
    const lz = Number(positions[i + 2]);
    if (![lx, ly, lz].every(Number.isFinite)) {
      out[i] = lx; out[i + 1] = ly; out[i + 2] = lz;
      continue;
    }
    // World plan position of this vertex
    const wx = lx + px;
    const wz = lz + pz;
    const dx = wx - ox;
    const dz = wz - oz;
    const along = dx * ax + dz * az;
    const thick = dx * tx + dz * tz;
    const along2 = along * lr;
    const thick2 = thick * tr;
    const wx2 = ox + along2 * ax + thick2 * tx;
    const wz2 = oz + along2 * az + thick2 * tz;
    // Back to local
    out[i] = wx2 - px;
    out[i + 1] = ly;
    out[i + 2] = wz2 - pz;
  }
  return out;
}

/**
 * Resolve length ratio from start/end vs base length stored on the element.
 */
export function lengthRatioFromParams(
  start: PlanPt | undefined,
  end: PlanPt | undefined,
  baseLength: number,
): number {
  if (!start || !end || !(baseLength > 1e-8)) return 1;
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (!(len > 1e-8)) return 1;
  return len / baseLength;
}
