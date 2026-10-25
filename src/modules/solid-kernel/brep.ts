/**
 * B-Rep topology model (MASTER PROMPT MODULE 2.7).
 *
 * The kernel keeps THREE representations, with clear authority (spec 5.1):
 *   1. Parametric definition (profile, depth, axis, path) — authoritative.
 *   2. B-Rep / polygon boundary — derived, validated, used for booleans
 *      and quantity takeoff.
 *   3. Display mesh — the render copy; never an authority for dimensions.
 *
 * This file defines the boundary representation and its structural rules:
 *   - A `BRepSolid` is one or more shells; each face carries one outer loop
 *     of ordered vertex ids; edges are derived as ordered vertex pairs.
 *   - Manifold rule (level E, standard boundary-representation invariant):
 *     every undirected edge must appear exactly twice across all loops of
 *     the solid, once in each direction. Violations are reported as
 *     diagnostics by validate.ts, never silently repaired.
 *   - Winding: outward faces are CCW seen from outside; `meshVolume`
 *     (divergence theorem) returns positive volume for outward solids.
 *   - Tolerance: coincident-vertex welding uses `COINCIDENT_TOL` (1e-9 m),
 *     per spec 5.2 which forbids exact float equality.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { IndexedMesh, Pt3 } from "../adaptive";

/** Geometric coincidence tolerance, metres (spec 5.2). */
export const COINCIDENT_TOL = 1e-9;

/** An outer loop: ordered vertex ids, CCW for outward faces. */
export type Loop = number[];

export interface BRepFace {
  id: string;
  loop: Loop;
  /** Semantic name when the face is a named family reference (spec 2.10). */
  referenceName?: string;
  /** Supporting surface type (analytic classification). */
  surface: "plane" | "cylinder" | "cone" | "sphere" | "general";
}

export interface BRepEdge {
  a: number;
  b: number;
  /** Undirected key "min:max". */
  key: string;
  /** How many times this edge is used across loops (manifold = 2). */
  useCount: number;
}

export interface BRepSolid {
  id: string;
  vertices: Pt3[];
  faces: BRepFace[];
  /** Derived edge table (rebuilt by buildEdges). */
  edges: Map<string, BRepEdge>;
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Derive the edge table with use counts (O(sum loop lengths)). */
export function buildEdges(solid: BRepSolid): Map<string, BRepEdge> {
  solid.edges = new Map();
  for (const f of solid.faces) {
    const L = f.loop.length;
    for (let i = 0; i < L; i++) {
      const a = f.loop[i];
      const b = f.loop[(i + 1) % L];
      const key = edgeKey(a, b);
      const e = solid.edges.get(key);
      if (e) e.useCount++;
      else solid.edges.set(key, { a, b, key, useCount: 1 });
    }
  }
  return solid.edges;
}

/** Convert an indexed triangle mesh into a B-Rep solid (per-triangle faces). */
export function solidFromMesh(id: string, mesh: IndexedMesh): BRepSolid {
  const faces: BRepFace[] = mesh.faces.map((tri, i) => ({
    id: `${id}:f${i}`,
    loop: [...tri],
    surface: "general" as const,
  }));
  const solid: BRepSolid = { id, vertices: mesh.vertices.map((v) => ({ ...v })), faces, edges: new Map() };
  buildEdges(solid);
  return solid;
}

/** Rigid transform: rotate/scale/translate all vertices (spec 5.3). */
export function transformSolid(
  solid: BRepSolid,
  m: { scale?: number; rotateZ?: number; translate?: Pt3 },
): BRepSolid {
  const s = m.scale ?? 1;
  const c = m.rotateZ ? Math.cos(m.rotateZ) : 1;
  const sn = m.rotateZ ? Math.sin(m.rotateZ) : 1;
  const t = m.translate ?? { x: 0, y: 0, z: 0 };
  const vertices = solid.vertices.map((v) => {
    const x = (v.x * c - v.y * sn) * s;
    const y = (v.x * sn + v.y * c) * s;
    return { x: x + t.x, y: y + t.y, z: v.z * s + t.z };
  });
  return { ...solid, vertices, edges: new Map() };
}

/**
 * Weld coincident vertices within COINCIDENT_TOL (spec 5.2: never exact
 * float equality). Returns a new solid; topology indices are remapped.
 */
export function weldVertices(solid: BRepSolid, tol = COINCIDENT_TOL): BRepSolid {
  const map = new Map<number, number>();
  const accepted: Pt3[] = [];
  for (let i = 0; i < solid.vertices.length; i++) {
    const v = solid.vertices[i];
    let found = -1;
    for (let j = 0; j < accepted.length; j++) {
      const a = accepted[j];
      if (
        Math.abs(a.x - v.x) <= tol &&
        Math.abs(a.y - v.y) <= tol &&
        Math.abs(a.z - v.z) <= tol
      ) {
        found = j;
        break;
      }
    }
    if (found >= 0) map.set(i, found);
    else {
      map.set(i, accepted.length);
      accepted.push(v);
    }
  }
  const faces = solid.faces
    .map((f) => ({ ...f, loop: f.loop.map((i) => map.get(i)!) }))
    .filter((f) => new Set(f.loop).size === f.loop.length && f.loop.length >= 3);
  const out: BRepSolid = { ...solid, vertices: accepted, faces, edges: new Map() };
  buildEdges(out);
  return out;
}

/** Face normal via Newell's method (robust for non-planar-ish loops). */
export function faceNormal(vertices: Pt3[], loop: Loop): Pt3 {
  let nx = 0, ny = 0, nz = 0;
  const L = loop.length;
  for (let i = 0; i < L; i++) {
    const p = vertices[loop[i]];
    const q = vertices[loop[(i + 1) % L]];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-15) return { x: 0, y: 0, z: 0 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Outward-oriented indexed mesh of the solid (triangles, fan per face). */
export function solidToMesh(solid: BRepSolid): IndexedMesh {
  const vertices = solid.vertices;
  const faces: [number, number, number][] = [];
  for (const f of solid.faces) {
    for (let i = 1; i < f.loop.length - 1; i++) {
      faces.push([f.loop[0], f.loop[i], f.loop[i + 1]]);
    }
  }
  return { vertices, faces };
}
