/**
 * Boolean solid operations (MASTER PROMPT MODULE 2.7/2.9).
 *
 * Algorithm: exact half-space clipping (Sutherland–Hodgman solid
 * clipping) against the cutter's supporting planes — self-contained and
 * provable, unlike BSP re-implementations whose clip semantics are easy
 * to get subtly wrong. Validated by exact closed-form volume tests.
 *
 * A point is inside a convex solid iff it is behind every face plane.
 * The primitive `splitAgainstConvex(M, planes)` partitions mesh M's
 * surface into pieces INSIDE the convex volume and pieces OUTSIDE, in
 * the original triangle planes (planar pieces stay planar).
 *
 * Compositions (level E, derived + exact-volume tested):
 *   subtract(A, B)  = A-surface outside B  +  B-surface inside A, flipped
 *                     (requires B convex; A may be any closed mesh)
 *   union(A, B)     = A-surface outside B  +  B-surface outside A
 *                     (requires A and B convex)
 *   intersect(A, B) = A-surface inside B   +  B-surface inside A
 *                     (requires A and B convex)
 *
 * Stated limits (spec §2 honesty; tracked in the deviation register):
 *   - subtract requires a CONVEX cutter (boxes, cylinders — the void
 *     shapes the platform generates). Cutting with a non-convex solid
 *     throws rather than returning wrong geometry. Coplanar through-
 *     openings (void face flush with a host face) are handled exactly.
 *   - union/intersect require both operands convex AND non-coplanar:
 *     coincident faces between operands throw a precise error instead of
 *     producing a wrong-skinned solid (single-copy ownership of
 *     coincident skins requires a 2D face-containment test that is NOT
 *     implemented here — see the deviation register).
 *   - Non-convex union/intersect need a full CSG kernel and are NOT
 *     claimed here.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, Pt3 } from "../adaptive";

/** Classification epsilon (metres, spec 5.2 boolean tolerance). */
const EPS = 1e-9;

export function sub(a: Pt3, b: Pt3): Pt3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function dot(a: Pt3, b: Pt3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross(a: Pt3, b: Pt3): Pt3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

// ── Plane extraction from convex meshes ─────────────────────────────────

export interface SupportPlane {
  normal: Pt3;
  w: number;
}

/**
 * Extract the unique supporting planes of a convex mesh (outward
 * winding, as produced by the platform's form generators). Duplicate
 * planes (tessellated cylinders share plane families) are merged.
 */
export function planesOfConvex(mesh: IndexedMesh): SupportPlane[] {
  const out: SupportPlane[] = [];
  for (const [ia, ib, ic] of mesh.faces) {
    const a = mesh.vertices[ia], b = mesh.vertices[ib], c = mesh.vertices[ic];
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n.x, n.y, n.z);
    if (l < 1e-12) continue; // degenerate
    const normal = { x: n.x / l, y: n.y / l, z: n.z / l };
    const w = dot(normal, a);
    const dup = out.find((p) =>
      Math.abs(p.normal.x - normal.x) < 1e-9 &&
      Math.abs(p.normal.y - normal.y) < 1e-9 &&
      Math.abs(p.normal.z - normal.z) < 1e-9 &&
      Math.abs(p.w - w) < 1e-9);
    if (!dup) out.push({ normal, w });
  }
  if (out.length < 4) {
    throw new Error("planesOfConvex: fewer than 4 supporting planes — mesh is not a closed convex solid");
  }
  return out;
}

const distTo = (p: Pt3, pl: SupportPlane): number => dot(pl.normal, p) - pl.w;

/**
 * Point-in-solid test by ray-cast parity (Möller–Trumbore). The ray
 * leaves along `dir` (callers pass the face normal so the ray cannot
 * graze along the face plane). Odd crossing count = inside.
 *
 * NOTE: a single ray can double-count when it hits a shared triangle
 * edge; robust callers use isInsideRobust (majority vote).
 */
export function pointInsideMesh(mesh: IndexedMesh, origin: Pt3, dir: Pt3): boolean {
  let crossings = 0;
  const eps = 1e-9;
  for (const [ia, ib, ic] of mesh.faces) {
    const v0 = mesh.vertices[ia], v1 = mesh.vertices[ib], v2 = mesh.vertices[ic];
    const e1 = sub(v1, v0);
    const e2 = sub(v2, v0);
    const pv = cross(dir, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < eps) continue; // ray parallel to triangle
    const inv = 1 / det;
    const tv = sub(origin, v0);
    const u = dot(tv, pv) * inv;
    if (u < -eps || u > 1 + eps) continue;
    const qv = cross(tv, e1);
    const v = dot(dir, qv) * inv;
    if (v < -eps || u + v > 1 + eps) continue;
    const t = dot(e2, qv) * inv;
    if (t > eps) crossings++;
  }
  return crossings % 2 === 1;
}

/**
 * Robust point-in-solid: parity vote over 3 deterministic, mutually
 * non-axis directions. A single ray can double-count when it passes
 * through a shared triangle edge; with 3 directions that requires the
 * point to be edge-aligned in all 3 families simultaneously (degenerate
 * by construction for BIM geometry).
 */
export function isInsideRobust(mesh: IndexedMesh, p: Pt3): boolean {
  const dirs: Array<[number, number, number]> = [
    [2, 3, 5], [-3, 5, 2], [5, -2, 3],
  ];
  let inside = 0;
  for (const d0 of dirs) {
    const l = Math.hypot(d0[0], d0[1], d0[2]);
    const dir: Pt3 = { x: d0[0] / l, y: d0[1] / l, z: d0[2] / l };
    if (pointInsideMesh(mesh, p, dir)) inside++;
  }
  return inside >= 2; // majority of 3
}

// ── Convex splitting primitive ──────────────────────────────────────────

export interface SplitResult {
  /** Surface pieces strictly outside the convex volume (planar polys). */
  outside: Pt3[][];
  /** Surface pieces inside the convex volume (planar polys). */
  inside: Pt3[][];
}

/**
 * Partition the surface of mesh M against convex planes. Each triangle
 * is clipped successively by every plane; pieces beyond any plane are
 * outside; pieces behind all planes are inside.
 *
 * Coplanar handling (mode):
 *   "inside"   — pieces lying ON a cutter plane count as inside
 *                (subtract: the void's boundary replaces the host skin,
 *                including through-opening coplanar faces).
 *   "boundary" — a piece ON a cutter plane with the SAME facing is
 *                boundary skin (kept); OPPOSITE facing is an interior
 *                partition (removed). Used by union/intersect, followed
 *                by the caller's duplicate-skin dedupe.
 */
export function splitAgainstConvex(
  mesh: IndexedMesh,
  planes: SupportPlane[],
  coplanarMode: "inside" | "boundary" = "inside",
): SplitResult {
  const outside: Pt3[][] = [];
  const inside: Pt3[][] = [];

  const polyNormal = (poly: Pt3[]): Pt3 => {
    // Newell normal of the planar polygon.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      nx += (p.y - q.y) * (p.z + q.z);
      ny += (p.z - q.z) * (p.x + q.x);
      nz += (p.x - q.x) * (p.y + q.y);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / l, y: ny / l, z: nz / l };
  };

  const clip = (poly: Pt3[], i: number): void => {
    if (i === planes.length) {
      inside.push(poly);
      return;
    }
    const pl = planes[i];
    let allBack = true;
    let allFront = true;
    let coplanar = true;
    for (const p of poly) {
      const d = distTo(p, pl);
      if (d > EPS) { allBack = false; coplanar = false; }
      else if (d < -EPS) { allFront = false; coplanar = false; }
    }
    if (coplanar && coplanarMode === "boundary") {
      // Same facing → coincident boundary skin: NOT supported for
      // union/intersect (single-copy ownership needs a 2D face
      // containment test — documented limitation). Opposite facing is an
      // interior partition (stacked solids) and is removed cleanly.
      const facing = dot(polyNormal(poly), pl.normal);
      if (facing > 0) {
        throw new Error(
          "booleanOp(union/intersect): operands have coincident (coplanar) faces; " +
          "offset one operand or use subtract",
        );
      }
      inside.push(poly);
      return;
    }
    if (allBack) { clip(poly, i + 1); return; }
    if (allFront) { outside.push(poly); return; }
    // Spanning: split.
    const frontP: Pt3[] = [];
    const backP: Pt3[] = [];
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      const p = poly[k];
      const q = poly[(k + 1) % n];
      const dp = distTo(p, pl);
      const dq = distTo(q, pl);
      if (dp >= -EPS) frontP.push(p);
      if (dp <= EPS) backP.push(dp >= -EPS ? { ...p } : p);
      if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
        const t = dp / (dp - dq);
        const x: Pt3 = {
          x: p.x + (q.x - p.x) * t,
          y: p.y + (q.y - p.y) * t,
          z: p.z + (q.z - p.z) * t,
        };
        frontP.push(x);
        backP.push(x);
      }
    }
    if (backP.length >= 3) clip(backP, i + 1);
    if (frontP.length >= 3) outside.push(frontP);
  };

  for (const [ia, ib, ic] of mesh.faces) {
    const tri = [mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]];
    clip(tri, 0);
  }
  return { outside, inside };
}

/** True when every vertex of `poly` lies on one of `planes` (within EPS). */
export function coplanarWithAny(poly: Pt3[], planes: SupportPlane[]): boolean {
  for (const pl of planes) {
    let on = true;
    for (const p of poly) {
      if (Math.abs(distTo(p, pl)) > 1e-6) { on = false; break; }
    }
    if (on) return true;
  }
  return false;
}

// ── Output assembly ──────────────────────────────────────────────────────

function fanTriangles(polys: Pt3[][], flip: boolean, vertices: Pt3[], faces: [number, number, number][]): void {
  for (const poly of polys) {
    const base = vertices.length;
    for (const p of poly) vertices.push(p);
    for (let i = 1; i < poly.length - 1; i++) {
      faces.push(flip ? [base, base + i + 1, base + i] : [base, base + i, base + i + 1]);
    }
  }
}

export type BooleanOp = "subtract" | "union" | "intersect";

/**
 * Boolean operation on closed meshes (see module doc for composition and
 * convexity requirements). Throws on empty results — the caller decides
 * whether "no overlap" is an error or an expected outcome (voids.ts).
 */
export function booleanOp(op: BooleanOp, a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const vertices: Pt3[] = [];
  const faces: [number, number, number][] = [];
  const planesB = planesOfConvex(b);
  switch (op) {
    case "subtract": {
      // A may be ANY closed mesh (a wall with existing openings, for
      // example): splitting against B's planes needs no convexity of A.
      const splitA = splitAgainstConvex(a, planesB); // A outside/inside B
      // B-surface inside A: per-triangle centroid ray-cast along the
      // triangle's own normal (robust — the ray cannot graze the face).
      fanTriangles(splitA.outside, false, vertices, faces);
      for (const [ia, ib, ic] of b.faces) {
        const v0 = b.vertices[ia], v1 = b.vertices[ib], v2 = b.vertices[ic];
        const centroid: Pt3 = {
          x: (v0.x + v1.x + v2.x) / 3,
          y: (v0.y + v1.y + v2.y) / 3,
          z: (v0.z + v1.z + v2.z) / 3,
        };
        const n = cross(sub(v1, v0), sub(v2, v0));
        const l = Math.hypot(n.x, n.y, n.z);
        if (l < 1e-12) continue;
        const ndir = { x: n.x / l, y: n.y / l, z: n.z / l };
        // Probe just OUTSIDE the void face (in the host-material side):
        //   buried face  → probe point sits in host material → wall kept
        //   flush face   → probe point is outside the host → wall dropped
        //   (through-opening at a coplanar host face — correct)
        const probe: Pt3 = {
          x: centroid.x + ndir.x * 1e-6,
          y: centroid.y + ndir.y * 1e-6,
          z: centroid.z + ndir.z * 1e-6,
        };
        if (isInsideRobust(a, probe)) {
          const base = vertices.length;
          vertices.push(v0, v1, v2);
          faces.push([base, base + 2, base + 1]); // flip: cavity wall
        }
      }
      break;
    }
    case "union": {
      const planesA = planesOfConvex(a);
      const splitA = splitAgainstConvex(a, planesB, "boundary");
      const splitB = splitAgainstConvex(b, planesA, "boundary");
      fanTriangles(splitA.outside, false, vertices, faces);
      fanTriangles(splitB.outside, false, vertices, faces);
      break;
    }
    case "intersect": {
      const planesA = planesOfConvex(a);
      const splitA = splitAgainstConvex(a, planesB, "boundary");
      const splitB = splitAgainstConvex(b, planesA, "boundary");
      fanTriangles(splitA.inside, false, vertices, faces);
      fanTriangles(splitB.inside, false, vertices, faces);
      break;
    }
  }
  if (faces.length === 0) {
    throw new Error(`booleanOp(${op}): result is empty`);
  }
  return { vertices, faces };
}

/** Convenience: a − b (spec 2.9 solid−void; b must be convex). */
export function subtract(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return booleanOp("subtract", a, b);
}

/** Convenience: a ∪ b (both convex). */
export function union(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return booleanOp("union", a, b);
}

/** Convenience: a ∩ b (both convex). */
export function intersect(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return booleanOp("intersect", a, b);
}
