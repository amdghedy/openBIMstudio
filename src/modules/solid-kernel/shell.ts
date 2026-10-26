/**
 * Shell / hollow solid technique (v0.70 "deep modeling" wave).
 *
 * Revit-grade behavior: give a closed profile a wall thickness —
 * hollow extrusions for generic models, casings, trays, shafts.
 *
 * `offsetClosedRing` is the geometric core: a miter inward/outward
 * offset of a validated simple ring. For a CCW ring the interior lies
 * to the LEFT of each directed edge, so a positive offset moves each
 * edge toward the interior (inward / shrink). Vertices are rebuilt as
 * the intersection of the two adjacent offset edge lines (miter join);
 * collinear vertices are removed first so the miter is always defined.
 *
 * `hollowExtrusion` builds a watertight hollow prism: outer skin
 * (extrude winding), cavity walls (reversed), and annular bottom/top
 * caps as quad strips between the two rings — the miter offset
 * preserves the vertex count, so the caps need no triangulation of a
 * polygon-with-hole. The volume identity
 *
 *     V = depth * (A_outer - A_inner)
 *
 * is exact (divergence theorem) and asserted by closed-form tests.
 *
 * Documented limits: the offset must not collapse the ring (validated:
 * self-intersection, zero-length edges, non-shrinking area throw
 * precise errors rather than returning wrong geometry). Miter spikes
 * at very acute angles are rejected through the same validations.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, ProfilePt, Pt3 } from "../adaptive";
import { validateProfile, signedArea, selfIntersects } from "./forms";
import { COINCIDENT_TOL } from "./brep";

export type ShellErrorCode =
  | "invalid-parameter"
  | "degenerate-profile"
  | "offset-self-intersects"
  | "offset-collapses";

export interface ShellError extends Error {
  code: ShellErrorCode;
}

function shellError(code: ShellErrorCode, message: string): ShellError {
  const e = new Error(message) as ShellError;
  e.code = code;
  return e;
}

// ── 2D line helpers (profile plane) ──────────────────────────────────────

interface Line2 { px: number; py: number; dx: number; dy: number; }

function offsetEdgeLine(p: ProfilePt, q: ProfilePt, d: number, side: number): Line2 {
  const len = Math.hypot(q.u - p.u, q.v - p.v);
  if (len < COINCIDENT_TOL) {
    throw shellError("degenerate-profile", "zero-length profile edge");
  }
  const dx = (q.u - p.u) / len;
  const dy = (q.v - p.v) / len;
  // Left normal of the directed edge (interior side for CCW rings).
  const nx = -dy * side * d;
  const ny = dx * side * d;
  return { px: p.u + nx, py: p.v + ny, dx, dy };
}

function lineIntersect(l1: Line2, l2: Line2): ProfilePt | null {
  const denom = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(denom) < 1e-12) return null; // parallel — collinear neighbours are pre-dropped
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / denom;
  return { u: l1.px + l1.dx * t, v: l1.py + l1.dy * t };
}

/** Drop vertices whose adjacent edges are collinear (miter undefined there). */
function dropCollinear(ring: ProfilePt[]): ProfilePt[] {
  const n = ring.length;
  const out: ProfilePt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n];
    const p = ring[i];
    const b = ring[(i + 1) % n];
    const cross1 = (p.u - a.u) * (b.v - p.v) - (p.v - a.v) * (b.u - p.u);
    const lenA = Math.hypot(p.u - a.u, p.v - a.v);
    const lenB = Math.hypot(b.u - p.u, b.v - p.v);
    if (lenA > COINCIDENT_TOL && lenB > COINCIDENT_TOL && Math.abs(cross1) / (lenA * lenB) < 1e-9) {
      continue; // collinear — the miter is undefined, drop the vertex
    }
    out.push(p);
  }
  return out;
}

// ── ring offset ──────────────────────────────────────────────────────────

/**
 * Offset an ALREADY-VALIDATED CCW ring (internal core). Positive
 * `offset` shrinks, negative grows. No re-validation of closure —
 * callers pass the stripped ring from validateProfile.
 */
function offsetRingCCW(r: ProfilePt[], offset: number): ProfilePt[] {
  const simplified = dropCollinear(r);
  if (simplified.length < 3) {
    throw shellError("offset-collapses", "profile is collinear after simplification — cannot offset");
  }

  const inward = offset > 0;
  const d = Math.abs(offset);
  const side = inward ? 1 : -1; // CCW interior is on the LEFT of each edge
  const n = simplified.length;
  const out: ProfilePt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = simplified[(i - 1 + n) % n];
    const p = simplified[i];
    const next = simplified[(i + 1) % n];
    const l1 = offsetEdgeLine(prev, p, d, side);
    const l2 = offsetEdgeLine(p, next, d, side);
    const m = lineIntersect(l1, l2);
    if (!m || !Number.isFinite(m.u) || !Number.isFinite(m.v)) {
      throw shellError("offset-collapses",
        `miter undefined at vertex ${i} — offset too large for the local geometry`);
    }
    out.push(m);
  }

  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const q = out[(i + 1) % out.length];
    if (Math.hypot(q.u - p.u, q.v - p.v) < 1e-9) {
      throw shellError("offset-collapses", `offset ${offset} collapses an edge — reduce it`);
    }
  }
  if (selfIntersects(out)) {
    throw shellError(
      "offset-self-intersects",
      `offset ${offset} makes the ring self-intersect — reduce the offset or simplify the profile`,
    );
  }
  const a0 = signedArea(simplified);
  const a1 = signedArea(out);
  if (inward && a1 >= a0 - COINCIDENT_TOL) {
    throw shellError("offset-collapses", "inward offset did not shrink the profile — reduce it");
  }
  if (!inward && a1 <= a0 + COINCIDENT_TOL) {
    throw shellError("offset-collapses", "outward offset did not grow the profile — reduce it");
  }
  return out;
}

/**
 * Offset a closed simple ring. Positive `offset` shrinks (inward),
 * negative grows (outward). Returns a ring with the same vertex count
 * (collinear vertices removed first), validated: simple, no collapsed
 * edges, area strictly shrunk/grown as requested.
 */
export function offsetClosedRing(ring: ProfilePt[], offset: number): ProfilePt[] {
  if (!Number.isFinite(offset) || Math.abs(offset) <= COINCIDENT_TOL) {
    throw shellError("invalid-parameter", `offset must be non-zero and finite, got ${offset}`);
  }
  const base = validateProfile(ring); // closed, >= 3 points, simple
  const r = signedArea(base) < 0 ? [...base].reverse() : [...base];
  return offsetRingCCW(r, offset);
}

// ── hollow extrusion ─────────────────────────────────────────────────────

export interface HollowExtrusionParams {
  profile: ProfilePt[];
  /** Extrusion depth along +z (> 0). */
  depth: number;
  /** Wall thickness (> 0, must fit inside the profile). */
  thickness: number;
  /** Start offset along +z (default 0). */
  startOffset?: number;
}

/**
 * Hollow extrusion: outer skin + cavity walls + annular caps, all
 * watertight with outward winding. The cavity is the inward-offset
 * ring extruded over the same depth.
 */
export function hollowExtrusion(params: HollowExtrusionParams): IndexedMesh {
  if (!Number.isFinite(params.depth) || params.depth <= COINCIDENT_TOL) {
    throw shellError("invalid-parameter", `depth must be > 0, got ${params.depth}`);
  }
  if (!Number.isFinite(params.thickness) || params.thickness <= COINCIDENT_TOL) {
    throw shellError("invalid-parameter", `thickness must be > 0, got ${params.thickness}`);
  }
  const base = validateProfile(params.profile);
  // Simplify FIRST so outer and inner rings share the vertex count
  // (offsetRingCCW drops collinear vertices internally).
  const outer = dropCollinear(signedArea(base) < 0 ? [...base].reverse() : [...base]);
  const inner = offsetRingCCW(outer, params.thickness); // inward; same count
  const n = outer.length;
  if (inner.length !== n) {
    // Defensive — the miter construction preserves the count.
    throw shellError("offset-collapses", "offset changed the vertex count (internal invariant)");
  }

  const z0 = params.startOffset ?? 0;
  const z1 = z0 + params.depth;
  const vertices: Pt3[] = [];
  // 0..n-1   outer bottom
  // n..2n-1  outer top
  // 2n..3n-1 inner bottom
  // 3n..4n-1 inner top
  for (const p of outer) vertices.push({ x: p.u, y: p.v, z: z0 });
  for (const p of outer) vertices.push({ x: p.u, y: p.v, z: z1 });
  for (const p of inner) vertices.push({ x: p.u, y: p.v, z: z0 });
  for (const p of inner) vertices.push({ x: p.u, y: p.v, z: z1 });

  const faces: [number, number, number][] = [];
  // Outer walls (same pattern as forms.extrude — outward).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, n + j]);
    faces.push([i, n + j, n + i]);
  }
  // Cavity walls — reversed extrude pattern (outward = INTO the cavity).
  const ib = 2 * n;
  const it = 3 * n;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([ib + j, ib + i, it + i]);
    faces.push([ib + j, it + i, it + j]);
  }
  // Bottom annulus (normal −z): traverse outer_i → inner_i → inner_j → outer_j.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, ib + i, ib + j]);
    faces.push([i, ib + j, j]);
  }
  // Top annulus (normal +z): reverse traversal.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([n + i, n + j, it + j]);
    faces.push([n + i, it + j, it + i]);
  }
  return { vertices, faces };
}

/**
 * Shell metrics for the UI/tests: outer and inner areas and the exact
 * expected volume `depth * (A_outer - A_inner)`.
 */
export function hollowMetrics(
  profile: ProfilePt[],
  depth: number,
  thickness: number,
): { outerArea: number; innerArea: number; expectedVolume: number } {
  const base = validateProfile(profile);
  const outer = signedArea(base) < 0 ? [...base].reverse() : [...base];
  const inner = offsetRingCCW(outer, thickness);
  const outerArea = signedArea(outer);
  const innerArea = signedArea(inner);
  if (outerArea <= innerArea) {
    throw shellError("offset-collapses", "inner area must be smaller than outer area");
  }
  return { outerArea, innerArea, expectedVolume: depth * (outerArea - innerArea) };
}
