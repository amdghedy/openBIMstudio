/**
 * Resolve the geometry a Native Twin shows in the viewport (after Height / Thickness /
 * Length / Rotation edits) so IFC export writes the EDITED solid, not the source mesh.
 * Mirrors the exact-mesh path of authoring.ts createMesh(). Pure: no three.js.
 */
import { deformPlanDimensions, planAxesFromBaseline, lengthRatioFromParams } from "./mesh-plan-deform";
import { heightResizeTransform } from "./vertical-resize";
import { rotateTransformAboutPivot, twinElevationShift } from "./twin-dimensions";

export interface TwinExportInput {
  params: Record<string, any>;
  properties?: Record<string, any>;
  nativeGeometry: { positions: ArrayLike<number> };
  transform?: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] };
}
export interface TwinExportOutput {
  positions: ArrayLike<number>;
  transform: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] };
}

const IDENT = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

export function resolveTwinExportGeometry(el: TwinExportInput): TwinExportOutput {
  const src = el.nativeGeometry.positions;
  const tr0 = el.transform ?? IDENT;
  const props = el.properties ?? {};
  const baseH = Number(props.nativeBaseHeight) || 0;
  const baseT = Number(props.nativeBaseThickness) || 0;
  const baseLen = Number(props.nativeBaseLength) || 0;
  const h = Number(el.params.height) || baseH;
  const t = Number(el.params.thickness) || baseT;

  let positions: ArrayLike<number> = src;
  const s = el.params.start as [number, number] | undefined;
  const e = el.params.end as [number, number] | undefined;
  if (el.transform && s && e && (baseT > 1e-8 || baseLen > 1e-8)) {
    const axes = planAxesFromBaseline(s, e);
    if (axes) {
      const tr = baseT > 1e-8 ? t / baseT : 1;
      const lr = baseLen > 1e-8 ? lengthRatioFromParams(s, e, baseLen) : 1;
      if (Math.abs(tr - 1) > 1e-9 || Math.abs(lr - 1) > 1e-9) {
        positions = deformPlanDimensions(src, axes, tr0.position, lr, tr);
      }
    }
  }

  let position: [number, number, number] = [...tr0.position];
  let scale: [number, number, number] = [...tr0.scale];
  let quaternion: [number, number, number, number] = [...tr0.quaternion];
  const rs = baseH > 1e-8
    ? heightResizeTransform({ positions: src, position: tr0.position, quaternion: tr0.quaternion, scale: tr0.scale, baseHeight: baseH, newHeight: h })
    : null;
  if (rs) { scale = [scale[0], rs.scale[1], scale[2]]; position = [rs.position[0], rs.position[1], rs.position[2]]; }

  position[1] += twinElevationShift(el.params.elevation, props.nativeBaseElevation);

  const rot = Number(el.params.rotation) || 0;
  if (Math.abs(rot) > 1e-9) {
    // Pivot = plan centre of the placed (world) bounding box, like the viewport.
    const [qx, qy, qz, qw] = quaternion;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i] * scale[0], y = positions[i + 1] * scale[1], z = positions[i + 2] * scale[2];
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      const wx = x + qw * tx + (qy * tz - qz * ty) + position[0];
      const wz = z + qw * tz + (qx * ty - qy * tx) + position[2];
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    if (isFinite(minX)) {
      const r = rotateTransformAboutPivot(position, quaternion, [(minX + maxX) / 2, (minZ + maxZ) / 2], rot);
      position = r.position; quaternion = r.quaternion;
    }
  }
  return { positions, transform: { position, quaternion, scale } };
}
