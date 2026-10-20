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
