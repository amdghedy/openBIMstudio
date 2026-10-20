/**
 * Rebar geometry generator — produces 3D triangle soup from rebar centrelines.
 *
 * Each bar is rendered as a series of cylinders (one per segment) with
 * optional bend arcs. The output is a flat Float32Array of positions
 * compatible with THREE.BufferGeometry.
 *
 * Pure TypeScript: no three.js, no DOM. Same pattern as m2-geometry.ts.
 */

import type { RebarBar, RebarSegment, Vec3 } from "./types";

type V3 = [number, number, number];

export interface RebarGeoResult {
  /** Flat array of triangle vertex positions (3 per vertex, 9 per triangle). */
  positions: number[];
  /** Color for all bars (single material). */
  color: string;
  /** Number of triangles generated. */
  triangleCount: number;
}

/** Generate a cylinder mesh between two 3D points. */
function cylinderMesh(
  start: V3,
  end: V3,
  radius: number,
  segments: number,
  positions: number[],
): void {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return;

  // Direction vector
  const dir: V3 = [dx / len, dy / len, dz / len];
  // Up vector (reference for computing perpendicular)
  const up: V3 = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  // Cross to get perpendicular
  const right: V3 = [
    dir[1] * up[2] - dir[2] * up[1],
    dir[2] * up[0] - dir[0] * up[2],
    dir[0] * up[1] - dir[1] * up[0],
  ];
  const rl = Math.sqrt(right[0] * right[0] + right[1] * right[1] + right[2] * right[2]) || 1;
  right[0] /= rl; right[1] /= rl; right[2] /= rl;
  // Second perpendicular = dir × right
  const forward: V3 = [
    dir[1] * right[2] - dir[2] * right[1],
    dir[2] * right[0] - dir[0] * right[2],
    dir[0] * right[1] - dir[1] * right[0],
  ];

  // Generate ring of vertices at start and end
  const ring0: V3[] = [];
  const ring1: V3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ox = right[0] * cos * radius + forward[0] * sin * radius;
    const oy = right[1] * cos * radius + forward[1] * sin * radius;
    const oz = right[2] * cos * radius + forward[2] * sin * radius;
    ring0.push([start[0] + ox, start[1] + oy, start[2] + oz]);
    ring1.push([end[0] + ox, end[1] + oy, end[2] + oz]);
  }

  // Side faces (quads = 2 triangles)
  for (let i = 0; i < segments; i++) {
    const ni = (i + 1) % segments;
    // Triangle 1: ring0[i], ring0[ni], ring1[i]
    positions.push(...ring0[i], ...ring0[ni], ...ring1[i]);
    // Triangle 2: ring0[ni], ring1[ni], ring1[i]
    positions.push(...ring0[ni], ...ring1[ni], ...ring1[i]);
  }

  // Cap at start (triangle fan)
  for (let i = 1; i < segments - 1; i++) {
    positions.push(...ring0[0], ...ring0[i], ...ring0[i + 1]);
  }
  // Cap at end
  for (let i = 1; i < segments - 1; i++) {
    positions.push(...ring1[0], ...ring1[i + 1], ...ring1[i]);
  }
}

/** Generate 3D mesh for a single rebar bar. */
export function generateBarMesh(
  bar: RebarBar,
  segments: number = 8,
): { positions: number[]; triangleCount: number } {
  const positions: number[] = [];
  let triCount = 0;

  for (const seg of bar.segments) {
    const start: V3 = [seg.start.x, seg.start.y, seg.start.z];
    const end: V3 = [seg.end.x, seg.end.y, seg.end.z];
    const beforeLen = positions.length;
    cylinderMesh(start, end, bar.diameter / 2, segments, positions);
    // Each cylinder produces segments * 2 side tris + (segments - 2) * 2 cap tris.
    triCount += (positions.length - beforeLen) / 9;
  }

  return { positions, triangleCount: triCount };
}

/** Generate 3D mesh for all bars in a layout. */
export function generateRebarMesh(
  bars: RebarBar[],
  segments: number = 8,
  color: string = "#475569",
): RebarGeoResult {
  const positions: number[] = [];
  let triCount = 0;

  for (const bar of bars) {
    const { positions: barPos, triangleCount } = generateBarMesh(bar, segments);
    positions.push(...barPos);
    triCount += triangleCount;
  }

  return { positions, color, triangleCount: triCount };
}
