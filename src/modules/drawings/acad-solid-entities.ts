/**
 * Converters for 3D engine entities that a 2D plan viewer can still show as wireframe:
 * 3DSOLID / REGION / BODY (the wireframe edges AutoCAD stores with the entity), MESH,
 * POLYGONMESH (M x N grid), POLYFACE and HELIX.
 *
 * Pure functions over the engine's JSON (cad-engine-rust/src/json.rs), unit-tested in Node.
 * Honest limits (reported through `note`): the viewer is 2D, so these are drawn as edges only
 * (no shading, no hidden-line removal, no ACIS kernel); a solid that carries no stored wires
 * (some producers omit them) is skipped and reported.
 */
import type { DxfEntity, DxfPoint } from "./dxf-types";
import type { ExtraCtx } from "./acad-extra-entities";

type Any = Record<string, any>;
/** Hard cap on edges produced by one entity, so one dense mesh cannot swamp the drawing. */
export const MAX_EDGES_PER_ENTITY = 20000;

const line = (c: Any, a: DxfPoint, b: DxfPoint): DxfEntity => ({ ...c, type: "LINE", start: a, end: b } as DxfEntity);
const poly = (c: Any, pts: DxfPoint[], closed: boolean): DxfEntity => ({ ...c, type: "LWPOLYLINE", points: pts, closed } as DxfEntity);

export function convertSolidWire(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const w of (e.wires ?? []) as Any[]) {
    const pts = (Array.isArray(w) ? w : []).map(x.pt);
    if (pts.length >= 2) out.push(poly(c, pts, false));
    if (out.length >= MAX_EDGES_PER_ENTITY) { x.note(`${e.kind ?? "SOLID"} (wires truncated)`); break; }
  }
  if (!out.length) x.note(`${e.kind ?? "SOLID"} (no stored wireframe, not drawn)`);
  else x.note(`${e.kind ?? "SOLID"} (wireframe edges only)`);
  return out;
}

/** Edges of a face list, each undirected edge once. `faces` hold 0-based vertex indices. */
function faceEdges(faces: number[][], n: number): Array<[number, number]> {
  const seen = new Set<number>(); const out: Array<[number, number]> = [];
  for (const f of faces) {
    const k = f.length; if (k < 2) continue;
    for (let i = 0; i < k; i++) {
      const a = f[i], b = f[(i + 1) % k];
      if (!(a >= 0 && a < n && b >= 0 && b < n) || a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key); out.push([a, b]);
      if (out.length >= MAX_EDGES_PER_ENTITY) return out;
    }
  }
  return out;
}

export function convertMesh(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const v = (e.vertices ?? []).map(x.pt) as DxfPoint[];
  const faces = ((e.faces ?? []) as any[]).filter(Array.isArray).map((f) => f.map(Number));
  if (!faces.length) { x.note("MESH (no faces)"); return []; }
  const edges = faceEdges(faces, v.length);
  if (edges.length >= MAX_EDGES_PER_ENTITY) x.note("MESH (edges truncated)");
  x.note("MESH (wireframe edges only)");
  return edges.map(([a, b]) => line(c, v[a], v[b]));
}

export function convertPolygonMesh(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const m = Number(e.m) | 0, n = Number(e.n) | 0;
  const v = (e.vertices ?? []).map(x.pt) as DxfPoint[];
  if (m < 1 || n < 1 || v.length < m * n) { x.note("POLYGONMESH (bad grid)"); return []; }
  const out: DxfEntity[] = [];
  const at = (i: number, j: number) => v[i * n + j];
  for (let i = 0; i < m; i++) {
    const row: DxfPoint[] = []; for (let j = 0; j < n; j++) row.push(at(i, j));
    if (row.length >= 2) out.push(poly(c, row, !!e.closedN));
  }
  for (let j = 0; j < n; j++) {
    const col: DxfPoint[] = []; for (let i = 0; i < m; i++) col.push(at(i, j));
    if (col.length >= 2) out.push(poly(c, col, !!e.closedM));
  }
  x.note("POLYGONMESH (wireframe edges only)");
  return out;
}

export function convertPolyface(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const v = (e.vertices ?? []).map(x.pt) as DxfPoint[];
  // Indices are 1-based; a negative index marks an invisible edge (the vertex is still part of the face).
  const faces: number[][] = [];
  for (const f of (e.faces ?? []) as any[]) {
    if (!Array.isArray(f)) continue;
    const idx = f.map(Number).filter((k) => k !== 0).map((k) => Math.abs(k) - 1);
    if (idx.length >= 2) faces.push(idx);
  }
  if (!faces.length) { x.note("POLYFACE (no faces)"); return []; }
  x.note("POLYFACE (wireframe edges only, invisible-edge flags ignored)");
  return faceEdges(faces, v.length).map(([a, b]) => line(c, v[a], v[b]));
}

/** Helix: sampled from its parameters (axis, start point, radius, turns, pitch, handedness). */
export function convertHelix(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const base = x.pt(e.base ?? e.start), start = x.pt(e.start), ax = x.pt(e.axis);
  const turns = Number(e.turns), pitch = Number(e.turnHeight);
  const al = Math.hypot(ax.x, ax.y, ax.z ?? 0);
  if (!(turns > 0) || !(al > 1e-12) || !Number.isFinite(pitch)) { x.note("HELIX (bad parameters)"); return []; }
  const a = { x: ax.x / al, y: ax.y / al, z: (ax.z ?? 0) / al };
  // Radial vector from the axis to the start point.
  let rx = start.x - base.x, ry = start.y - base.y, rz = (start.z ?? 0) - (base.z ?? 0);
  const d = rx * a.x + ry * a.y + rz * a.z; rx -= d * a.x; ry -= d * a.y; rz -= d * a.z;
  const r = Math.hypot(rx, ry, rz);
  if (!(r > 1e-12)) { x.note("HELIX (zero radius)"); return []; }
  const ux = rx / r, uy = ry / r, uz = rz / r;
  // v = a x u (right-handed about the axis); a left-handed helix turns the other way.
  const sgn = e.handedness === false ? -1 : 1;
  const vx = sgn * (a.y * uz - a.z * uy), vy = sgn * (a.z * ux - a.x * uz), vz = sgn * (a.x * uy - a.y * ux);
  const steps = Math.min(4000, Math.max(24, Math.ceil(turns * 48)));
  const total = turns * 2 * Math.PI, pts: DxfPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total, h = d + pitch * (t / (2 * Math.PI));
    pts.push({
      x: base.x + a.x * h + r * (Math.cos(t) * ux + Math.sin(t) * vx),
      y: base.y + a.y * h + r * (Math.cos(t) * uy + Math.sin(t) * vy),
      z: (base.z ?? 0) + a.z * h + r * (Math.cos(t) * uz + Math.sin(t) * vz),
    });
  }
  return [poly(c, pts, false)];
}
