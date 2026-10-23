/**
 * Shared elbow (bend) geometry for MEP plan symbols, 3D fittings and duct trimming.
 *
 * C = where the two centrelines meet. The straight runs end at the tangent
 * points T1 (inlet) and T2 (outlet); between them the centreline follows a
 * circular arc of radius r about O. For a turn angle D the tangent length is
 * d = r * tan(|D| / 2) (equal to r only for 90 degree bends).
 * Plan coordinates: x east, z north; directions are atan2(dz, dx).
 */
export type P = [number, number];

export interface ElbowGeom {
  T1: P;
  T2: P;
  O: P;
  r: number;
  tangent: number;
  /** Angle of T1 as seen from O, and signed sweep to T2 (radians). */
  startAngle: number;
  sweep: number;
}

/** Signed turn from incoming to outgoing direction, normalised to (-PI, PI]. */
export function turnAngle(aIn: number, aOut: number): number {
  let d = aOut - aIn;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export function tangentLength(r: number, aIn: number, aOut: number): number {
  return r * Math.tan(Math.abs(turnAngle(aIn, aOut)) / 2);
}

/** Revit-style default: centreline radius of 1.5 x the duct/pipe width. */
export function defaultBendRadius(width: number): number {
  return Math.max(0.025, 1.5 * width);
}

/** Shrink the radius so the tangent length never exceeds `frac` of the shorter adjoining run. */
export function clampBendRadius(r: number, turn: number, prevLen: number, nextLen: number, frac = 0.45, min = 0.02): number {
  const t = Math.tan(Math.abs(turn) / 2);
  if (!(t > 1e-6)) return r;
  const maxR = (frac * Math.min(prevLen, nextLen)) / t;
  return Math.max(min, Math.min(r, maxR));
}

/** Null for (nearly) straight or fully reversed runs, where no elbow exists. */
export function elbowGeometry(C: P, aIn: number, aOut: number, r: number): ElbowGeom | null {
  const turn = turnAngle(aIn, aOut);
  if (Math.abs(turn) < 1e-3 || Math.abs(Math.abs(turn) - Math.PI) < 1e-3 || !(r > 0)) return null;
  const d = r * Math.tan(Math.abs(turn) / 2);
  const T1: P = [C[0] - Math.cos(aIn) * d, C[1] - Math.sin(aIn) * d];
  const T2: P = [C[0] + Math.cos(aOut) * d, C[1] + Math.sin(aOut) * d];
  const s = turn > 0 ? 1 : -1;
  const O: P = [T1[0] + s * -Math.sin(aIn) * r, T1[1] + s * Math.cos(aIn) * r];
  return { T1, T2, O, r, tangent: d, startAngle: Math.atan2(T1[1] - O[1], T1[0] - O[0]), sweep: turn };
}

/** Centreline (or offset, via `radius`) arc points from T1 to T2. */
export function arcPoints(g: ElbowGeom, n: number, radius = g.r): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = g.startAngle + (g.sweep * i) / n;
    out.push([g.O[0] + Math.cos(a) * radius, g.O[1] + Math.sin(a) * radius]);
  }
  return out;
}
