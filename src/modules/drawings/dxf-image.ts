/** IMAGE / WIPEOUT geometry from DXF group data. Pure. */
import type { DxfPoint } from "./dxf-types";

export interface ImageGeom {
  /** Closed outline (4 corners, lower-left first) in world coordinates. */
  corners: DxfPoint[];
  center: DxfPoint;
  /** Pixel size and world size of the image. */
  pxW: number; pxH: number; worldW: number; worldH: number;
}

const add = (a: DxfPoint, u: DxfPoint, s: number, v: DxfPoint, t: number): DxfPoint => ({
  x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t, z: (a.z ?? 0) + (u.z ?? 0) * s + (v.z ?? 0) * t,
});

/** `u`/`v` are the per-pixel vectors (groups 11/12); `ins` the lower-left corner (group 10). */
export function imageGeometry(ins: DxfPoint, u: DxfPoint, v: DxfPoint, pxW: number, pxH: number): ImageGeom | null {
  if (!(pxW > 0) || !(pxH > 0)) return null;
  const c0 = ins, c1 = add(ins, u, pxW, v, 0), c2 = add(ins, u, pxW, v, pxH), c3 = add(ins, u, 0, v, pxH);
  return {
    corners: [c0, c1, c2, c3], center: add(ins, u, pxW / 2, v, pxH / 2),
    pxW, pxH, worldW: Math.hypot(u.x, u.y) * pxW, worldH: Math.hypot(v.x, v.y) * pxH,
  };
}

/**
 * Clip boundary (groups 14/24, image-pixel space whose lower-left corner is (-0.5,-0.5)) -> world loop.
 * clipType 1 = rectangle given by two opposite corners; 2 = polygon. Returns null when unusable.
 */
export function clipBoundaryLoop(
  ins: DxfPoint, u: DxfPoint, v: DxfPoint, pxW: number, pxH: number,
  clipType: number, bx: number[], by: number[],
): DxfPoint[] | null {
  const n = Math.min(bx.length, by.length);
  let pts: Array<[number, number]> = [];
  if (clipType === 1 && n >= 2) {
    const x0 = Math.min(bx[0], bx[1]), x1 = Math.max(bx[0], bx[1]), y0 = Math.min(by[0], by[1]), y1 = Math.max(by[0], by[1]);
    pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  } else if (n >= 3) {
    for (let i = 0; i < n; i++) pts.push([bx[i], by[i]]);
    const f = pts[0], l = pts[pts.length - 1];
    if (pts.length > 3 && Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) pts.pop();
  } else if (pxW > 0 && pxH > 0) {
    pts = [[-0.5, -0.5], [pxW - 0.5, -0.5], [pxW - 0.5, pxH - 0.5], [-0.5, pxH - 0.5]];
  } else return null;
  return pts.map(([x, y]) => add(ins, u, x + 0.5, v, y + 0.5));
}

export function fileLabel(path: string | undefined): string {
  if (!path) return "";
  const m = /[^\\/]+$/.exec(path.trim());
  return m ? m[0] : path.trim();
}
