/** Pure geometry operations shared by the Universal 3D Grips interaction layer. */
export type XZ = [number, number];
export type FootprintGrip = "corner-nw" | "corner-ne" | "corner-se" | "corner-sw" |
  "edge-n" | "edge-e" | "edge-s" | "edge-w";

export interface PointFootprint {
  point: XZ;
  width: number;
  depth: number;
}

export const MIN_FOOTPRINT_SIZE = 0.05;
const CORNERS: Array<{ grip: FootprintGrip; sx: -1 | 1; sz: -1 | 1 }> = [
  { grip: "corner-nw", sx: -1, sz: -1 },
  { grip: "corner-ne", sx: 1, sz: -1 },
  { grip: "corner-se", sx: 1, sz: 1 },
  { grip: "corner-sw", sx: -1, sz: 1 },
];

export function pointFootprintHandles(value: PointFootprint): Array<{ grip: FootprintGrip; point: XZ }> {
  const [cx, cz] = value.point;
  const hw = Math.max(MIN_FOOTPRINT_SIZE / 2, value.width / 2);
  const hd = Math.max(MIN_FOOTPRINT_SIZE / 2, value.depth / 2);
  const corners = CORNERS.map(({ grip, sx, sz }) => ({ grip, point: [cx + sx * hw, cz + sz * hd] as XZ }));
  return [
    ...corners,
    { grip: "edge-n", point: [cx, cz - hd] },
    { grip: "edge-e", point: [cx + hw, cz] },
    { grip: "edge-s", point: [cx, cz + hd] },
    { grip: "edge-w", point: [cx - hw, cz] },
  ];
}

/** Resize a rectangular point-object footprint while keeping the opposite side/corner fixed. */
export function resizePointFootprint(
  before: PointFootprint,
  grip: FootprintGrip,
  target: XZ,
): PointFootprint | null {
  if (!target.every(Number.isFinite)) return null;
  const current = pointFootprintHandles(before).find((h) => h.grip === grip);
  if (!current) return null;
  const [cx, cz] = before.point;
  const hw = Math.max(MIN_FOOTPRINT_SIZE / 2, before.width / 2);
  const hd = Math.max(MIN_FOOTPRINT_SIZE / 2, before.depth / 2);
  const corner = CORNERS.find((c) => c.grip === grip);
  let x0 = cx - hw, x1 = cx + hw, z0 = cz - hd, z1 = cz + hd;
  if (corner) {
    if (corner.sx < 0) x1 = cx + hw; else x0 = cx - hw;
    if (corner.sz < 0) z1 = cz + hd; else z0 = cz - hd;
    if (corner.sx < 0) x0 = Math.min(target[0], x1 - MIN_FOOTPRINT_SIZE);
    else x1 = Math.max(target[0], x0 + MIN_FOOTPRINT_SIZE);
    if (corner.sz < 0) z0 = Math.min(target[1], z1 - MIN_FOOTPRINT_SIZE);
    else z1 = Math.max(target[1], z0 + MIN_FOOTPRINT_SIZE);
  } else if (grip === "edge-w") x0 = Math.min(target[0], x1 - MIN_FOOTPRINT_SIZE);
  else if (grip === "edge-e") x1 = Math.max(target[0], x0 + MIN_FOOTPRINT_SIZE);
  else if (grip === "edge-n") z0 = Math.min(target[1], z1 - MIN_FOOTPRINT_SIZE);
  else if (grip === "edge-s") z1 = Math.max(target[1], z0 + MIN_FOOTPRINT_SIZE);
  else return null;
  return { point: [(x0 + x1) / 2, (z0 + z1) / 2], width: x1 - x0, depth: z1 - z0 };
}
