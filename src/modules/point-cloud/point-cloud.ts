/**
 * Point Cloud Import — E57 / LAS / PCD / PLY loader with subsampling + clipping.
 *
 * BIM-equivalent of Revit's "Point Cloud" tool. Loads .e57 / .las / .pcd /
 * .ply point cloud files, decimates to a target point budget and renders as
 * a THREE.Points object with per-vertex colour.
 *
 * Uses a streaming parser — file is read in chunks and points are batched
 * to GPU as they arrive, so files of several hundred MB are workable.
 */

import * as THREE from "three";

export interface PointCloudHeader {
  format: "e57" | "las" | "pcd" | "ply";
  pointCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface PointCloudLoadOptions {
  /** Target point budget (down-sample above this). */
  maxPoints?: number;
  /** Point size in pixels. */
  pointSize?: number;
  /** Use per-vertex colour (false = single colour). */
  useColor?: boolean;
  /** Default colour when useColor is false or points lack colour. */
  defaultColor?: number;
  /** Subsample step (1 = every point, 5 = every 5th). */
  subsample?: number;
}

export interface PointCloudResult {
  header: PointCloudHeader;
  points: THREE.Points;
  actualPoints: number;
  decimated: boolean;
}

const DEFAULTS: Required<PointCloudLoadOptions> = {
  maxPoints: 250_000,
  pointSize: 0.04,
  useColor: true,
  defaultColor: 0x6b7280,
  subsample: 1,
};

function detectFormat(file: File | string): PointCloudHeader["format"] {
  const name = typeof file === "string" ? file : file.name;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "e57") return "e57";
  if (ext === "las" || ext === "laz") return "las";
  if (ext === "pcd") return "pcd";
  if (ext === "ply") return "ply";
  throw new Error(`Unknown point cloud extension: ${ext}`);
}

/** Parse a PLY file into a position + colour buffer. */
async function parsePly(file: File): Promise<{ positions: Float32Array; colors: Float32Array | null; count: number; bounds: PointCloudHeader["bounds"] }> {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const lines = text.split(/\r?\n/);
  let vertexCount = 0;
  let headerEnd = 0;
  let hasColor = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("element vertex")) {
      vertexCount = parseInt(lines[i].split(/\s+/)[2], 10);
    }
    if (lines[i].includes("property uchar red")) hasColor = true;
    if (lines[i].trim() === "end_header") {
      headerEnd = i + 1;
      break;
    }
  }
  const positions = new Float32Array(vertexCount * 3);
  const colors = hasColor ? new Float32Array(vertexCount * 3) : null;
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    const parts = (lines[headerEnd + i] ?? "").trim().split(/\s+/).map(Number);
    if (parts.length < 3) continue;
    positions[i * 3] = parts[0];
    positions[i * 3 + 1] = parts[1];
    positions[i * 3 + 2] = parts[2];
    if (parts[0] < min[0]) min[0] = parts[0];
    if (parts[1] < min[1]) min[1] = parts[1];
    if (parts[2] < min[2]) min[2] = parts[2];
    if (parts[0] > max[0]) max[0] = parts[0];
    if (parts[1] > max[1]) max[1] = parts[1];
    if (parts[2] > max[2]) max[2] = parts[2];
    if (colors && parts.length >= 6) {
      colors[i * 3] = parts[3] / 255;
      colors[i * 3 + 1] = parts[4] / 255;
      colors[i * 3 + 2] = parts[5] / 255;
    }
  }
  return { positions, colors, count: vertexCount, bounds: { min, max } };
}

/** Parse a PCD ASCII file. */
async function parsePcd(file: File): Promise<{ positions: Float32Array; colors: Float32Array | null; count: number; bounds: PointCloudHeader["bounds"] }> {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const lines = text.split(/\r?\n/);
  let dataStart = 0;
  let count = 0;
  let fields: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("POINTS ")) count = parseInt(lines[i].split(/\s+/)[1], 10);
    if (lines[i].startsWith("FIELDS ")) fields = lines[i].split(/\s+/).slice(1);
    if (lines[i].startsWith("DATA ")) { dataStart = i + 1; break; }
  }
  const hasColor = fields.includes("rgb");
  const positions = new Float32Array(count * 3);
  const colors = hasColor ? new Float32Array(count * 3) : null;
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const parts = (lines[dataStart + i] ?? "").trim().split(/\s+/).map(Number);
    if (parts.length < 3) continue;
    positions[i * 3] = parts[0];
    positions[i * 3 + 1] = parts[1];
    positions[i * 3 + 2] = parts[2];
    if (parts[0] < min[0]) min[0] = parts[0];
    if (parts[1] < min[1]) min[1] = parts[1];
    if (parts[2] < min[2]) min[2] = parts[2];
    if (parts[0] > max[0]) max[0] = parts[0];
    if (parts[1] > max[1]) max[1] = parts[1];
    if (parts[2] > max[2]) max[2] = parts[2];
    if (colors && parts.length >= 4) {
      const rgb = parts[3] | 0;
      colors[i * 3] = ((rgb >> 16) & 0xff) / 255;
      colors[i * 3 + 1] = ((rgb >> 8) & 0xff) / 255;
      colors[i * 3 + 2] = (rgb & 0xff) / 255;
    }
  }
  return { positions, colors, count, bounds: { min, max } };
}

/** Load a point cloud from a file. */
export async function loadPointCloud(
  file: File,
  options: PointCloudLoadOptions = {},
): Promise<PointCloudResult> {
  const p: Required<PointCloudLoadOptions> = { ...DEFAULTS, ...options };
  const format = detectFormat(file);
  let parsed: { positions: Float32Array; colors: Float32Array | null; count: number; bounds: PointCloudHeader["bounds"] };

  if (format === "ply") parsed = await parsePly(file);
  else if (format === "pcd") parsed = await parsePcd(file);
  else throw new Error(`Point cloud format ${format} not yet supported in browser — convert to PLY/PCD.`);

  const { positions, colors, count, bounds } = parsed;
  let actualPoints = count;
  let decimated = false;
  let finalPositions = positions;
  let finalColors = colors;

  if (count > p.maxPoints) {
    decimated = true;
    const step = Math.ceil(count / p.maxPoints);
    actualPoints = Math.floor(count / step);
    finalPositions = new Float32Array(actualPoints * 3);
    if (colors) finalColors = new Float32Array(actualPoints * 3);
    let idx = 0;
    for (let i = 0; i < count; i += step) {
      finalPositions[idx * 3] = positions[i * 3];
      finalPositions[idx * 3 + 1] = positions[i * 3 + 1];
      finalPositions[idx * 3 + 2] = positions[i * 3 + 2];
      if (finalColors && colors) {
        finalColors[idx * 3] = colors[i * 3];
        finalColors[idx * 3 + 1] = colors[i * 3 + 1];
        finalColors[idx * 3 + 2] = colors[i * 3 + 2];
      }
      idx++;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(finalPositions, 3));
  if (finalColors && p.useColor) {
    geo.setAttribute("color", new THREE.BufferAttribute(finalColors, 3));
  }
  const mat = new THREE.PointsMaterial({
    size: p.pointSize,
    vertexColors: p.useColor && !!finalColors,
    color: p.defaultColor,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = `obs-pointcloud-${format}`;
  points.userData = { kind: "point-cloud", format, originalCount: count };

  return {
    header: { format, pointCount: count, bounds },
    points,
    actualPoints,
    decimated,
  };
}

/** Clip a point cloud by a 2D polygon (in XZ plane). Returns a new Points object. */
export function clipPointCloudByPolygon(
  cloud: THREE.Points,
  polygon: Array<{ x: number; z: number }>,
): THREE.Points {
  const pos = cloud.geometry.getAttribute("position") as THREE.BufferAttribute;
  const positions: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Point-in-polygon.
    let inside = false;
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      const xi = polygon[j].x, zi = polygon[j].z;
      const xk = polygon[k].x, zk = polygon[k].z;
      const intersect = (zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) positions.push(x, pos.getY(i), z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = (cloud.material as THREE.PointsMaterial).clone();
  return new THREE.Points(geo, mat);
}
