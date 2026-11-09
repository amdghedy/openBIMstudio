/** Pure anchor rules for editing temporary dimensions (RVT-style).
 *  Plan: the RIGHT end stays fixed and the LEFT end moves; for a vertical wall the
 *  BOTTOM end stays fixed. Wall thickness keeps the bottom/right face fixed.
 *  Vertical: base elevation is fixed, the top moves.
 *  World plan coordinates are [x(east), z(north)]; screen-right = +x, screen-bottom = -z. */
export type Vec2 = [number, number];
const EPS = 1e-9;

/** True when `p` is further "right" than `q` (larger x; tie -> lower z, i.e. nearer the bottom). */
export function isRightOf(p: Vec2, q: Vec2): boolean {
  if (Math.abs(p[0] - q[0]) > 1e-6) return p[0] > q[0];
  return p[1] < q[1];
}

/** Resize a linear element to `value` keeping its right/bottom end fixed. */
export function lengthKeepRight(start: Vec2, end: Vec2, value: number): { start: Vec2; end: Vec2 } | null {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const len = Math.hypot(dx, dz);
  if (len < EPS || !(value > 0)) return null;
  const ux = dx / len, uz = dz / len;
  if (isRightOf(end, start)) {
    // end is fixed, start moves
    return { start: [end[0] - ux * value, end[1] - uz * value], end: [end[0], end[1]] };
  }
  // start is fixed, end moves
  return { start: [start[0], start[1]], end: [start[0] + ux * value, start[1] + uz * value] };
}

/** Change thickness keeping the bottom/right face fixed; shifts the reference line by half the change. */
export function thicknessKeepFace(start: Vec2, end: Vec2, oldT: number, value: number): { start: Vec2; end: Vec2 } | null {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const len = Math.hypot(dx, dz);
  if (len < EPS || !(value > 0)) return null;
  let nx = -dz / len, nz = dx / len; // left normal in plan
  // Fixed face lies on the side facing screen-bottom (-z), tie -> screen-right (+x).
  const facesFixed = nz < -1e-6 || (Math.abs(nz) <= 1e-6 && nx > 0);
  // Direction from the centreline toward the FIXED face:
  if (!facesFixed) { nx = -nx; nz = -nz; }
  // Fixed face position = c + n*oldT/2 must equal c' + n*value/2  ->  c' = c + n*(oldT-value)/2
  const s = (oldT - value) / 2;
  return { start: [start[0] + nx * s, start[1] + nz * s], end: [end[0] + nx * s, end[1] + nz * s] };
}

/** Change a hosted opening's width keeping its right edge fixed; returns the new centre offset along the host. */
export function openingWidthKeepRight(hostStart: Vec2, hostEnd: Vec2, offset: number, oldW: number, value: number): { offsetAlongHost: number; width: number } | null {
  const dx = hostEnd[0] - hostStart[0], dz = hostEnd[1] - hostStart[1];
  if (Math.hypot(dx, dz) < EPS || !(value > 0)) return null;
  const r = isRightOf(hostEnd, hostStart) ? 1 : -1; // host direction points toward the right?
  return { offsetAlongHost: offset + (r * (oldW - value)) / 2, width: value };
}

/** Vertical edit: base fixed, top moves (height changes). A level-bound top is released. */
export function heightKeepBase(params: { elevation?: number; topLevelId?: string; topOffset?: number }, value: number): Record<string, unknown> | null {
  if (!(value > 0)) return null;
  const patch: Record<string, unknown> = { height: Math.max(0.01, value) };
  if (params.topLevelId) { patch.topLevelId = undefined; patch.topOffset = 0; }
  return patch;
}
