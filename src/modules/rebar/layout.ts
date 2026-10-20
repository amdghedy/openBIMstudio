/**
 * Rebar layout engine — computes bar positions inside host elements.
 *
 * Given a RebarHost (beam/column/slab/footing with dimensions + cover)
 * and a RebarLayoutConfig (bar diameters, counts, spacing), produces a
 * RebarLayout: a set of RebarBar objects with world-space centrelines.
 *
 * Layout conventions:
 *
 *   Beam (horizontal, length along X):
 *     - Bottom main bars: N bars evenly spaced across the width,
 *       at the bottom of the cross-section (y = cover from bottom).
 *     - Top main bars: same, at the top (y = depth - cover).
 *     - Stirrups: rectangular loop, spaced along the length at `spacing`.
 *     - Side bars (optional): along the sides at mid-height.
 *
 *   Column (vertical, height along Y):
 *     - Vertical main bars: N bars evenly spaced around the perimeter.
 *     - Stirrups/links: horizontal rectangular loops at spacing.
 *
 *   Slab (horizontal, thickness along Y):
 *     - Mesh: grid of straight bars at the bottom + top, in both X and Z
 *       directions, at a spacing.
 *
 * The host element is assumed to be aligned with the X axis for beams,
 * Y axis for columns. For other orientations, the caller rotates the
 * resulting bars. (Future: support arbitrary orientation via `direction`.)
 */

import type {
  RebarBar, RebarHost, RebarLayout, RebarLayoutConfig,
  RebarSegment, Vec3,
} from "./types";
import { barArea, barMass, DEFAULT_REBAR_CONFIG, STEEL_DENSITY } from "./types";
import {
  straightBar, rectangularStirrup, openStirrup,
  totalBarLength, translateBar,
} from "./shapes";

let barIdCounter = 0;
function nextBarId(): string {
  return `rebar-${++barIdCounter}`;
}

/** Resolve a partial config with defaults. */
function resolveConfig(cfg: Partial<RebarLayoutConfig>): RebarLayoutConfig {
  return { ...DEFAULT_REBAR_CONFIG, ...cfg } as RebarLayoutConfig;
}

/**
 * Layout rebar for a beam.
 *
 * Beam coordinate system:
 *   X = length (span direction)
 *   Y = vertical (up)
 *   Z = width (lateral)
 *
 * Cross-section (X = 0 plane, looking along +X):
 *   Z = -width/2 ........ Z = +width/2
 *   Y = 0 (bottom) ...... Y = depth (top)
 *
 * Cover offsets bars inward from every face.
 */
export function layoutBeamRebar(cfg: Partial<RebarLayoutConfig>): RebarLayout {
  const c = resolveConfig(cfg);
  const h = c.host;
  const bars: RebarBar[] = [];
  let totalMass = 0;
  let totalVolume = 0;

  const L = h.length;
  const W = h.width;
  const D = h.depth;
  const cover = h.cover;
  const halfW = W / 2 - cover - c.mainBarDiameter / 2;
  const bottomY = cover + c.mainBarDiameter / 2;
  const topY = D - cover - c.mainBarDiameter / 2;

  // Bottom main bars
  for (let i = 0; i < c.mainBarCountBottom; i++) {
    const t = c.mainBarCountBottom === 1 ? 0.5 : i / (c.mainBarCountBottom - 1);
    const z = -halfW + t * (2 * halfW);
    const segs = translateBar(
      straightBar(L),
      { x: h.origin.x, y: h.origin.y + bottomY, z: h.origin.z + z },
    );
    const len = totalBarLength(segs);
    const mass = barMass(len, c.mainBarDiameter);
    bars.push({
      id: nextBarId(), shape: "straight", diameter: c.mainBarDiameter,
      segments: segs, totalLength: len, mass, role: "main-bottom",
      mark: `${i + 1}B`,
    });
    totalMass += mass;
    totalVolume += len * barArea(c.mainBarDiameter);
  }

  // Top main bars
  for (let i = 0; i < c.mainBarCountTop; i++) {
    const t = c.mainBarCountTop === 1 ? 0.5 : i / (c.mainBarCountTop - 1);
    const z = -halfW + t * (2 * halfW);
    const segs = translateBar(
      straightBar(L),
      { x: h.origin.x, y: h.origin.y + topY, z: h.origin.z + z },
    );
    const len = totalBarLength(segs);
    const mass = barMass(len, c.mainBarDiameter);
    bars.push({
      id: nextBarId(), shape: "straight", diameter: c.mainBarDiameter,
      segments: segs, totalLength: len, mass, role: "main-top",
      mark: `${i + 1}T`,
    });
    totalMass += mass;
    totalVolume += len * barArea(c.mainBarDiameter);
  }

  // Stirrups along the length
  const stirrupCount = Math.max(2, Math.floor(L / c.stirrupSpacing));
  const stirrupSpacing = L / stirrupCount;
  for (let i = 0; i <= stirrupCount; i++) {
    const x = h.origin.x + i * stirrupSpacing;
    const stirrupW = W - 2 * cover - c.stirrupDiameter;
    const stirrupD = D - 2 * cover - c.stirrupDiameter;
    const stirrupSegs = c.stirrupShape === "stirrup-open"
      ? openStirrup(stirrupW, stirrupD, c.stirrupDiameter)
      : rectangularStirrup(stirrupW, stirrupD, c.stirrupDiameter, true);
    // Rotate stirrup so it wraps around the cross-section (Y is up).
    // The stirrup is generated in the XY plane; we need it in the YZ plane.
    const rotatedSegs = stirrupSegs.map((s) => ({
      start: { x: x, y: h.origin.y + cover + c.stirrupDiameter / 2 + s.start.y, z: h.origin.z + s.start.x - (stirrupW / 2 + c.stirrupDiameter / 2 + cover) },
      end: { x: x, y: h.origin.y + cover + c.stirrupDiameter / 2 + s.end.y, z: h.origin.z + s.end.x - (stirrupW / 2 + c.stirrupDiameter / 2 + cover) },
      startRadius: s.startRadius,
    }));
    const len = totalBarLength(rotatedSegs);
    const mass = barMass(len, c.stirrupDiameter);
    bars.push({
      id: nextBarId(), shape: c.stirrupShape, diameter: c.stirrupDiameter,
      segments: rotatedSegs, totalLength: len, mass, role: "stirrup",
      mark: `S${i + 1}`,
    });
    totalMass += mass;
    totalVolume += len * barArea(c.stirrupDiameter);
  }

  // Side bars (skin reinforcement)
  if (c.sideBarCount > 0) {
    for (let i = 0; i < c.sideBarCount; i++) {
      const t = c.sideBarCount === 1 ? 0.5 : i / (c.sideBarCount - 1);
      const y = cover + c.mainBarDiameter + t * (D - 2 * cover - 2 * c.mainBarDiameter);
      // Left side bar
      const zLeft = -(halfW) + cover / 2;
      const segsL = translateBar(
        straightBar(L),
        { x: h.origin.x, y: h.origin.y + y, z: h.origin.z + zLeft },
      );
      const lenL = totalBarLength(segsL);
      const massL = barMass(lenL, c.sideBarDiameter);
      bars.push({
        id: nextBarId(), shape: "straight", diameter: c.sideBarDiameter,
        segments: segsL, totalLength: lenL, mass: massL, role: "main-side",
        mark: `SL${i + 1}`,
      });
      totalMass += massL;
      totalVolume += lenL * barArea(c.sideBarDiameter);
      // Right side bar
      const zRight = halfW - cover / 2;
      const segsR = translateBar(
        straightBar(L),
        { x: h.origin.x, y: h.origin.y + y, z: h.origin.z + zRight },
      );
      const lenR = totalBarLength(segsR);
      const massR = barMass(lenR, c.sideBarDiameter);
      bars.push({
        id: nextBarId(), shape: "straight", diameter: c.sideBarDiameter,
        segments: segsR, totalLength: lenR, mass: massR, role: "main-side",
        mark: `SR${i + 1}`,
      });
      totalMass += massR;
      totalVolume += lenR * barArea(c.sideBarDiameter);
    }
  }

  const concreteVolume = W * D * L;
  return {
    host: h, bars, totalMass, totalVolume,
    steelRatio: concreteVolume > 0 ? totalVolume / concreteVolume : 0,
  };
}

/**
 * Layout rebar for a column.
 *
 * Column coordinate system:
 *   X, Z = cross-section (width × depth)
 *   Y = vertical (up)
 *
 * Main bars run vertically along Y; stirrups are horizontal loops at
 * spacing intervals along Y.
 */
export function layoutColumnRebar(cfg: Partial<RebarLayoutConfig>): RebarLayout {
  const c = resolveConfig(cfg);
  const h = c.host;
  const bars: RebarBar[] = [];
  let totalMass = 0;
  let totalVolume = 0;

  const H = h.length;
  const W = h.width;
  const D = h.depth;
  const cover = h.cover;
  const mainCount = c.mainBarCountBottom + c.mainBarCountTop;

  // Vertical main bars: evenly distributed around the perimeter.
  const perimeter = 2 * (W + D) - 8 * cover;
  const barSpacing = perimeter / mainCount;
  let dist = 0;
  for (let i = 0; i < mainCount; i++) {
    const [x, z] = pointOnPerimeter(dist, W, D, cover);
    const segs = translateBar(
      straightBar(H),
      { x: h.origin.x + x, y: h.origin.y, z: h.origin.z + z },
    );
    // Rotate: straight bar runs along X, but we need it along Y.
    const rotatedSegs = segs.map((s) => ({
      start: { x: s.start.x, y: s.start.z, z: s.end.x },
      end: { x: s.end.x, y: s.end.z, z: s.end.x },
      startRadius: s.startRadius,
    }));
    // Actually, the straight bar is along X; we need it along Y.
    // So swap Y and X in the segment endpoints.
    const ySegs: RebarSegment[] = [
      {
        start: { x: h.origin.x + x, y: h.origin.y, z: h.origin.z + z },
        end: { x: h.origin.x + x, y: h.origin.y + H, z: h.origin.z + z },
      },
    ];
    const len = H;
    const mass = barMass(len, c.mainBarDiameter);
    bars.push({
      id: nextBarId(), shape: "straight", diameter: c.mainBarDiameter,
      segments: ySegs, totalLength: len, mass, role: i < c.mainBarCountBottom ? "main-bottom" : "main-top",
      mark: `V${i + 1}`,
    });
    totalMass += mass;
    totalVolume += len * barArea(c.mainBarDiameter);
    dist += barSpacing;
  }

  // Horizontal stirrups (links) along the height.
  const linkCount = Math.max(2, Math.floor(H / c.stirrupSpacing));
  const linkSpacing = H / linkCount;
  for (let i = 0; i <= linkCount; i++) {
    const y = h.origin.y + i * linkSpacing;
    const linkW = W - 2 * cover - c.stirrupDiameter;
    const linkD = D - 2 * cover - c.stirrupDiameter;
    const linkSegs = rectangularStirrup(linkW, linkD, c.stirrupDiameter, true);
    // Place in the XZ plane at height y.
    const placedSegs: RebarSegment[] = linkSegs.map((s) => ({
      start: { x: h.origin.x + cover + c.stirrupDiameter / 2 + s.start.x, y: y, z: h.origin.z + cover + c.stirrupDiameter / 2 + s.start.y - (linkD / 2 + cover) },
      end: { x: h.origin.x + cover + c.stirrupDiameter / 2 + s.end.x, y: y, z: h.origin.z + cover + c.stirrupDiameter / 2 + s.end.y - (linkD / 2 + cover) },
      startRadius: s.startRadius,
    }));
    const len = totalBarLength(placedSegs);
    const mass = barMass(len, c.stirrupDiameter);
    bars.push({
      id: nextBarId(), shape: "stirrup", diameter: c.stirrupDiameter,
      segments: placedSegs, totalLength: len, mass, role: "link",
      mark: `L${i + 1}`,
    });
    totalMass += mass;
    totalVolume += len * barArea(c.stirrupDiameter);
  }

  const concreteVolume = W * D * H;
  return {
    host: h, bars, totalMass, totalVolume,
    steelRatio: concreteVolume > 0 ? totalVolume / concreteVolume : 0,
  };
}

/**
 * Compute a point on the inner perimeter of a rectangle, given a
 * distance along the perimeter (starting from bottom-left, going clockwise).
 * Returns [x, z] relative to the section centre.
 */
function pointOnPerimeter(dist: number, W: number, D: number, cover: number): [number, number] {
  const innerW = W - 2 * cover;
  const innerD = D - 2 * cover;
  const halfW = innerW / 2;
  const halfD = innerD / 2;
  const perim = 2 * (innerW + innerD);
  let d = dist % perim;
  // Start at bottom-left (-halfW, -halfD), go clockwise.
  if (d < innerW) return [-halfW + d, -halfD];
  d -= innerW;
  if (d < innerD) return [halfW, -halfD + d];
  d -= innerD;
  if (d < innerW) return [halfW - d, halfD];
  d -= innerW;
  return [-halfW, halfD - d];
}

/**
 * Unified rebar layout dispatcher.
 */
export function layoutRebar(cfg: Partial<RebarLayoutConfig>): RebarLayout {
  const host = cfg.host;
  if (!host) throw new Error("layoutRebar: host is required");
  switch (host.type) {
    case "beam":
      return layoutBeamRebar(cfg);
    case "column":
    case "footing":
      return layoutColumnRebar(cfg);
    case "slab":
    case "wall":
      // Slab/wall rebar (mesh) is a future extension.
      return { host, bars: [], totalMass: 0, totalVolume: 0, steelRatio: 0 };
    default:
      return { host, bars: [], totalMass: 0, totalVolume: 0, steelRatio: 0 };
  }
}
