/**
 * Multi-section loft (v0.70 "deep modeling" wave).
 *
 * RVT's loft-through-sections technique: N >= 2 closed sections at
 * explicit or evenly spaced levels, connected by ruled side bands with
 * capped ends. Section correspondence is the same as `blend`, so a
 * 2-section loft is volume-identical to a blend (asserted to 1e-9 by
 * tests) and rectangular-to-round sections remain watertight: sections
 * with equal vertex counts pair vertices in order (exact linear
 * interpolation — intermediate sections are the interpolated profiles),
 * otherwise all sections are re-sampled at one polar-angle set shared
 * by all of them (even grid plus every vertex angle), so profile corners
 * survive resampling exactly instead of being chamfered by a fixed grid.
 *
 * Validation per the forms discipline: every section validated
 * (closed, >= 3 points, simple), levels strictly increasing and finite,
 * section count sane. Output is outward-wound and watertight; the
 * divergence-theorem volume recovers the exact value for prismatic
 * configurations (identical sections => area * level span).
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, ProfilePt, Pt3 } from "../adaptive";
import { validateProfile, signedArea, resampleByAngles, sharedSampleAngles } from "./forms";
import { COINCIDENT_TOL } from "./brep";

export type LoftErrorCode =
  | "degenerate-profile"
  | "invalid-parameter";

export interface LoftError extends Error {
  code: LoftErrorCode;
}

function loftError(code: LoftErrorCode, message: string): LoftError {
  const e = new Error(message) as LoftError;
  e.code = code;
  return e;
}

function ringCentroid(ring: ProfilePt[]): ProfilePt {
  let u = 0, v = 0;
  for (const p of ring) { u += p.u; v += p.v; }
  return { u: u / ring.length, v: v / ring.length };
}

export interface LoftParams {
  /** 2..N closed sections, bottom to top. */
  sections: ProfilePt[][];
  /**
   * Total height used when `levels` is omitted: sections are placed
   * evenly from z=0 to z=height. Ignored when `levels` is given.
   */
  height: number;
  /**
   * Explicit z-level per section (same length as `sections`,
   * strictly increasing). Overrides `height`.
   */
  levels?: number[];
}

/**
 * Loft through N sections. Sections are re-sampled to a common vertex
 * count by polar angle (shared with blend), connected by ruled bands,
 * and capped at the first and last levels.
 */
export function loftSections(params: LoftParams): IndexedMesh {
  const secs = params.sections;
  if (!Array.isArray(secs) || secs.length < 2) {
    throw loftError("degenerate-profile", `loft needs >= 2 sections, got ${Array.isArray(secs) ? secs.length : "none"}`);
  }
  if (secs.length > 64) {
    throw loftError("invalid-parameter", `loft supports at most 64 sections, got ${secs.length}`);
  }
  const rings = secs.map((s, i) => {
    let r: ProfilePt[];
    try {
      r = validateProfile(s);
    } catch (e) {
      throw loftError("degenerate-profile", `section ${i}: ${(e as Error).message}`);
    }
    return signedArea(r) < 0 ? [...r].reverse() : r;
  });

  const k = rings.length;
  let levels: number[];
  if (params.levels !== undefined) {
    if (!Array.isArray(params.levels) || params.levels.length !== k) {
      throw loftError("invalid-parameter", `levels must have ${k} entries (one per section)`);
    }
    for (let i = 0; i < k; i++) {
      if (!Number.isFinite(params.levels[i])) {
        throw loftError("invalid-parameter", `levels[${i}] is not finite`);
      }
      if (i > 0 && params.levels[i] <= params.levels[i - 1] + COINCIDENT_TOL) {
        throw loftError("invalid-parameter", `levels must be strictly increasing (levels[${i}] <= levels[${i - 1}])`);
      }
    }
    levels = [...params.levels];
  } else {
    if (!Number.isFinite(params.height) || Math.abs(params.height) <= COINCIDENT_TOL) {
      throw loftError("invalid-parameter", `height must be non-zero and finite, got ${params.height}`);
    }
    levels = rings.map((_, i) => (params.height * i) / (k - 1));
  }

  const count = Math.max(...rings.map((r) => r.length), 16);
  // Correspondence between sections. When every section has the same
  // vertex count, pair vertices in order (index correspondence): the
  // loft is then the exact linear interpolation of the profiles, so
  // intermediate sections are the interpolated shapes (a 2x2 -> 4x1
  // loft passes through the 3x1.5 rectangle at mid-height) and the volume
  // is the exact integral of the interpolated area. Polar-angle sampling
  // cannot do that for non-similar profiles: an intermediate corner sits
  // at an angle neither end profile has, so the fixed angle grid cuts it
  // (a 2x2 -> 4x1 loft came out ~4% low). When counts differ there is no
  // vertex pairing to use, so fall back to one angle set shared by all
  // sections (grid + every vertex angle) — see sharedSampleAngles.
  let resampled: ProfilePt[][];
  if (rings.every((r) => r.length === rings[0].length)) {
    resampled = rings;
  } else {
    const angles = sharedSampleAngles(rings, count);
    resampled = rings.map((r) => resampleByAngles(r, ringCentroid(r), angles));
  }

  const vertices: Pt3[] = [];
  for (let i = 0; i < k; i++) {
    for (const p of resampled[i]) vertices.push({ x: p.u, y: p.v, z: levels[i] });
  }
  const faces: [number, number, number][] = [];
  const n = resampled[0].length;
  // Bottom cap (normal −z; levels are strictly increasing).
  for (let i = 1; i < n - 1; i++) faces.push([0, i + 1, i]);
  // Top cap (normal +z).
  const topBase = (k - 1) * n;
  for (let i = 1; i < n - 1; i++) faces.push([topBase, topBase + i, topBase + i + 1]);
  // Ruled side bands between consecutive sections.
  for (let s = 0; s < k - 1; s++) {
    const b1 = s * n;
    const b2 = (s + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([b1 + i, b1 + j, b2 + j]);
      faces.push([b1 + i, b2 + j, b2 + i]);
    }
  }
  return { vertices, faces };
}

/**
 * Exact expected volume for a prismatic loft (all sections identical
 * up to the shared resampling): area × level span. Used by tests and
 * the UI report card.
 */
export function loftPrismaticVolume(area: number, levels: number[]): number {
  if (!Array.isArray(levels) || levels.length < 2) {
    throw loftError("invalid-parameter", "levels needs >= 2 entries");
  }
  return area * (levels[levels.length - 1] - levels[0]);
}
