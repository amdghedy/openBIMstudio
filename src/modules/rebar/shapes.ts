/**
 * Rebar shape library — standard bar shapes per ACI 315.
 *
 * Each shape function takes a bar diameter + a set of shape-specific
 * parameters, and returns the centreline as a series of 3D segments
 * (polyline points). The geometry generator then sweeps a circle along
 * this centreline to produce the 3D mesh.
 *
 * All coordinates are in metres, relative to the bar's start point.
 * The layout engine positions the bar in world space by translating
 * these segments.
 */

import type { RebarSegment, Vec3 } from "./types";
import { bendRadius } from "./types";

/** Create a straight bar centreline. */
export function straightBar(
  length: number,
): RebarSegment[] {
  return [
    { start: { x: 0, y: 0, z: 0 }, end: { x: length, y: 0, z: 0 } },
  ];
}

/** Create an L-bend bar (90° bend at one end).
 *
 * Shape: ──┐
 *          │
 *
 * The bar runs straight for `straightLength`, then bends 90° down (or up)
 * for `hookLength`. The bend radius is 4× diameter per ACI.
 */
export function lBendBar(
  length: number,
  hookLength: number,
  diameter: number,
): RebarSegment[] {
  const r = bendRadius(diameter);
  const straight = Math.max(0, length - hookLength - r);
  return [
    { start: { x: 0, y: 0, z: 0 }, end: { x: straight, y: 0, z: 0 } },
    { start: { x: straight, y: 0, z: 0 }, end: { x: straight + r, y: r, z: 0 }, startRadius: r },
    { start: { x: straight + r, y: r, z: 0 }, end: { x: straight + r, y: r + hookLength, z: 0 } },
  ];
}

/** Create a double-L bar (90° bends at both ends).
 *
 * Shape: ┌──┐
 *        │  │
 */
export function doubleLBar(
  length: number,
  hookLength: number,
  diameter: number,
): RebarSegment[] {
  const r = bendRadius(diameter);
  const straight = Math.max(0, length - 2 * (hookLength + r));
  return [
    { start: { x: 0, y: hookLength, z: 0 }, end: { x: 0, y: r, z: 0 } },
    { start: { x: 0, y: r, z: 0 }, end: { x: r, y: 0, z: 0 }, startRadius: r },
    { start: { x: r, y: 0, z: 0 }, end: { x: r + straight, y: 0, z: 0 } },
    { start: { x: r + straight, y: 0, z: 0 }, end: { x: r + straight + r, y: r, z: 0 }, startRadius: r },
    { start: { x: r + straight + r, y: r, z: 0 }, end: { x: r + straight + r, y: r + hookLength, z: 0 } },
  ];
}

/** Create a U-bar (180° bend at one end).
 *
 * Shape: ──┐
 *          │
 *        ──┘
 *
 * The bar runs straight, bends 180°, then runs back parallel.
 */
export function uBar(
  length: number,
  bendWidth: number,
  diameter: number,
): RebarSegment[] {
  const r = bendRadius(diameter);
  const straight = Math.max(0, length - r);
  return [
    { start: { x: 0, y: 0, z: 0 }, end: { x: straight, y: 0, z: 0 } },
    { start: { x: straight, y: 0, z: 0 }, end: { x: straight + r, y: bendWidth - r, z: 0 }, startRadius: r },
    { start: { x: straight + r, y: bendWidth - r, z: 0 }, end: { x: straight + r, y: bendWidth, z: 0 } },
    { start: { x: straight + r, y: bendWidth, z: 0 }, end: { x: 0, y: bendWidth, z: 0 } },
  ];
}

/**
 * Create a rectangular stirrup (closed loop with 4 bends).
 *
 * Shape: ┌──┐
 *        │  │
 *        │  │
 *        └──┘ (closed)
 *
 * The stirrup wraps around a rectangle of width × depth, inset by
 * cover from the concrete face.
 */
export function rectangularStirrup(
  width: number,
  depth: number,
  diameter: number,
  closed: boolean = true,
): RebarSegment[] {
  const r = bendRadius(diameter);
  // Inset corners by the bend radius so the bar doesn't stick out.
  const w = Math.max(2 * r + 0.01, width);
  const d = Math.max(2 * r + 0.01, depth);
  const innerW = w - 2 * r;
  const innerD = d - 2 * r;

  const segs: RebarSegment[] = [
    // Bottom side (left to right)
    { start: { x: r, y: 0, z: 0 }, end: { x: r + innerW, y: 0, z: 0 } },
    // Right side (bottom to top) with bend at bottom-right
    { start: { x: r + innerW, y: 0, z: 0 }, end: { x: w, y: r, z: 0 }, startRadius: r },
    { start: { x: w, y: r, z: 0 }, end: { x: w, y: r + innerD, z: 0 } },
    // Top side (right to left) with bend at top-right
    { start: { x: w, y: r + innerD, z: 0 }, end: { x: r + innerW, y: d, z: 0 }, startRadius: r },
    { start: { x: r + innerW, y: d, z: 0 }, end: { x: r, y: d, z: 0 } },
    // Left side (top to bottom) with bend at top-left
    { start: { x: r, y: d, z: 0 }, end: { x: 0, y: r + innerD, z: 0 }, startRadius: r },
    { start: { x: 0, y: r + innerD, z: 0 }, end: { x: 0, y: r, z: 0 } },
  ];

  if (closed) {
    // Close the loop with a final bend at bottom-left
    segs.push({
      start: { x: 0, y: r, z: 0 },
      end: { x: r, y: 0, z: 0 },
      startRadius: r,
    });
  }

  return segs;
}

/**
 * Create an open stirrup (3 bends, one side open).
 * Used when the beam has a slab on one side and the stirrup
 * can't close on that face.
 */
export function openStirrup(
  width: number,
  depth: number,
  diameter: number,
): RebarSegment[] {
  // Same as rectangular stirrup but without the final closing segment.
  return rectangularStirrup(width, depth, diameter, false);
}

/**
 * Compute the total length of a bar centreline (sum of segment lengths).
 */
export function totalBarLength(segments: RebarSegment[]): number {
  let L = 0;
  for (const s of segments) {
    const dx = s.end.x - s.start.x;
    const dy = s.end.y - s.start.y;
    const dz = s.end.z - s.start.z;
    L += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return L;
}

/** Translate all segments of a bar by an offset vector. */
export function translateBar(
  segments: RebarSegment[],
  offset: Vec3,
): RebarSegment[] {
  return segments.map((s) => ({
    start: { x: s.start.x + offset.x, y: s.start.y + offset.y, z: s.start.z + offset.z },
    end: { x: s.end.x + offset.x, y: s.end.y + offset.y, z: s.end.z + offset.z },
    startRadius: s.startRadius,
  }));
}

/** Rotate bar segments around the Y axis by an angle (radians). */
export function rotateBarY(
  segments: RebarSegment[],
  angle: number,
): RebarSegment[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rot = (p: Vec3): Vec3 => ({
    x: p.x * cos + p.z * sin,
    y: p.y,
    z: -p.x * sin + p.z * cos,
  });
  return segments.map((s) => ({
    start: rot(s.start),
    end: rot(s.end),
    startRadius: s.startRadius,
  }));
}
