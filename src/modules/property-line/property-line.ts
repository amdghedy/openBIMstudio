/**
 * Property Line Generator — site boundary with bearings + distances.
 *
 * BIM-equivalent of Revit's "Property Line" tool. Accepts a closed polyline
 * (bearing + distance style survey data) and produces a planar boundary
 * with metes-and-bounds table.
 *
 * Coordinate convention: X = East, Z = North (architectural plan). Bearing
 * expressed as degrees from North (clockwise positive).
 */

import * as THREE from "three";

export interface PropertySegment {
  /** Bearing in degrees (0 = N, 90 = E). */
  bearing: number;
  /** Distance in metres. */
  distance: number;
  /** Optional label like "N 30°20' E". */
  label?: string;
}

export interface PropertyLineParams {
  /** Start point (origin). */
  origin: { x: number; z: number };
  /** Survey segments (closed loop required). */
  segments: PropertySegment[];
  /** Drawing elevation (m). */
  elevation?: number;
  /** Line colour (hex). */
  color?: number;
  /** Show segment labels in scene. */
  showLabels?: boolean;
}

export interface PropertyLineResult {
  /** Vertices (closed: first = last). */
  vertices: Array<{ x: number; z: number }>;
  /** Total perimeter (m). */
  perimeter: number;
  /** Enclosed area (m²) — 0 if not closed. */
  area: number;
  /** Closure error (distance from end to origin). */
  closureError: number;
  /** THREE.Object3D to add to scene. */
  object: THREE.Object3D;
  /** Metes-and-bounds table. */
  metes: Array<{ index: number; bearing: number; distance: number; label: string }>;
}

const DEFAULTS = {
  elevation: 0,
  color: 0xff0000,
  showLabels: false,
};

function bearingToVector(bearingDeg: number): { dx: number; dz: number } {
  // Bearing 0 = +Z (North), 90 = +X (East). Clockwise.
  const rad = (bearingDeg * Math.PI) / 180;
  return { dx: Math.sin(rad), dz: Math.cos(rad) };
}

function polygonArea(verts: Array<{ x: number; z: number }>): number {
  let a = 0;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    a += (verts[j].x + verts[i].x) * (verts[j].z - verts[i].z);
  }
  return Math.abs(a) * 0.5;
}

/** Build a property line from survey metes. */
export function buildPropertyLine(input: PropertyLineParams): PropertyLineResult {
  const p: PropertyLineParams & typeof DEFAULTS = { ...DEFAULTS, ...input };
  if (p.segments.length < 3) throw new Error("Property line needs ≥3 segments");

  let x = p.origin.x;
  let z = p.origin.z;
  const vertices: Array<{ x: number; z: number }> = [{ x, z }];
  const metes: PropertyLineResult["metes"] = [];

  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i];
    const v = bearingToVector(seg.bearing);
    x += v.dx * seg.distance;
    z += v.dz * seg.distance;
    vertices.push({ x, z });
    metes.push({
      index: i + 1,
      bearing: seg.bearing,
      distance: seg.distance,
      label: seg.label ?? formatBearing(seg.bearing),
    });
  }

  const closureError = Math.hypot(x - p.origin.x, z - p.origin.z);
  const perimeter = p.segments.reduce((s, seg) => s + seg.distance, 0);
  const area = closureError < 0.01 ? polygonArea(vertices) : 0;

  // Build line geometry.
  const lineGeo = new THREE.BufferGeometry();
  const linePos: number[] = [];
  for (const v of vertices) linePos.push(v.x, p.elevation + 0.02, v.z);
  lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: p.color, linewidth: 2 });
  const line = new THREE.Line(lineGeo, lineMat);
  line.name = "obs-property-line";
  line.userData.kind = "property-line";

  // Marker spheres at each vertex.
  const group = new THREE.Group();
  group.name = "obs-property-line-group";
  group.add(line);
  const markerGeo = new THREE.SphereGeometry(0.15, 8, 6);
  const markerMat = new THREE.MeshBasicMaterial({ color: p.color });
  for (const v of vertices) {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.position.set(v.x, p.elevation + 0.02, v.z);
    group.add(m);
  }

  return {
    vertices,
    perimeter,
    area,
    closureError,
    object: group,
    metes,
  };
}

function formatBearing(deg: number): string {
  const d = Math.floor(deg);
  const mFloat = (deg - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  const quadrant = deg < 90 ? "N … E" : deg < 180 ? "S … E" : deg < 270 ? "S … W" : "N … W";
  const dd = deg < 180 ? (deg < 90 ? deg : 180 - deg) : (deg < 270 ? deg - 180 : 360 - deg);
  return `${quadrant} ${dd}°${m}'${s}"`;
}
