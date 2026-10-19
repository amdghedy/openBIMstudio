/**
 * MEP Auto-Routing — ASHRAE sizing rules for ducts and pipes.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 *
 * Sizing approach:
 *   - Given a volumetric flow rate Q (m^3/s for air, L/s for water)
 *     and a target velocity v (m/s), the required cross-sectional area is
 *     A = Q / v.
 *   - For ducts (rectangular): pick the smallest standard width from
 *     ASHRAE's recommended sizes that, paired with a height near 1:1 or 2:1
 *     aspect ratio, gives an area >= required. Cap velocity at 5 m/s for
 *     residential, 6 m/s for commercial, 8 m/s for industrial (whisper-quiet
 *     vs quiet vs noisy).
 *   - For pipes (circular): pick the smallest standard DN (Diamètre Nominal)
 *     from ISO 6708 that gives a velocity <= target. Domestic water: 1.5 m/s.
 *     Chilled/hot water: 2.0 m/s. Gas: 5 m/s. Medical: lower.
 *   - For cable trays and conduits: sizing is governed by fill ratio, not
 *     flow. We use the requested flow as a proxy for cable count and pick
 *     a standard size.
 *
 * Velocity caps come from ASHRAE Handbook - Fundamentals, Chapter 21
 * (Duct Design) and Chapter 22 (Pipe Sizing). Recommended values are
 * conservative; commercial practice often exceeds them.
 */

import type { MepSize, MepSystem, SizingResult } from "./types";

/** Standard rectangular duct widths (m). ASHRAE recommended sizes. */
const DUCT_WIDTHS = [
  0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
  0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 1.8, 2.0,
];

/** Standard rectangular duct heights (m). */
const DUCT_HEIGHTS = [
  0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0,
];

/** Standard circular pipe diameters (m). DN sizes per ISO 6708. */
const PIPE_DN = [
  0.015, 0.020, 0.025, 0.032, 0.040, 0.050, 0.065, 0.080, 0.100,
  0.125, 0.150, 0.200, 0.250, 0.300, 0.350, 0.400, 0.450, 0.500,
];

/** Standard cable tray widths (m). */
const TRAY_WIDTHS = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.9];

/** Standard conduit diameters (m). */
const CONDUIT_DN = [0.016, 0.02, 0.025, 0.032, 0.04, 0.05, 0.063];

/** Default target velocities per system (m/s). */
const DEFAULT_VELOCITY: Record<MepSystem, number> = {
  "supply-air":     4.5,  // quiet commercial supply
  "return-air":     4.0,
  "exhaust-air":    5.0,
  "outside-air":    4.5,
  "chilled-water":  2.0,
  "hot-water":      2.0,
  "domestic-cold":  1.5,
  "domestic-hot":   1.5,
  "sanitary":       1.0,   // drainage by gravity
  "condensate":     0.5,   // gravity, very slow
  "gas":            5.0,
  "medical-vacuum": 1.0,
  "medical-oxygen": 1.5,
  "cable-tray":     0,    // not flow-driven
  "conduit":        0,
};

/** Maximum allowable velocity per system (m/s). Above this, sizing warns. */
const MAX_VELOCITY: Record<MepSystem, number> = {
  "supply-air":     6.0,  // noisy above this in commercial
  "return-air":     5.5,
  "exhaust-air":    7.0,
  "outside-air":    6.0,
  "chilled-water":  2.5,
  "hot-water":      2.5,
  "domestic-cold":  2.0,
  "domestic-hot":   2.0,
  "sanitary":       1.5,
  "condensate":     1.0,
  "gas":            8.0,
  "medical-vacuum": 2.0,
  "medical-oxygen": 2.0,
  "cable-tray":     0,
  "conduit":        0,
};

/** Circular cross-section area (m^2) from diameter (m). */
function circleArea(d: number): number {
  return Math.PI * d * d / 4;
}

/** Rectangular cross-section area (m^2). */
function rectArea(w: number, h: number): number {
  return w * h;
}

/**
 * Size a rectangular duct by picking the smallest standard width + height
 * whose area is >= required, preferring aspect ratios close to 1:1 or 2:1.
 */
function sizeDuct(
  flowRate: number, // m^3/s
  targetVelocity: number,
): SizingResult {
  const reqArea = flowRate / targetVelocity;
  const warnings: string[] = [];

  // Try aspect ratios 1:1, 2:1, 3:1, 4:1 in order of preference.

  interface DuctSize { w: number; h: number; area: number; velocity: number; }

  function pickBestDuct(reqArea: number): DuctSize | null {
    let result: DuctSize | null = null;
    for (const ar of [1, 2, 3, 4]) {
      for (const w of DUCT_WIDTHS) {
        const h = DUCT_HEIGHTS.find((hh) => hh >= w / ar) ?? w / ar;
        const area = rectArea(w, h);
        if (area >= reqArea) {
          const velocity = flowRate / area;
          const candidate: DuctSize = { w, h, area, velocity };
          // Pick the smallest-area fitting candidate.
          if (result === null) {
            result = candidate;
          } else {
            const prev: DuctSize = result;
            if (candidate.area < prev.area) {
              result = candidate;
            }
          }
          break;
        }
      }
      if (result !== null) return result;
    }
    return result;
  }

  const best = pickBestDuct(reqArea);

  if (!best) {
    // Fallback: pick the largest standard size; velocity will be too low.
    const w = DUCT_WIDTHS[DUCT_WIDTHS.length - 1];
    const h = DUCT_HEIGHTS[DUCT_HEIGHTS.length - 1];
    const area = rectArea(w, h);
    const velocity = flowRate / area;
    warnings.push(`Required area ${reqArea.toFixed(4)} m^2 exceeds largest standard duct; using ${w}x${h} m.`);
    return {
      size: {
        thickness: w, height: h, velocity, area,
        rule: `fallback: largest standard duct ${w}x${h} m (req area ${reqArea.toFixed(4)} m^2)`,
      },
      warnings,
    };
  }

  if (best.velocity > MAX_VELOCITY["supply-air"]) {
    warnings.push(`Velocity ${best.velocity.toFixed(2)} m/s exceeds ${MAX_VELOCITY["supply-air"]} m/s - duct may be noisy.`);
  }

  return {
    size: {
      thickness: best.w, height: best.h, velocity: best.velocity, area: best.area,
      rule: `rectangular duct ${best.w}x${best.h} m, area ${best.area.toFixed(4)} m^2, velocity ${best.velocity.toFixed(2)} m/s (target ${targetVelocity} m/s)`,
    },
    warnings,
  };
}

/**
 * Size a circular pipe by picking the smallest standard DN whose area gives
 * a velocity <= target.
 */
function sizePipe(
  flowRate: number, // L/s, converted to m^3/s internally
  targetVelocity: number,
  system: MepSystem,
): SizingResult {
  // Convert L/s to m^3/s
  const qMs = flowRate / 1000;
  const reqArea = qMs / targetVelocity;
  const warnings: string[] = [];
  const maxV = MAX_VELOCITY[system];

  // Find smallest DN whose area >= required.
  let best: { d: number; area: number; velocity: number } | null = null;
  for (const d of PIPE_DN) {
    const area = circleArea(d);
    if (area >= reqArea) {
      best = { d, area, velocity: qMs / area };
      break;
    }
  }

  if (!best) {
    // Fallback: largest standard DN.
    const d = PIPE_DN[PIPE_DN.length - 1];
    const area = circleArea(d);
    const velocity = qMs / area;
    warnings.push(`Required area ${reqArea.toFixed(6)} m^2 exceeds largest standard pipe; using DN ${(d * 1000).toFixed(0)} mm.`);
    return {
      size: {
        thickness: d, height: d, velocity, area,
        rule: `fallback: largest standard pipe DN ${(d * 1000).toFixed(0)} (req area ${reqArea.toFixed(6)} m^2)`,
      },
      warnings,
    };
  }

  if (best.velocity > maxV) {
    warnings.push(`Velocity ${best.velocity.toFixed(2)} m/s exceeds ${maxV} m/s for ${system} - consider larger pipe.`);
  }

  return {
    size: {
      thickness: best.d, height: best.d, velocity: best.velocity, area: best.area,
      rule: `circular pipe DN ${(best.d * 1000).toFixed(0)} mm, area ${best.area.toFixed(6)} m^2, velocity ${best.velocity.toFixed(2)} m/s (target ${targetVelocity} m/s)`,
    },
    warnings,
  };
}

/** Size a cable tray. Sizing is by fill, not flow; we map flow to width. */
function sizeCableTray(flowRate: number): SizingResult {
  // Heuristic: 1 L/s ~ 1 cable. Pick the smallest tray that holds ~40% fill.
  const cableCount = Math.max(1, Math.round(flowRate));
  const cableArea = cableCount * 0.0001; // 1 cm^2 per cable
  const reqArea = cableArea / 0.4; // 40% fill ratio
  let best: { w: number; area: number } | null = null;
  for (const w of TRAY_WIDTHS) {
    const h = 0.1; // standard 100 mm depth
    const area = rectArea(w, h);
    if (area >= reqArea) {
      best = { w, area };
      break;
    }
  }
  if (!best) {
    const w = TRAY_WIDTHS[TRAY_WIDTHS.length - 1];
    best = { w, area: rectArea(w, 0.1) };
  }
  return {
    size: {
      thickness: best.w, height: 0.1, velocity: 0, area: best.area,
      rule: `cable tray ${best.w}x0.1 m, fill ${cableCount} cables (40% fill ratio)`,
    },
    warnings: [],
  };
}

/** Size a conduit. Sizing is by fill, not flow; we map flow to diameter. */
function sizeConduit(flowRate: number): SizingResult {
  // Heuristic: 1 L/s ~ 1 cable.
  const cableCount = Math.max(1, Math.round(flowRate));
  const cableArea = cableCount * 0.0001;
  const reqArea = cableArea / 0.4;
  let best: { d: number; area: number } | null = null;
  for (const d of CONDUIT_DN) {
    const area = circleArea(d);
    if (area >= reqArea) {
      best = { d, area };
      break;
    }
  }
  if (!best) {
    const d = CONDUIT_DN[CONDUIT_DN.length - 1];
    best = { d, area: circleArea(d) };
  }
  return {
    size: {
      thickness: best.d, height: best.d, velocity: 0, area: best.area,
      rule: `conduit DN ${(best.d * 1000).toFixed(0)} mm, fill ${cableCount} cables (40% fill ratio)`,
    },
    warnings: [],
  };
}

/**
 * Compute the appropriate size for a given MEP system + flow rate.
 *
 * Flow rate units:
 *   - Air systems (supply/return/exhaust/outside-air): m^3/s
 *   - Water systems (chilled/hot/domestic/sanitary/condensate/gas/medical): L/s
 *   - Cable tray / conduit: L/s as cable-count proxy
 */
export function sizeForSystem(
  system: MepSystem,
  flowRate: number,
  maxVelocity?: number,
): SizingResult {
  const targetV = maxVelocity ?? DEFAULT_VELOCITY[system];

  if (system === "supply-air" || system === "return-air" ||
      system === "exhaust-air" || system === "outside-air") {
    return sizeDuct(flowRate, targetV);
  }
  if (system === "cable-tray") {
    return sizeCableTray(flowRate);
  }
  if (system === "conduit") {
    return sizeConduit(flowRate);
  }
  // All water/gas/medical systems
  return sizePipe(flowRate, targetV, system);
}

/**
 * Validate that a given size meets velocity + standard-dimension constraints.
 * Returns warnings (empty list = fully compliant).
 */
export function validateSize(size: MepSize, system: MepSystem): string[] {
  const warnings: string[] = [];
  const maxV = MAX_VELOCITY[system];
  if (maxV > 0 && size.velocity > maxV) {
    warnings.push(
      `Velocity ${size.velocity.toFixed(2)} m/s exceeds maximum ${maxV} m/s for ${system}.`,
    );
  }
  return warnings;
}

/** Get the default target velocity for a system (read-only). */
export function defaultVelocityFor(system: MepSystem): number {
  return DEFAULT_VELOCITY[system];
}

/** Get the maximum allowable velocity for a system (read-only). */
export function maxVelocityFor(system: MepSystem): number {
  return MAX_VELOCITY[system];
}
