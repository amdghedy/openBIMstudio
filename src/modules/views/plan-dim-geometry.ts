/**
 * Geometry of aligned / linear plan dimensions (shared by rendering, hit-testing and dragging).
 * Pure - no DOM. World coords: x east, z north.
 */
export interface Pt { x: number; z: number }
export interface DimLike {
  x1: number; z1: number; x2: number; z2: number;
  style: string;
  offsetMm?: number;
  axis?: "x" | "z";
  linePos?: number;
  fixedLine?: { ox: number; oz: number; ux: number; uz: number };
  chainId?: string;
}

/** Endpoints of the dimension line for aligned / linear dimensions (null for other styles). */
export function dimLineEnds(d: DimLike, p1: Pt, p2: Pt, offsetWorld: number): { a: Pt; b: Pt } | null {
  if (d.style !== "aligned" && d.style !== "linear") return null;
  let { x: x1, z: z1 } = p1, { x: x2, z: z2 } = p2;
  if (d.fixedLine) {
    const f = d.fixedLine;
    const pr = (x: number, z: number): Pt => { const t = (x - f.ox) * f.ux + (z - f.oz) * f.uz; return { x: f.ox + f.ux * t, z: f.oz + f.uz * t }; };
    return { a: pr(x1, z1), b: pr(x2, z2) };
  }
  if (d.axis && d.linePos != null) {
    return d.axis === "x"
      ? { a: { x: x1, z: d.linePos }, b: { x: x2, z: d.linePos } }
      : { a: { x: d.linePos, z: z1 }, b: { x: d.linePos, z: z2 } };
  }
  if (d.style === "linear") { if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) z2 = z1; else x2 = x1; }
  const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz) || 1;
  return {
    a: { x: x1 - (dz / L) * offsetWorld, z: z1 + (dx / L) * offsetWorld },
    b: { x: x2 - (dz / L) * offsetWorld, z: z2 + (dx / L) * offsetWorld },
  };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
  if (L2 < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/**
 * Move the dimension line so it passes through `to`, keeping its direction.
 * `viewScale` converts metres to paper mm for offset-based dimensions.
 */
export function moveDimLineTo(d: DimLike, p1: Pt, p2: Pt, to: Pt, viewScale: number): void {
  if (d.fixedLine) {
    const f = d.fixedLine;
    // new origin = the point of the line closest to `to`'s perpendicular position
    const nx = -f.uz, nz = f.ux;
    const off = (to.x - f.ox) * nx + (to.z - f.oz) * nz;
    f.ox += nx * off; f.oz += nz * off;
    return;
  }
  if (d.axis && d.linePos != null) { d.linePos = d.axis === "x" ? to.z : to.x; return; }
  let { x: x1, z: z1 } = p1, { x: x2, z: z2 } = p2;
  if (d.style === "linear") { if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) z2 = z1; else x2 = x1; }
  const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L, nz = dx / L;
  const offM = (to.x - x1) * nx + (to.z - z1) * nz;
  d.offsetMm = Math.max(-3000, Math.min(3000, (offM / Math.max(1, viewScale)) * 1000));
}
