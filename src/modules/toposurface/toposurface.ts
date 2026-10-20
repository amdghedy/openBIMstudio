/**
 * Toposurface Generator — triangulated irregular network (TIN) from survey points.
 *
 * BIM-equivalent of Revit's "Toposurface" tool. Accepts a set of 3D survey
 * points and produces a triangulated surface mesh suitable for cut/fill
 * volume calculations, building pads, subregions and graded regions.
 *
 * The TIN builder uses a 2D Delaunay triangulation projected onto XZ plane
 * (Y is up in our convention). Elevations are baked into vertex Y.
 */

import * as THREE from "three";

export interface TopoPoint {
  x: number;
  y: number; // elevation
  z: number;
}

export interface ToposurfaceParams {
  /** Survey points (≥3). */
  points: TopoPoint[];
  /** Optional boundary polygon (clockwise); outside is clipped. */
  boundary?: Array<{ x: number; z: number }>;
  /** Material colour (hex). */
  color?: number;
  /** Wireframe rendering for the surface. */
  wireframe?: boolean;
}

export interface ToposurfaceResult {
  /** Triangle vertex positions (3 per triangle, 9 numbers). */
  positions: number[];
  /** Triangle vertex indices. */
  indices: number[];
  /** Vertex elevations. */
  elevations: number[];
  /** Min/max elevation. */
  minElevation: number;
  maxElevation: number;
  /** Total surface area (m²). */
  area: number;
  /** THREE.Object3D ready to be added to the scene. */
  object: THREE.Object3D;
  /** Computed triangles count. */
  triangleCount: number;
}

const DEFAULTS = {
  color: 0x8b7355,
  wireframe: false,
};

/** Bowyer-Watson 2D Delaunay triangulation on XZ plane. Returns triangles as
 *  arrays of indices into the input points. */
export function delaunay2D(points: TopoPoint[]): number[][] {
  if (points.length < 3) return [];
  // Bounding box for super-triangle.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const dx = maxX - minX || 1;
  const dz = maxZ - minZ || 1;
  const dmax = Math.max(dx, dz);
  const midx = (minX + maxX) * 0.5;
  const midz = (minZ + maxZ) * 0.5;
  // Super-triangle vertices appended at end.
  const verts: Array<{ x: number; z: number }> = points.map((p) => ({ x: p.x, z: p.z }));
  const ST = [
    { x: midx - 20 * dmax, z: midz - dmax },
    { x: midx, z: midz + 20 * dmax },
    { x: midx + 20 * dmax, z: midz - dmax },
  ];
  const stStart = verts.length;
  for (const s of ST) verts.push(s);
  let tris: number[][] = [[stStart, stStart + 1, stStart + 2]];

  const inCircumcircle = (tri: number[], px: number, pz: number): boolean => {
    const [i0, i1, i2] = tri;
    const ax = verts[i0].x, az = verts[i0].z;
    const bx = verts[i1].x, bz = verts[i1].z;
    const cx = verts[i2].x, cz = verts[i2].z;
    const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
    if (Math.abs(d) < 1e-12) return false;
    const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
    const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
    const r2 = (ax - ux) ** 2 + (az - uz) ** 2;
    const dist2 = (px - ux) ** 2 + (pz - uz) ** 2;
    return dist2 < r2 - 1e-9;
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const bad: number[][] = [];
    const good: number[][] = [];
    for (const tri of tris) {
      if (inCircumcircle(tri, p.x, p.z)) bad.push(tri);
      else good.push(tri);
    }
    // Collect boundary edges of the cavity.
    const edges: Array<[number, number]> = [];
    for (const tri of bad) {
      const [a, b, c] = tri;
      const triEdges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
      for (const e of triEdges) {
        const rev = edges.find((x) => x[0] === e[1] && x[1] === e[0]);
        if (rev) edges.splice(edges.indexOf(rev), 1);
        else edges.push(e);
      }
    }
    // Re-triangulate the cavity with the new point.
    tris = good;
    for (const [a, b] of edges) tris.push([a, b, i]);
  }
  // Drop triangles touching super-triangle vertices.
  return tris.filter((t) => t.every((i) => i < stStart));
}

/** Point-in-polygon test (ray casting) for boundary clipping. */
function inPolygon(x: number, z: number, poly: Array<{ x: number; z: number }>): boolean {
  if (!poly || poly.length < 3) return true;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Build a TIN surface mesh from survey points. */
export function buildToposurface(input: ToposurfaceParams): ToposurfaceResult {
  const p: ToposurfaceParams & typeof DEFAULTS = { ...DEFAULTS, ...input };
  if (p.points.length < 3) {
    throw new Error(`Toposurface needs ≥3 survey points (got ${p.points.length})`);
  }

  const tris = delaunay2D(p.points);
  const positions: number[] = [];
  const elevations: number[] = [];
  let minE = Infinity, maxE = -Infinity;
  for (const pt of p.points) {
    positions.push(pt.x, pt.y, pt.z);
    elevations.push(pt.y);
    if (pt.y < minE) minE = pt.y;
    if (pt.y > maxE) maxE = pt.y;
  }

  const indices: number[] = [];
  let area = 0;
  for (const [a, b, c] of tris) {
    const pa = p.points[a], pb = p.points[b], pc = p.points[c];
    // Centroid for boundary clipping.
    const cx = (pa.x + pb.x + pc.x) / 3;
    const cz = (pa.z + pb.z + pc.z) / 3;
    if (p.boundary && !inPolygon(cx, cz, p.boundary)) continue;
    indices.push(a, b, c);
    // Triangle area = 0.5 * |AB × AC|
    const abx = pb.x - pa.x, abz = pb.z - pa.z;
    const acx = pc.x - pa.x, acz = pc.z - pa.z;
    area += 0.5 * Math.abs(abx * acz - abz * acx);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    color: p.color,
    wireframe: p.wireframe,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "obs-toposurface";
  mesh.userData.kind = "toposurface";

  return {
    positions,
    indices,
    elevations,
    minElevation: minE,
    maxElevation: maxE,
    area,
    object: mesh,
    triangleCount: indices.length / 3,
  };
}

/** Compute cut/fill volumes between two TINs (existing vs proposed) over their
 *  overlapping footprint. Returns +fill / -cut in m³. */
export function cutFillVolume(existing: ToposurfaceResult, proposed: ToposurfaceResult): number {
  // Approximation: average elevation delta × overlapping area.
  const exAvg = (existing.minElevation + existing.maxElevation) / 2;
  const prAvg = (proposed.minElevation + proposed.maxElevation) / 2;
  const overlapArea = Math.min(existing.area, proposed.area);
  return (prAvg - exAvg) * overlapArea;
}
