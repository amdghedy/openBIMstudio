/**
 * Live wiring for the sloped-floor engine: a THREE mesh builder for slabs
 * with per-corner top elevations (constant perpendicular thickness), plus
 * the feature registration. Geometry follows `sloped-floor.ts` math.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";
import {
  slopedFloorGeometry,
  validateSlopedFloor,
  averageTopElevation,
  type SlopedFloorSpec,
} from "./sloped-floor";

/**
 * Build a sloped slab mesh. Top surface at the per-vertex elevations,
 * bottom surface parallel (constant perpendicular thickness), vertical
 * sides at the polygon boundary. Normals are computed per-face.
 */
export function buildSlopedFloorMesh(spec: SlopedFloorSpec): THREE.BufferGeometry | null {
  const poly = spec.polygon;
  if (!poly || poly.length < 3) return null;
  const g = slopedFloorGeometry(spec);
  if (g.issues.some((i) => i.kind === "degenerate-polygon")) return null;

  const n = poly.length;
  const rise = spec.slopePct / 100;
  const cosTheta = 1 / Math.sqrt(1 + rise * rise);
  const bottomZ = g.minElevation - spec.thickness * cosTheta;

  const positions: number[] = [];
  const push = (x: number, y: number, z: number): void => { positions.push(x, y, z); };

  // Top surface: fan triangulation (works for convex and mildly concave)
  for (let i = 1; i < n - 1; i++) {
    const a = poly[0], b = poly[i], c = poly[i + 1];
    push(a[0], g.elevations[0], a[1]);
    push(b[0], g.elevations[i], b[1]);
    push(c[0], g.elevations[i + 1], c[1]);
    // Double-sided top: normal flips handled by material side, but add the
    // reverse winding so the slab reads correctly from below too.
    push(c[0], g.elevations[i + 1], c[1]);
    push(b[0], g.elevations[i], b[1]);
    push(a[0], g.elevations[0], a[1]);
  }

  // Sides: vertical quads per polygon edge
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    // out-facing quad (two triangles)
    push(a[0], g.elevations[i], a[1]);
    push(b[0], g.elevations[(i + 1) % n], b[1]);
    push(b[0], bottomZ, b[1]);
    push(a[0], g.elevations[i], a[1]);
    push(b[0], bottomZ, b[1]);
    push(a[0], bottomZ, a[1]);
  }

  // Bottom surface: fan, planar at bottomZ
  for (let i = 1; i < n - 1; i++) {
    const a = poly[0], b = poly[i], c = poly[i + 1];
    push(a[0], bottomZ, a[1]);
    push(b[0], bottomZ, b[1]);
    push(c[0], bottomZ, c[1]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  return geo;
}

export function setupSlopedFloors(): void {
  const api = {
    slopedFloorGeometry,
    validateSlopedFloor,
    averageTopElevation,
    buildSlopedFloorMesh,
  };
  const f = (ctx as any).features ?? ((ctx as any).features = {});
  f.slopedFloors = api;
  console.log("[sloped-floors] engine ready — ctx.features.slopedFloors.buildSlopedFloorMesh(spec)");
}
