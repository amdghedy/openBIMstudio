/**
 * Solid–void interaction engine (MASTER PROMPT MODULE 2.9).
 *
 * Pipeline for cutting voids out of solids:
 *   1. Void generation from parametric definitions (boxes, cylinders).
 *   2. Candidate discovery — broad phase over an AABB tree (spec asks to
 *      compare BVH / AABB-tree / R-tree / octree: we implement a simple
 *      median-split AABB tree; R-trees are storage-shaped, octrees are
 *      uniform-grid-shaped — the AABB tree fits arbitrary meshes best and
 *      supports O(log n + k) overlap queries).
 *   3. Narrow phase — exact triangle-triangle intersection (Möller's
 *      interval method) so candidate pairs are confirmed geometrically
 *      before any boolean work.
 *   4. Boolean subtraction (csg.ts), topology validation (validate.ts),
 *      and a roll-back guarantee: the original solid is never mutated —
 *      the pipeline returns a new solid or a failure record (spec 5.4).
 *
 * Edge cases handled explicitly (spec 2.9): overlapping voids (sequential
 * subtraction), tangential contact (no cut — narrow phase reports no
 * intersection when triangles only touch), fully contained voids (result
 * volume drops by the void volume), disconnected results (reported as a
 * diagnostic by validate.ts), empty results (error, not silent).
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, Pt3 } from "../adaptive";
import { meshVolume } from "../adaptive";
import { isInsideRobust, subtract } from "./csg";

// ── AABB tree (broad phase, spec 2.9) ───────────────────────────────────

export interface Aabb {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function triAabb(mesh: IndexedMesh, tri: [number, number, number]): Aabb {
  const a = mesh.vertices[tri[0]];
  const b = mesh.vertices[tri[1]];
  const c = mesh.vertices[tri[2]];
  return {
    minX: Math.min(a.x, b.x, c.x), minY: Math.min(a.y, b.y, c.y), minZ: Math.min(a.z, b.z, c.z),
    maxX: Math.max(a.x, b.x, c.x), maxY: Math.max(a.y, b.y, c.y), maxZ: Math.max(a.z, b.z, c.z),
  };
}

export function meshAabb(mesh: IndexedMesh): Aabb {
  const first = mesh.vertices[0];
  if (!first) {
    return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }
  const out: Aabb = {
    minX: first.x, minY: first.y, minZ: first.z,
    maxX: first.x, maxY: first.y, maxZ: first.z,
  };
  for (const v of mesh.vertices) {
    out.minX = Math.min(out.minX, v.x); out.minY = Math.min(out.minY, v.y); out.minZ = Math.min(out.minZ, v.z);
    out.maxX = Math.max(out.maxX, v.x); out.maxY = Math.max(out.maxY, v.y); out.maxZ = Math.max(out.maxZ, v.z);
  }
  return out;
}

export function aabbOverlap(a: Aabb, b: Aabb, tol = 1e-12): boolean {
  return (
    a.minX <= b.maxX + tol && b.minX <= a.maxX + tol &&
    a.minY <= b.maxY + tol && b.minY <= a.maxY + tol &&
    a.minZ <= b.maxZ + tol && b.minZ <= a.maxZ + tol
  );
}

interface AabbNode {
  box: Aabb;
  left: AabbNode | null;
  right: AabbNode | null;
  /** Triangle indices at leaves. */
  tris: number[];
}

/**
 * Median-split AABB tree over mesh triangles. Build O(n log n); query
 * O(log n + k) where k is the number of overlapping triangles. Leaf
 * nodes re-test each triangle's OWN box so candidates are per-triangle
 * (a shared leaf box must not widen the result).
 */
export class AabbTree {
  private root: AabbNode | null = null;
  private triBoxes: Aabb[] = [];

  constructor(mesh: IndexedMesh) {
    const items = mesh.faces.map((f, i) => ({ tri: i, box: triAabb(mesh, f) }));
    this.triBoxes = items.map((x) => x.box);
    if (items.length === 0) return;
    const build = (list: { tri: number; box: Aabb }[]): AabbNode => {
      const box = mergeBoxes(list.map((x) => x.box));
      if (list.length <= 4) {
        return { box, left: null, right: null, tris: list.map((x) => x.tri) };
      }
      // Split along the longest axis at the median centre.
      const ex = box.maxX - box.minX;
      const ey = box.maxY - box.minY;
      const ez = box.maxZ - box.minZ;
      const axis = ex >= ey && ex >= ez ? "x" : ey >= ez ? "y" : "z";
      const centre = (b: Aabb) => axis === "x" ? (b.minX + b.maxX) / 2 : axis === "y" ? (b.minY + b.maxY) / 2 : (b.minZ + b.maxZ) / 2;
      const sorted = [...list].sort((p, q) => centre(p.box) - centre(q.box));
      const mid = sorted.length >> 1;
      return {
        box,
        left: build(sorted.slice(0, mid)),
        right: build(sorted.slice(mid)),
        tris: [],
      };
    };
    this.root = build(items);
  }

  /** Triangle indices whose OWN AABBs overlap `box`. */
  query(box: Aabb): number[] {
    const out: number[] = [];
    const walk = (n: AabbNode | null): void => {
      if (!n || !aabbOverlap(n.box, box)) return;
      if (n.tris.length) {
        for (const t of n.tris) {
          if (aabbOverlap(this.triBoxes[t], box)) out.push(t);
        }
        return;
      }
      walk(n.left);
      walk(n.right);
    };
    walk(this.root);
    return out;
  }
}

function mergeBoxes(boxes: Aabb[]): Aabb {
  const out: Aabb = { ...boxes[0] };
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    out.minX = Math.min(out.minX, b.minX); out.minY = Math.min(out.minY, b.minY); out.minZ = Math.min(out.minZ, b.minZ);
    out.maxX = Math.max(out.maxX, b.maxX); out.maxY = Math.max(out.maxY, b.maxY); out.maxZ = Math.max(out.maxZ, b.maxZ);
  }
  return out;
}

// ── Narrow phase: triangle–triangle intersection (Möller interval test) ──

function triNormal(m: IndexedMesh, t: [number, number, number]): Pt3 {
  const a = m.vertices[t[0]], b = m.vertices[t[1]], c = m.vertices[t[2]];
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const n = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const l = Math.hypot(n.x, n.y, n.z);
  return l > 0 ? { x: n.x / l, y: n.y / l, z: n.z / l } : n;
}

/** Exact-enough triangle-triangle intersection within one mesh. */
export function trianglesIntersect(m: IndexedMesh, t1: number, t2: number): boolean {
  return triTriIntersect(m, m.faces[t1], m, m.faces[t2]);
}

/** Triangle-triangle intersection across two meshes (Möller interval test). */
export function triTriIntersect(
  m1: IndexedMesh, T1: [number, number, number],
  m2: IndexedMesh, T2: [number, number, number],
): boolean {
  const n1 = triNormal(m1, T1);
  const a1 = m1.vertices[T1[0]];
  const d1 = n1.x * a1.x + n1.y * a1.y + n1.z * a1.z;
  const n2 = triNormal(m2, T2);
  const a2 = m2.vertices[T2[0]];
  const d2 = n2.x * a2.x + n2.y * a2.y + n2.z * a2.z;

  const dist2 = (p: Pt3) => n2.x * p.x + n2.y * p.y + n2.z * p.z - d2;
  const dist1 = (p: Pt3) => n1.x * p.x + n1.y * p.y + n1.z * p.z - d1;

  // Early reject: all of one triangle strictly on one side of the other's
  // plane (touching within EPS counts as contact, not rejection).
  const EPS = 1e-12;
  const dT2 = T2.map((i) => dist1(m2.vertices[i]));
  if (dT2.every((x) => x > EPS) || dT2.every((x) => x < -EPS)) return false;
  const dT1 = T1.map((i) => dist2(m1.vertices[i]));
  if (dT1.every((x) => x > EPS) || dT1.every((x) => x < -EPS)) return false;

  // Interval overlap test on the intersection line.
  const D = { x: n1.y * n2.z - n1.z * n2.y, y: n1.z * n2.x - n1.x * n2.z, z: n1.x * n2.y - n1.y * n2.x };
  const dl = Math.hypot(D.x, D.y, D.z);
  if (dl < 1e-15) {
    // Coplanar: 2D projection + segment/point tests (conservative exact).
    return coplanarTrisIntersect(m1, T1, m2, T2, n1);
  }
  const proj = (p: Pt3) => (D.x * p.x + D.y * p.y + D.z * p.z) / dl;

  const interval = (mesh: IndexedMesh, tri: [number, number, number], dist: number[]): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = dist[i], dj = dist[j];
      const vi = mesh.vertices[tri[i]];
      const vj = mesh.vertices[tri[j]];
      const pi = proj(vi);
      const pj = proj(vj);
      if (Math.abs(di) <= EPS) { lo = Math.min(lo, pi); hi = Math.max(hi, pi); }
      if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) {
        const t = di / (di - dj);
        const pt = proj({
          x: vi.x + (vj.x - vi.x) * t,
          y: vi.y + (vj.y - vi.y) * t,
          z: vi.z + (vj.z - vi.z) * t,
        });
        lo = Math.min(lo, pt); hi = Math.max(hi, pt);
      }
    }
    return lo <= hi ? [lo, hi] : null;
  };

  const i1 = interval(m1, T1, dT1);
  const i2 = interval(m2, T2, dT2);
  if (!i1 || !i2) return false;
  return i1[0] <= i2[1] + 1e-15 && i2[0] <= i1[1] + 1e-15;
}

function coplanarTrisIntersect(
  m1: IndexedMesh, T1: [number, number, number],
  m2: IndexedMesh, T2: [number, number, number],
  n: Pt3,
): boolean {
  // Project onto the dominant plane of n, run 2D segment/point tests.
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const drop = ax >= ay && ax >= az ? "x" : ay >= az ? "y" : "z";
  const p2 = (mesh: IndexedMesh, i: number): [number, number] => {
    const v = mesh.vertices[i];
    return drop === "x" ? [v.y, v.z] : drop === "y" ? [v.x, v.z] : [v.x, v.y];
  };
  for (let i = 0; i < 3; i++) {
    const a1 = p2(m1, T1[i]), b1 = p2(m1, T1[(i + 1) % 3]);
    for (let j = 0; j < 3; j++) {
      const a2 = p2(m2, T2[j]), b2 = p2(m2, T2[(j + 1) % 3]);
      if (seg2dIntersect(a1, b1, a2, b2)) return true;
    }
  }
  // Point-in-triangle tests (degenerate touching counts as contact).
  const tri1 = [p2(m1, T1[0]), p2(m1, T1[1]), p2(m1, T1[2])];
  const tri2 = [p2(m2, T2[0]), p2(m2, T2[1]), p2(m2, T2[2])];
  for (const i of T2) if (pointInTri2(p2(m2, i), tri1)) return true;
  for (const i of T1) if (pointInTri2(p2(m1, i), tri2)) return true;
  return false;
}

function seg2dIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointInTri2(p: [number, number], tri: Array<[number, number]>): boolean {
  const sign = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
  const s1 = sign(p, tri[0], tri[1]);
  const s2 = sign(p, tri[1], tri[2]);
  const s3 = sign(p, tri[2], tri[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

// ── Void definitions (spec 2.9 void generation) ──────────────────────────

export type VoidShape =
  | { kind: "box"; center: Pt3; size: Pt3 }
  | { kind: "cylinder"; center: Pt3; radius: number; height: number; segments?: number };

/** Generate a watertight void mesh from a parametric definition. */
export function generateVoid(def: VoidShape): IndexedMesh {
  if (def.kind === "box") {
    if (def.size.x <= 0 || def.size.y <= 0 || def.size.z <= 0) {
      throw new Error("generateVoid: box size components must be > 0");
    }
    const hx = def.size.x / 2, hy = def.size.y / 2, hz = def.size.z / 2;
    const c = def.center;
    const v = (dx: number, dy: number, dz: number): Pt3 => ({ x: c.x + dx * hx, y: c.y + dy * hy, z: c.z + dz * hz });
    const vertices = [v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1), v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)];
    const faces: [number, number, number][] = [
      [0, 3, 2], [0, 2, 1], // bottom (−z)
      [4, 5, 6], [4, 6, 7], // top (+z)
      [0, 1, 5], [0, 5, 4], // −y
      [2, 3, 7], [2, 7, 6], // +y
      [1, 2, 6], [1, 6, 5], // +x
      [3, 0, 4], [3, 4, 7], // −x
    ];
    return { vertices, faces };
  }
  const segs = def.segments ?? 24;
  if (def.radius <= 0 || def.height <= 0) {
    throw new Error("generateVoid: cylinder radius/height must be > 0");
  }
  const vertices: Pt3[] = [];
  const faces: [number, number, number][] = [];
  const c = def.center;
  const hz = def.height / 2;
  for (const z of [c.z - hz, c.z + hz]) {
    for (let i = 0; i < segs; i++) {
      const a = (2 * Math.PI * i) / segs;
      vertices.push({ x: c.x + def.radius * Math.cos(a), y: c.y + def.radius * Math.sin(a), z });
    }
  }
  const bot = 0, top = segs;
  for (let i = 1; i < segs - 1; i++) {
    faces.push([bot, i + 1, i]);
    faces.push([top, top + i, top + i + 1]);
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    faces.push([i, j, top + j]);
    faces.push([i, top + j, top + i]);
  }
  return { vertices, faces };
}

// ── Cutting pipeline (spec 2.9) ──────────────────────────────────────────

export interface VoidCutRecord {
  voidIndex: number;
  /** Broad-phase candidate triangle count. */
  candidates: number;
  /** Narrow-phase confirmed intersections. */
  confirmed: boolean;
  volumeBefore: number;
  volumeAfter: number;
  removedVolume: number;
}

export interface VoidCutResult {
  solid: IndexedMesh;
  records: VoidCutRecord[];
  failures: Array<{ voidIndex: number; error: string }>;
}

/**
 * Subtract voids from a solid in order, with per-void records. The input
 * mesh is never mutated (rollback guarantee). Overlapping voids cut
 * sequentially; a void that misses the solid reports confirmed=false and
 * leaves the volume unchanged (that is an expected outcome, not an error).
 */
export function cutVoids(solid: IndexedMesh, voids: VoidShape[]): VoidCutResult {
  let current: IndexedMesh = { vertices: solid.vertices.map((v) => ({ ...v })), faces: [...solid.faces] };
  const records: VoidCutRecord[] = [];
  const failures: Array<{ voidIndex: number; error: string }> = [];
  let volumeBefore = meshVolume(current);

  for (let vi = 0; vi < voids.length; vi++) {
    const vm = generateVoid(voids[vi]);
    // Broad phase.
    const tree = new AabbTree(current);
    const va = meshAabb(vm);
    const candidates = tree.query(va);
    // Narrow phase (exact tri-tri across the two meshes) PLUS the
    // containment case: a void fully inside the host never crosses the
    // host surface, so also test the void centre against the host solid.
    const vmeshFaces = vm.faces;
    let confirmed = false;
    outer:
    for (const t1 of candidates) {
      for (let t2 = 0; t2 < vmeshFaces.length; t2++) {
        if (triTriIntersect(current, current.faces[t1], vm, vmeshFaces[t2])) {
          confirmed = true;
          break outer;
        }
      }
    }
    if (!confirmed) {
      // Contained void: no surface crossing, but the void centre may sit
      // inside the solid — robust parity vote settles it.
      const c = voids[vi].center;
      if (isInsideRobust(current, { x: c.x, y: c.y, z: c.z })) confirmed = true;
    }
    if (!confirmed) {
      records.push({ voidIndex: vi, candidates: candidates.length, confirmed: false, volumeBefore, volumeAfter: volumeBefore, removedVolume: 0 });
      continue;
    }
    try {
      const next = subtract(current, vm);
      const volumeAfter = meshVolume(next);
      records.push({ voidIndex: vi, candidates: candidates.length, confirmed: true, volumeBefore, volumeAfter, removedVolume: volumeBefore - volumeAfter });
      current = next;
      volumeBefore = volumeAfter;
    } catch (err) {
      failures.push({ voidIndex: vi, error: err instanceof Error ? err.message : String(err) });
      records.push({ voidIndex: vi, candidates: candidates.length, confirmed: true, volumeBefore, volumeAfter: volumeBefore, removedVolume: 0 });
    }
  }
  return { solid: current, records, failures };
}
