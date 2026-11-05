/**
 * Wall sweeps & reveals — geometry generator.
 *
 * Produces 3D triangle soup for sweep/reveal profiles extruded along
 * a wall's length. Uses the same Soup pattern as m2-geometry.ts.
 *
 * Coordinate system:
 *   X = wall length (along the wall, from start to end)
 *   Y = vertical (up)
 *   Z = wall normal (lateral, perpendicular to wall length)
 *
 * The sweep profile is defined in (u, h) space where:
 *   u = lateral offset from wall centreline (positive = exterior)
 *   h = height above wall base
 *
 * For "exterior" face: u maps to +Z (exterior side)
 * For "interior" face: u maps to -Z (interior side)
 * For "both" faces: two copies, mirrored
 */

import type { SweepProfile, WallSweepPlacement } from "./types";
import { getProfile } from "./types";

type V3 = [number, number, number];

/** Simple triangle soup accumulator (same pattern as m2-geometry). */
class SweepSoup {
  p: number[] = [];
  tri(a: V3, b: V3, c: V3): void {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  quad(a: V3, b: V3, c: V3, d: V3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
}

export interface SweepGeoResult {
  positions: number[];
  color: string;
  isReveal: boolean;
}

/**
 * Generate sweep geometry for a wall.
 *
 * @param wallStart - wall start point [x, z] in world plan
 * @param wallEnd - wall end point [x, z] in world plan
 * @param wallThickness - wall thickness (m)
 * @param wallHeight - wall height (m)
 * @param wallElevation - wall base elevation (m, world Y)
 * @param placement - sweep placement config
 * @returns triangle soup positions + color, or null if profile not found
 */
export function generateWallSweep(
  wallStart: [number, number],
  wallEnd: [number, number],
  wallThickness: number,
  wallHeight: number,
  wallElevation: number,
  placement: WallSweepPlacement,
): SweepGeoResult | null {
  const profile = getProfile(placement.profileId);
  if (!profile) return null;

  const dx = wallEnd[0] - wallStart[0];
  const dz = wallEnd[1] - wallStart[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.05) return null;

  // Wall direction (unit) and normal (perpendicular, pointing exterior).
  const dirX = dx / L;
  const dirZ = dz / L;
  const normalX = dirZ;  // 90° rotation
  const normalZ = -dirX;

  // Sweep length (defaults to full wall).
  const startU = placement.startOffset ?? 0;
  const endU = placement.endOffset ?? L;
  const sweepLen = Math.max(0.01, endU - startU);

  // Profile height offset.
  const hOffset = placement.height;
  const halfT = wallThickness / 2;

  const soup = new SweepSoup();

  // For each face (exterior, interior, or both).
  const faces = placement.face === "both" ? [1, -1] : [placement.face === "exterior" ? 1 : -1];

  for (const faceSign of faces) {
    // Generate the sweep as an extruded prism: the profile is swept
    // along the wall length (X direction in local coords).
    //
    // For each profile vertex, compute its 3D position at the start
    // and end of the sweep, then build quads between consecutive
    // vertices.
    const verts0: V3[] = []; // at sweep start (u = startU)
    const verts1: V3[] = []; // at sweep end (u = endU)

    for (const [u, h] of profile.vertices) {
      // u is lateral offset from wall centreline.
      // For sweeps: u=0 = wall face, u>0 = protruding outward.
      // h is height above the sweep's base (placement.height).
      const latDist = halfT + u; // from wall centreline
      const worldH = wallElevation + hOffset + h;

      const px0 = wallStart[0] + dirX * startU + normalX * faceSign * latDist;
      const pz0 = wallStart[1] + dirZ * startU + normalZ * faceSign * latDist;
      const px1 = wallStart[0] + dirX * endU + normalX * faceSign * latDist;
      const pz1 = wallStart[1] + dirZ * endU + normalZ * faceSign * latDist;

      verts0.push([px0, worldH, pz0]);
      verts1.push([px1, worldH, pz1]);
    }

    // Build side faces (quads between consecutive profile vertices).
    for (let i = 0; i < verts0.length - 1; i++) {
      soup.quad(
        verts0[i], verts1[i], verts1[i + 1], verts0[i + 1],
      );
    }

    // Build end caps (triangle fan at sweep start and end).
    for (let i = 1; i < verts0.length - 1; i++) {
      soup.tri(verts0[0], verts0[i], verts0[i + 1]);
    }
    for (let i = 1; i < verts1.length - 1; i++) {
      soup.tri(verts1[0], verts1[i + 1], verts1[i]);
    }
  }

  return {
    positions: soup.p,
    color: profile.color,
    isReveal: profile.type === "reveal",
  };
}

/**
 * Generate all sweeps for a wall element.
 *
 * @param wallStart [x, z]
 * @param wallEnd [x, z]
 * @param wallThickness m
 * @param wallHeight m
 * @param wallElevation m (world Y of wall base)
 * @param placements array of sweep placements for this wall
 * @returns array of geometry results
 */
export function generateAllWallSweeps(
  wallStart: [number, number],
  wallEnd: [number, number],
  wallThickness: number,
  wallHeight: number,
  wallElevation: number,
  placements: WallSweepPlacement[],
): SweepGeoResult[] {
  const results: SweepGeoResult[] = [];
  for (const p of placements) {
    const geo = generateWallSweep(
      wallStart, wallEnd, wallThickness, wallHeight, wallElevation, p,
    );
    if (geo) results.push(geo);
  }
  return results;
}

/**
 * Closed cutter solid for a REVEAL (a groove cut into the wall face).
 *
 * The profile's u axis is depth into the wall here: u = 0 is the wall face and
 * u > 0 goes inward. The solid starts `OVERSHOOT` outside the face so a boolean
 * subtraction leaves a clean groove instead of a coplanar sliver. Every body is
 * closed and wound with outward normals (checked by signed volume), which is what
 * the wall's CSG needs.
 *
 * Returns null for non-reveal profiles, a wall that is too short, or a groove
 * deeper than the wall (that would cut through; it is clamped by the caller's UI
 * but refused here so a bad value cannot punch a hole).
 */
export const REVEAL_OVERSHOOT = 0.01;

export function generateRevealCutter(
  wallStart: [number, number],
  wallEnd: [number, number],
  wallThickness: number,
  wallElevation: number,
  placement: WallSweepPlacement,
): { positions: number[]; depth: number } | null {
  const profile = getProfile(placement.profileId);
  if (!profile || profile.type !== "reveal") return null;
  const dx = wallEnd[0] - wallStart[0];
  const dz = wallEnd[1] - wallStart[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.05) return null;
  const dirX = dx / L, dirZ = dz / L;
  const normalX = dirZ, normalZ = -dirX;
  const halfT = wallThickness / 2;
  const depth = Math.max(...profile.vertices.map(([u]) => u));
  if (depth >= wallThickness * 0.9) return null;

  const startU = Math.max(0, placement.startOffset ?? 0);
  const endU = Math.min(L, placement.endOffset ?? L);
  if (endU - startU < 0.01) return null;

  const faces = placement.face === "both" ? [1, -1] : [placement.face === "exterior" ? 1 : -1];
  const out: number[] = [];
  const n = profile.vertices.length;

  for (const sign of faces) {
    const ring = (along: number): V3[] => profile.vertices.map(([u, h]) => {
      const uu = u <= 1e-9 ? -REVEAL_OVERSHOOT : u; // face-side vertices sit just outside
      const lat = sign * (halfT - uu);
      return [
        wallStart[0] + dirX * along + normalX * lat,
        wallElevation + placement.height + h,
        wallStart[1] + dirZ * along + normalZ * lat,
      ] as V3;
    });
    const a = ring(startU), b = ring(endU);
    const tris: V3[][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; // includes the closing edge
      tris.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]);
    }
    for (let i = 1; i < n - 1; i++) {
      tris.push([a[0], a[i], a[i + 1]]);
      tris.push([b[0], b[i + 1], b[i]]);
    }
    // Orient outward: a closed body must have positive signed volume.
    let vol = 0;
    for (const [p, q, r] of tris) {
      vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
    for (const [p, q, r] of tris) {
      const t = vol < 0 ? [p, r, q] : [p, q, r];
      for (const v of t) out.push(v[0], v[1], v[2]);
    }
  }
  return { positions: out, depth };
}
