/**
 * GENERAL boolean solid operations (v0.70 "deep modeling" wave).
 *
 * Removes the v0.68 convex-operand restriction (Authoring Core deviation
 * D-3): union / intersect / subtract now accept ARBITRARY closed meshes
 * on BOTH sides — L-shaped masses, walls with existing openings as the
 * cutter, stepped solids, donut sections.
 *
 * Algorithm (level E, closed-form-verified by tests/v70):
 *
 *  1. PLANE-ARRANGEMENT SPLITTING. Every triangle of A is split by the
 *     plane of every B triangle — with NO early exit, because for a
 *     non-convex solid "in front of some face plane" does NOT imply
 *     outside. Splitting a convex piece by a plane yields convex pieces,
 *     so every fragment stays convex, and after the full pass each
 *     fragment lies (within tolerance) on ONE side of every cutter
 *     plane. A cutter's surface is contained in the union of its
 *     triangle planes, so a fragment that does not cross any cutter
 *     plane cannot cross the cutter's surface: it is homogeneous
 *     inside/outside.
 *
 *  2. CLASSIFICATION by probe. Each fragment is classified with the
 *     robust 3-direction majority point-in-solid test (isInsideRobust),
 *     probing the fragment centroid displaced a hair along the fragment
 *     outward normal:
 *       u = c + eps * n  (just OUTSIDE the owner solid)
 *       l = c - eps * n  (just INSIDE, the material side)
 *     Per-op membership rules (derived from the local sector test —
 *     a boundary point of the result needs a "neither solid" sector):
 *       A-fragment:  union     keep iff  !inside(B, u)
 *                    intersect keep iff   inside(B, l)
 *                    subtract  keep iff  !inside(B, l)
 *       B-fragment:  union     keep iff  !inside(A, u)
 *                    intersect keep iff   inside(A, l)
 *                    subtract  keep iff   inside(A, u)   (flipped)
 *     The subtract B-rule reuses the exact v0.68 probe convention
 *     (probe just OUTSIDE the void face, keep flipped when it lands in
 *     host material), so flush through-openings behave identically.
 *
 *  3. COPLANAR RESOLUTION. Fragments lying ON a cutter plane are split
 *     IN PLANE by (a) every cutter plane — full lines, matching the
 *     subdivision the cutter's planes create on neighbouring faces —
 *     and (b) a perpendicular cutting plane through every cutter EDGE
 *     that lies on that plane (handles edges that terminate inside the
 *     face). Each cell is then classified:
 *       - covered := the cell centroid lies inside a coplanar triangle
 *         of the other mesh on the same plane;
 *       - A-cells follow the same probe rules as above (A owns the
 *         overlap skin);
 *       - B-cells drop cells covered by a SAME-facing A triangle (the
 *         single-copy ownership rule — otherwise coincident skins
 *         would be emitted twice); every other B-cell follows the same
 *         probe rules, which correctly resolves stacked solids
 *         (opposite-facing contact) and non-convex cases such as a
 *         void landing on a step of the other solid.
 *       - subtract drops ALL coplanar B-cells: a coplanar void face is
 *         either flush with a host face (the opening must stay open —
 *         no skin) or buried (the host skin cell is kept/kept-dropped
 *         by the A-rule). This reproduces the v0.68 semantics.
 *
 *  Output is a geometrically watertight polygon soup; both sides split
 *  against each other's planes AND coplanar edge sets, so shared seams
 *  are subdivided consistently (T-junction-free for the tested
 *  configurations). validate.ts welds coincident vertices before
 *  topology counting, exactly as for the v0.68 booleans.
 *
 * Documented limits (honesty register, docs/DEEP_MODELING_V70.md):
 *  - Tangential contact (edge/point touching without crossing) is
 *    resolved at classification tolerance (1e-6 m probe), not exactly.
 *  - Cells with area below 1e-12 m² are dropped as measure-zero noise.
 *  - union(A,B) and union(B,A) produce the same shape; coplanar overlap
 *    skins are owned by A, so triangulations may differ.
 *  - Cost is O(T_A * T_B) fragment splits plus one robust inside test
 *    per fragment — fine for BIM-scale solids, not a meshing kernel.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, Pt3 } from "../adaptive";
import { dot, cross, sub, isInsideRobust, type SupportPlane } from "./csg";

const SPLIT_EPS = 1e-9; // half-space side tolerance during splitting
const ON_PLANE_EPS = 1e-8; // vertex-on-plane tolerance for coplanar tagging/edges
const PROBE_EPS = 1e-6; // probe displacement (matches v68 subtract convention)
const SLIVER_AREA2 = 1e-12; // m² — cells below this are noise

export type GeneralBooleanOp = "union" | "intersect" | "subtract";

// ── small vector helpers (csg.ts exports sub/dot/cross) ─────────────────

function add(a: Pt3, b: Pt3): Pt3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(a: Pt3, k: number): Pt3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

/** Unit normal of a triangle, or null when degenerate. */
function triNormal(tri: Pt3[]): Pt3 | null {
  const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
  const l = Math.hypot(n.x, n.y, n.z);
  if (l < 1e-12) return null;
  return { x: n.x / l, y: n.y / l, z: n.z / l };
}

/** Newell normal magnitude / 2 = polygon area (planar polys). */
function polygonArea2(poly: Pt3[]): number {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

/** Vertex-average centroid (cells are convex; average == planar centroid within tolerance). */
function centroidOf(poly: Pt3[]): Pt3 {
  let x = 0, y = 0, z = 0;
  for (const p of poly) { x += p.x; y += p.y; z += p.z; }
  const k = poly.length || 1;
  return { x: x / k, y: y / k, z: z / k };
}

// ── plane extraction (general meshes — no convexity requirement) ────────

/**
 * All triangle support planes of a mesh, exact duplicates merged (a
 * tessellated quad shares its plane). Unlike `planesOfConvex` this does
 * NOT merge co-family planes and does not require convexity.
 */
export function allPlanesOf(mesh: IndexedMesh): SupportPlane[] {
  const out: SupportPlane[] = [];
  for (const [ia, ib, ic] of mesh.faces) {
    const n = triNormal([mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]]);
    if (!n) continue;
    const w = dot(n, mesh.vertices[ia]);
    const dup = out.find(
      (p) =>
        Math.abs(p.normal.x - n.x) < 1e-9 &&
        Math.abs(p.normal.y - n.y) < 1e-9 &&
        Math.abs(p.normal.z - n.z) < 1e-9 &&
        Math.abs(p.w - w) < 1e-9,
    );
    if (!dup) out.push({ normal: n, w });
  }
  return out;
}

const distTo = (p: Pt3, pl: SupportPlane): number => dot(pl.normal, p) - pl.w;

/** Triangles of `mesh` lying entirely on `pl` (all vertices within ON_PLANE_EPS). */
function trianglesOnPlane(mesh: IndexedMesh, pl: SupportPlane): Pt3[][] {
  const tris: Pt3[][] = [];
  for (const [ia, ib, ic] of mesh.faces) {
    const v = [mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]];
    if (v.every((p) => Math.abs(distTo(p, pl)) <= ON_PLANE_EPS)) tris.push(v);
  }
  return tris;
}

/** Unique edges of `mesh` with both endpoints on `pl`, as point pairs. */
function edgesOnPlane(mesh: IndexedMesh, pl: SupportPlane): Array<[Pt3, Pt3]> {
  const key = (p: Pt3): string =>
    [p.x, p.y, p.z].map((k) => Math.round(k / 1e-7)).join(",");
  const seen = new Set<string>();
  const edges: Array<[Pt3, Pt3]> = [];
  for (const [ia, ib, ic] of mesh.faces) {
    const v = [mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]];
    for (let i = 0; i < 3; i++) {
      const p = v[i];
      const q = v[(i + 1) % 3];
      if (Math.abs(distTo(p, pl)) > ON_PLANE_EPS) continue;
      if (Math.abs(distTo(q, pl)) > ON_PLANE_EPS) continue;
      const kp = key(p);
      const kq = key(q);
      const ek = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      if (seen.has(ek)) continue;
      seen.add(ek);
      edges.push([p, q]);
    }
  }
  return edges;
}

// ── polygon splitting primitives ─────────────────────────────────────────

interface PolySplit {
  front: Pt3[] | null;
  back: Pt3[] | null;
  onPlane: boolean;
}

/** Split a convex polygon by a plane. `onPlane` = every vertex within SPLIT_EPS. */
function splitPoly(poly: Pt3[], pl: SupportPlane): PolySplit {
  let allBack = true;
  let allFront = true;
  let onPlane = true;
  for (const p of poly) {
    const d = distTo(p, pl);
    if (d > SPLIT_EPS) { allBack = false; onPlane = false; }
    else if (d < -SPLIT_EPS) { allFront = false; onPlane = false; }
  }
  if (onPlane) return { front: null, back: null, onPlane: true };
  if (allBack) return { front: null, back: poly, onPlane: false };
  if (allFront) return { front: poly, back: null, onPlane: false };

  const frontP: Pt3[] = [];
  const backP: Pt3[] = [];
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % n];
    const dp = distTo(p, pl);
    const dq = distTo(q, pl);
    if (dp >= -SPLIT_EPS) frontP.push(p);
    if (dp <= SPLIT_EPS) backP.push(dp >= -SPLIT_EPS ? { ...p } : p);
    if ((dp > SPLIT_EPS && dq < -SPLIT_EPS) || (dp < -SPLIT_EPS && dq > SPLIT_EPS)) {
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
  return {
    front: frontP.length >= 3 ? frontP : null,
    back: backP.length >= 3 ? backP : null,
    onPlane: false,
  };
}

interface Frag {
  poly: Pt3[];
  /** Index into the OTHER mesh's plane list when the fragment lies ON that plane. */
  coplanar: number | null;
}

/**
 * One cutting object of the GLOBAL cut set: a face plane or an edge-
 * perpendicular plane (contains the edge, perpendicular to the face it
 * belongs to). Splitting EVERY triangle of BOTH meshes by EVERY cut
 * object makes the subdivision seam-consistent by construction: any
 * vertex created on a face is mirrored on the neighbour across every
 * edge it touches, because the neighbour is cut by the same objects.
 * This eliminates the T-junction class that otherwise appears where a
 * cutter plane crosses a face but merely touches its neighbour (and
 * where internal triangulation diagonals cross the other mesh).
 */
interface CutObj {
  pl: SupportPlane;
  owner: "A" | "B";
  isFacePlane: boolean;
  /** Index into the owner mesh's plane list (face planes only). */
  planeIdx: number;
}

/** Face-plane + edge-perp cutting objects of one mesh, deduped. */
function cutObjectsOf(mesh: IndexedMesh, planes: SupportPlane[], owner: "A" | "B"): CutObj[] {
  const objs: CutObj[] = [];
  const seen = new Set<string>();
  const push = (pl: SupportPlane, isFacePlane: boolean, planeIdx: number): void => {
    const k =
      [pl.normal.x, pl.normal.y, pl.normal.z, pl.w].map((v) => v.toFixed(10)).join("|") +
      (isFacePlane ? `#${planeIdx}` : "");
    if (seen.has(k)) return;
    seen.add(k);
    objs.push({ pl, owner, isFacePlane, planeIdx });
  };
  for (const [ia, ib, ic] of mesh.faces) {
    const tri = [mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]];
    const nrm = triNormal(tri);
    if (!nrm) continue;
    const w = dot(nrm, tri[0]);
    let planeIdx = -1;
    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      if (
        Math.abs(p.normal.x - nrm.x) < 1e-9 && Math.abs(p.normal.y - nrm.y) < 1e-9 &&
        Math.abs(p.normal.z - nrm.z) < 1e-9 && Math.abs(p.w - w) < 1e-9
      ) { planeIdx = i; break; }
    }
    push({ normal: nrm, w }, true, planeIdx);
    for (let i = 0; i < 3; i++) {
      const p = tri[i];
      const q = tri[(i + 1) % 3];
      const d = sub(q, p);
      const dl = Math.hypot(d.x, d.y, d.z);
      if (dl < 1e-12) continue;
      const n = cross(nrm, d);
      const l = Math.hypot(n.x, n.y, n.z);
      if (l < 1e-12) continue;
      push(
        { normal: { x: n.x / l, y: n.y / l, z: n.z / l }, w: dot(n, p) / l },
        false,
        -1,
      );
    }
  }
  return objs;
}

/**
 * Split a triangle by the GLOBAL cut set (no early exit — non-convex
 * cutters make "in front of one plane" meaningless, and full cross-
 * cutting is what keeps seams consistent). A fragment landing exactly
 * on a FACE PLANE of the other mesh is tagged (first tag wins; the tag
 * survives further splitting) and is later resolved by the coplanar
 * rules. Splitting convex pieces keeps every fragment convex.
 */
function splitFragment(tri: Pt3[], cuts: CutObj[], tagOwner: "A" | "B"): Frag[] {
  let frags: Frag[] = [{ poly: tri, coplanar: null }];
  for (const cut of cuts) {
    const next: Frag[] = [];
    for (const f of frags) {
      const s = splitPoly(f.poly, cut.pl);
      if (s.onPlane) {
        const coplanar =
          f.coplanar !== null ? f.coplanar :
          cut.isFacePlane && cut.owner === tagOwner && cut.planeIdx >= 0 ? cut.planeIdx :
          null;
        next.push({ poly: f.poly, coplanar });
        continue;
      }
      if (s.back) next.push({ poly: s.back, coplanar: f.coplanar });
      if (s.front) next.push({ poly: s.front, coplanar: f.coplanar });
    }
    frags = next;
    if (frags.length === 0) break;
  }
  return frags.filter((f) => polygonArea2(f.poly) > SLIVER_AREA2);
}

/**
 * Split a coplanar polygon IN ITS PLANE along every edge line of the
 * other mesh that lies on the same plane. Each edge becomes a cutting
 * plane perpendicular to P containing the edge line, so pieces stay on
 * P. This gives seam-consistent subdivision with the other mesh's
 * coplanar faces and with faces ending on P.
 */
function splitCoplanarByEdges(poly: Pt3[], P: SupportPlane, edges: Array<[Pt3, Pt3]>): Pt3[][] {
  let cells: Pt3[][] = [poly];
  for (const [e1, e2] of edges) {
    const d = sub(e2, e1);
    const n = cross(P.normal, d);
    const l = Math.hypot(n.x, n.y, n.z);
    if (l < 1e-12) continue;
    const cut: SupportPlane = { normal: { x: n.x / l, y: n.y / l, z: n.z / l }, w: dot(n, e1) / l };
    const next: Pt3[][] = [];
    for (const c of cells) {
      const s = splitPoly(c, cut);
      if (s.onPlane) { next.push(c); continue; }
      if (s.front) next.push(s.front);
      if (s.back) next.push(s.back);
    }
    cells = next;
  }
  return cells.filter((c) => polygonArea2(c) > SLIVER_AREA2);
}

// ── coverage test (2D, boundary-inclusive) ───────────────────────────────

/**
 * Boundary-inclusive point-in-triangle via dominant-axis projection.
 * Points on an edge/corner count as inside (needed for exactly shared
 * coplanar boundaries).
 */
function pointInTriangle(p: Pt3, v0: Pt3, v1: Pt3, v2: Pt3): boolean {
  const n = cross(sub(v1, v0), sub(v2, v0));
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let proj: (q: Pt3) => [number, number];
  if (ax >= ay && ax >= az) proj = (q) => [q.y, q.z];
  else if (ay >= az) proj = (q) => [q.x, q.z];
  else proj = (q) => [q.x, q.y];
  const [px, py] = proj(p);
  const [x0, y0] = proj(v0);
  const [x1, y1] = proj(v1);
  const [x2, y2] = proj(v2);
  const d1 = (px - x1) * (y0 - y1) - (x0 - x1) * (py - y1);
  const d2 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d3 = (px - x0) * (y2 - y0) - (x2 - x0) * (py - y0);
  const neg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12;
  const pos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
  return !(neg && pos);
}

/**
 * The coplanar triangle of the other mesh that covers cell centroid
 * `c`, with whether it faces the same way as the cell (`sameFacing`).
 * Mixed-facing coverage at one point is degenerate; first match wins.
 */
function coveringTriangle(
  c: Pt3,
  tris: Pt3[][],
  cellNormal: Pt3,
): { sameFacing: boolean } | null {
  for (const t of tris) {
    if (!pointInTriangle(c, t[0], t[1], t[2])) continue;
    const tn = triNormal(t);
    const sameFacing = tn ? dot(tn, cellNormal) > 0 : true;
    return { sameFacing };
  }
  return null;
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * General boolean operation on closed meshes — both operands may be
 * arbitrary (non-convex) watertight solids. Throws when the result
 * would be empty (the caller decides whether that is an error).
 */
export function generalBoolean(op: GeneralBooleanOp, a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  if (a.faces.length < 4 || b.faces.length < 4) {
    throw new Error("generalBoolean: operands must be closed solids (>= 4 faces)");
  }

  const planesB = allPlanesOf(b);
  const planesA = allPlanesOf(a);
  const coplanarTrisB = planesB.map((pl) => trianglesOnPlane(b, pl));
  const coplanarTrisA = planesA.map((pl) => trianglesOnPlane(a, pl));
  const edgesB = planesB.map((pl) => edgesOnPlane(b, pl));
  const edgesA = planesA.map((pl) => edgesOnPlane(a, pl));

  // GLOBAL cut set: face planes + edge-perpendicular planes of BOTH
  // meshes; every triangle of both meshes is split by every object so
  // the subdivision is seam-consistent (no T-junctions).
  const allCuts = [...cutObjectsOf(a, planesA, "A"), ...cutObjectsOf(b, planesB, "B")];

  // Broad-phase AABBs for the inside probes.
  const bbA = meshAabb(a);
  const bbB = meshAabb(b);
  const insideB = (p: Pt3): boolean =>
    inAabb(bbB, p) && isInsideRobust(b, p);
  const insideA = (p: Pt3): boolean =>
    inAabb(bbA, p) && isInsideRobust(a, p);

  const vertices: Pt3[] = [];
  const faces: [number, number, number][] = [];
  const emit = (poly: Pt3[], flip: boolean): void => {
    const base = vertices.length;
    for (const p of poly) vertices.push(p);
    for (let i = 1; i < poly.length - 1; i++) {
      faces.push(flip ? [base, base + i + 1, base + i] : [base, base + i, base + i + 1]);
    }
  };

  // ── A pass: fragments of A classified against B ──
  for (const [ia, ib, ic] of a.faces) {
    const tri = [a.vertices[ia], a.vertices[ib], a.vertices[ic]];
    const nrm = triNormal(tri);
    if (!nrm) continue;
    for (const frag of splitFragment(tri, allCuts, "B")) {
      if (frag.coplanar !== null) {
        // Coplanar fragment: classify EACH in-plane cell. Cells are cut
        // by the other mesh's coplanar edges (including internal
        // triangulation diagonals), so a fragment can span both
        // covered and uncovered regions — the probe must run per cell.
        const cells = splitCoplanarByEdges(frag.poly, planesB[frag.coplanar], edgesB[frag.coplanar]);
        for (const cell of cells) {
          const c = centroidOf(cell);
          const u = add(c, scale(nrm, PROBE_EPS));
          const l = add(c, scale(nrm, -PROBE_EPS));
          const keepCell =
            op === "union" ? !insideB(u) :
            op === "intersect" ? insideB(l) :
            !insideB(l); // subtract
          if (keepCell) emit(cell, false);
        }
      } else {
        const c = centroidOf(frag.poly);
        const u = add(c, scale(nrm, PROBE_EPS)); // just outside A
        const l = add(c, scale(nrm, -PROBE_EPS)); // just inside A
        let keep: boolean;
        if (op === "union") keep = !insideB(u);
        else if (op === "intersect") keep = insideB(l);
        else keep = !insideB(l); // subtract
        if (keep) emit(frag.poly, false);
      }
    }
  }

  // ── B pass: fragments of B classified against A ──
  for (const [ia, ib, ic] of b.faces) {
    const tri = [b.vertices[ia], b.vertices[ib], b.vertices[ic]];
    const nrm = triNormal(tri);
    if (!nrm) continue;
    for (const frag of splitFragment(tri, allCuts, "A")) {
      if (frag.coplanar !== null) {
        if (op === "subtract") continue; // coplanar void skin: A's cells own the plane
        const P = planesA[frag.coplanar];
        const cells = splitCoplanarByEdges(frag.poly, P, edgesA[frag.coplanar]);
        const covTris = coplanarTrisA[frag.coplanar];
        for (const cell of cells) {
          const c = centroidOf(cell);
          // Single-copy ownership: a cell covered by a SAME-facing A
          // triangle is emitted by the A pass — never by B.
          const cov = coveringTriangle(c, covTris, nrm);
          if (cov && cov.sameFacing) continue;
          // Every other cell is classified by probe (handles stacked
          // opposite-facing contact and non-convex step/through cases).
          const u = add(c, scale(nrm, PROBE_EPS)); // just outside B
          const l = add(c, scale(nrm, -PROBE_EPS)); // just inside B
          const keepCell = op === "union" ? !insideA(u) : insideA(l); // intersect
          if (keepCell) emit(cell, false);
        }
      } else {
        const c = centroidOf(frag.poly);
        const u = add(c, scale(nrm, PROBE_EPS)); // just outside B
        const l = add(c, scale(nrm, -PROBE_EPS)); // just inside B
        let keep: boolean;
        let flip = false;
        if (op === "union") keep = !insideA(u);
        else if (op === "intersect") keep = insideA(l);
        else { keep = insideA(u); flip = true; } // subtract: cavity wall
        if (keep) emit(frag.poly, flip);
      }
    }
  }

  if (faces.length === 0) {
    throw new Error(
      `generalBoolean(${op}): result is empty — the solids do not ${op === "intersect" ? "overlap" : "produce material for this operation"}`,
    );
  }
  return { vertices, faces };
}

// ── convenience + n-ary fuse ─────────────────────────────────────────────

/** General a ∪ b — arbitrary closed meshes (v0.70; supersedes the convex-only union). */
export function generalUnion(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return generalBoolean("union", a, b);
}

/** General a ∩ b — arbitrary closed meshes. */
export function generalIntersect(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return generalBoolean("intersect", a, b);
}

/**
 * General a − b — the cutter may now be NON-convex (an L-shaped
 * recess, a mesh void), removing the v0.68 "convex cutter" limit.
 */
export function generalSubtract(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return generalBoolean("subtract", a, b);
}

/**
 * Fuse a list of solids into one (sequential general union). With N
 * inputs the accumulated solid grows, so cost is O(N²) in the worst
 * case — intended for the small sets typical of join operations
 * (walls + columns, massing studies).
 */
export function fuseAll(meshes: IndexedMesh[]): IndexedMesh {
  if (!Array.isArray(meshes) || meshes.length === 0) {
    throw new Error("fuseAll: needs at least one solid");
  }
  for (const m of meshes) {
    if (m.faces.length < 4) throw new Error("fuseAll: every input must be a closed solid (>= 4 faces)");
  }
  let acc = meshes[0];
  for (let i = 1; i < meshes.length; i++) {
    acc = generalBoolean("union", acc, meshes[i]);
  }
  return acc;
}

// ── polygon-soup welding ─────────────────────────────────────────────────

/**
 * Weld coincident vertices of a polygon-soup mesh (pairwise search,
 * same semantics as brep.weldVertices) and drop degenerate faces, so
 * the result can be counted by validateMeshDiagnostics with raw
 * indices. Default tolerance 1e-7 m — far below BIM feature scale,
 * far above split interpolation noise.
 */
export function weldMesh(mesh: IndexedMesh, tol = 1e-7): IndexedMesh {
  const map = new Map<number, number>();
  const accepted: Pt3[] = [];
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    let found = -1;
    for (let j = 0; j < accepted.length; j++) {
      const a = accepted[j];
      if (
        Math.abs(a.x - v.x) <= tol &&
        Math.abs(a.y - v.y) <= tol &&
        Math.abs(a.z - v.z) <= tol
      ) { found = j; break; }
    }
    if (found >= 0) map.set(i, found);
    else { map.set(i, accepted.length); accepted.push(v); }
  }
  const faces: [number, number, number][] = [];
  for (const [ia, ib, ic] of mesh.faces) {
    const a = map.get(ia)!, b = map.get(ib)!, c = map.get(ic)!;
    if (a === b || b === c || a === c) continue;
    faces.push([a, b, c]);
  }
  return { vertices: accepted, faces };
}

// ── AABB broad phase ─────────────────────────────────────────────────────

interface Aabb { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; }

function meshAabb(mesh: IndexedMesh): Aabb {
  const bb: Aabb = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  for (const v of mesh.vertices) {
    if (v.x < bb.minX) bb.minX = v.x;
    if (v.y < bb.minY) bb.minY = v.y;
    if (v.z < bb.minZ) bb.minZ = v.z;
    if (v.x > bb.maxX) bb.maxX = v.x;
    if (v.y > bb.maxY) bb.maxY = v.y;
    if (v.z > bb.maxZ) bb.maxZ = v.z;
  }
  return bb;
}

function inAabb(bb: Aabb, p: Pt3): boolean {
  return (
    p.x >= bb.minX - PROBE_EPS && p.x <= bb.maxX + PROBE_EPS &&
    p.y >= bb.minY - PROBE_EPS && p.y <= bb.maxY + PROBE_EPS &&
    p.z >= bb.minZ - PROBE_EPS && p.z <= bb.maxZ + PROBE_EPS
  );
}
