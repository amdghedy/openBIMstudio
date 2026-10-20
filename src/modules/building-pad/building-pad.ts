/**
 * Building Pad Generator — flat platform cut/fill into a toposurface.
 *
 * BIM-equivalent of Revit's "Building Pad" tool. Given a toposurface mesh
 * and a closed 2D outline (in XZ plane), produces:
 *  - the pad floor (at specified elevation),
 *  - the cut slope up to existing grade on the high side,
 *  - the fill slope down to existing grade on the low side.
 *
 * Slopes are angle-from-horizontal (degrees). Returns mesh + cut/fill volume.
 */

import * as THREE from "three";
import type { ToposurfaceResult } from "../toposurface/toposurface";

export interface PadOutline {
  x: number;
  z: number;
}

export interface BuildingPadParams {
  /** Closed outline (≥3 points). */
  outline: PadOutline[];
  /** Pad floor elevation (m). */
  elevation: number;
  /** Slope from horizontal in degrees. */
  slopeAngle: number;
  /** Maximum slope run before terminating (m). */
  maxRun: number;
  /** Existing toposurface to clamp to (optional). */
  existing?: ToposurfaceResult;
  /** Material colour. */
  color?: number;
}

export interface BuildingPadResult {
  /** Pad floor area (m²). */
  floorArea: number;
  /** Cut volume (m³). */
  cutVolume: number;
  /** Fill volume (m³). */
  fillVolume: number;
  /** Pad perimeter (m). */
  perimeter: number;
  /** THREE.Object3D ready to add to the scene. */
  object: THREE.Object3D;
}

const DEFAULTS = {
  elevation: 0,
  slopeAngle: 45,
  maxRun: 8,
  color: 0x6b7280,
};

function polygonArea(outline: PadOutline[]): number {
  let a = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    a += (outline[j].x + outline[i].x) * (outline[j].z - outline[i].z);
  }
  return Math.abs(a) * 0.5;
}

function polygonPerimeter(outline: PadOutline[]): number {
  let p = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const dx = outline[i].x - outline[j].x;
    const dz = outline[i].z - outline[j].z;
    p += Math.hypot(dx, dz);
  }
  return p;
}

/** Ray-cast against the toposurface at (x, z) and return elevation, or null. */
function raycastTopo(topo: ToposurfaceResult, x: number, z: number): number | null {
  const idx = topo.indices;
  const pos = topo.positions;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    // Barycentric in XZ.
    const v0x = bx - ax, v0z = bz - az;
    const v1x = cx - ax, v1z = cz - az;
    const v2x = x - ax, v2z = z - az;
    const denom = v0x * v1z - v1x * v0z;
    if (Math.abs(denom) < 1e-12) continue;
    const u = (v2x * v1z - v1x * v2z) / denom;
    const v = (v0x * v2z - v2x * v0z) / denom;
    if (u < 0 || v < 0 || u + v > 1) continue;
    // Barycentric elevation.
    return ay + u * (by - ay) + v * (cy - ay);
  }
  return null;
}

/** Build a building pad mesh. */
export function buildBuildingPad(input: BuildingPadParams): BuildingPadResult {
  const p: BuildingPadParams & typeof DEFAULTS = { ...DEFAULTS, ...input };
  if (p.outline.length < 3) throw new Error("Building pad needs ≥3 outline points");

  const group = new THREE.Group();
  group.name = "obs-building-pad";
  group.userData.kind = "building-pad";

  // Floor.
  const positions: number[] = [];
  const indices: number[] = [];
  for (const pt of p.outline) positions.push(pt.x, p.elevation, pt.z);
  // Ear-clipping fan triangulation (works for convex; convex outline is typical).
  for (let i = 1; i < p.outline.length - 1; i++) indices.push(0, i, i + 1);
  const floorGeo = new THREE.BufferGeometry();
  floorGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  floorGeo.setIndex(indices);
  const mat = new THREE.MeshLambertMaterial({ color: p.color, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(floorGeo, mat);
  floor.name = "obs-pad-floor";
  group.add(floor);

  // Slope strips around perimeter.
  const slopeRad = (p.slopeAngle * Math.PI) / 180;
  let cutVol = 0;
  let fillVol = 0;
  const stepCount = Math.max(1, Math.ceil(p.maxRun / 0.5));
  for (let i = 0, j = p.outline.length - 1; i < p.outline.length; j = i++) {
    const a = p.outline[j];
    const b = p.outline[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const seg = Math.hypot(dx, dz);
    if (seg < 1e-6) continue;
    // Outward normal (XZ plane).
    const nx = dz / seg;
    const nz = -dx / seg;
    // Sample existing grade at midpoint offset outward.
    const midX = (a.x + b.x) * 0.5 + nx * 0.5;
    const midZ = (a.z + b.z) * 0.5 + nz * 0.5;
    const existingElev = p.existing ? raycastTopo(p.existing, midX, midZ) : p.elevation + 1;
    if (existingElev === null) continue;
    const delta = existingElev - p.elevation;
    const isCut = delta > 0; // existing is higher → cut
    const slopeRun = Math.min(p.maxRun, Math.abs(delta) / Math.tan(slopeRad));
    // Build a quad strip from pad edge outward (slopeRun).
    const verts: number[] = [];
    verts.push(a.x, p.elevation, a.z);
    verts.push(b.x, p.elevation, b.z);
    verts.push(b.x + nx * slopeRun, p.elevation + (isCut ? delta : 0), b.z + nz * slopeRun);
    verts.push(a.x + nx * slopeRun, p.elevation + (isCut ? delta : 0), a.z + nz * slopeRun);
    const stripGeo = new THREE.BufferGeometry();
    stripGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    stripGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const stripMat = new THREE.MeshLambertMaterial({
      color: isCut ? 0x9ca3af : 0xbfa37a,
      side: THREE.DoubleSide,
    });
    const strip = new THREE.Mesh(stripGeo, stripMat);
    group.add(strip);
    // Volume estimate (triangular prism × segment length).
    const vol = 0.5 * slopeRun * Math.abs(delta) * seg;
    if (isCut) cutVol += vol;
    else fillVol += vol;
  }

  const floorArea = polygonArea(p.outline);
  const perimeter = polygonPerimeter(p.outline);

  return {
    floorArea,
    cutVolume: cutVol,
    fillVolume: fillVol,
    perimeter,
    object: group,
  };
}
