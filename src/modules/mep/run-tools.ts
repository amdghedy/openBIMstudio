/**
 * Parametric run-editing tools for linear MEP elements.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * The geometry model matches RouteLeg (router.ts): a run is a polyline of
 * axis-aligned plan legs with an elevation per leg. These helpers implement
 * the operations designers expect from a parametric MEP modeler:
 *   - justification (left / center / right relative to the drawn line)
 *   - split / merge of legs (tap and heal operations)
 *   - tap points for branch takeoffs
 *   - resize decisions with automatic transition detection
 *   - slope compliance for gravity systems
 *   - duct noise banding by velocity
 */

import type { MepSystem, RouteLeg, Vec3 } from "./types";
import { sizeForSystem } from "./sizing";

// ── Justification ────────────────────────────────────────────────────────

/** Duct justification relative to the drawn centerline. */
export type Justification = "center" | "left" | "right";

/**
 * Offset the two endpoints of a plan run so the chosen face sits on the
 * drawn line. "left"/"right" are relative to the direction of travel from
 * start to end. Vertical coordinates are preserved.
 */
export function justifyRun(
  start: Vec3,
  end: Vec3,
  widthM: number,
  justification: Justification,
): { start: Vec3; end: Vec3 } {
  if (justification === "center" || !(widthM > 0)) return { start, end };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return { start, end };
  // Unit perpendicular in plan (rotate direction +90°): (-dz, dx)/len.
  const sign = justification === "left" ? -1 : 1;
  const off = (sign * widthM) / 2;
  const nx = (-dz / len) * off;
  const nz = (dx / len) * off;
  return {
    start: { x: start.x + nx, y: start.y, z: start.z + nz },
    end: { x: end.x + nx, y: end.y, z: end.z + nz },
  };
}

// ── Split / merge ────────────────────────────────────────────────────────

/**
 * Split a leg at a fractional parameter t ∈ [0,1] (or at a distance in
 * metres when `asDistance` is true). Returns two legs covering the original.
 */
export function splitLegAt(leg: RouteLeg, t: number, asDistance = false): [RouteLeg, RouteLeg] {
  const frac = asDistance
    ? (leg.length > 0 ? Math.min(1, Math.max(0, t / leg.length)) : 0)
    : Math.min(1, Math.max(0, t));
  const mid: Vec3 = {
    x: leg.start.x + (leg.end.x - leg.start.x) * frac,
    y: leg.start.y + (leg.end.y - leg.start.y) * frac,
    z: leg.start.z + (leg.end.z - leg.start.z) * frac,
  };
  const mk = (a: Vec3, b: Vec3): RouteLeg => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return {
      start: a, end: b, length,
      planAngle: Math.atan2(dz, dx),
      isVertical: length > 0 && Math.abs(dy) > 0.5 * length,
    };
  };
  return [mk(leg.start, mid), mk(mid, leg.end)];
}

/**
 * Merge consecutive collinear legs (same plan direction and elevation
 * delta ratio) into single legs — the "heal the polyline" operation used
 * after splits, taps and joint healing.
 */
export function mergeCollinearLegs(legs: RouteLeg[]): RouteLeg[] {
  if (legs.length <= 1) return legs.slice();
  const out: RouteLeg[] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (!prev) { out.push({ ...leg }); continue; }
    const d1x = prev.end.x - prev.start.x;
    const d1y = prev.end.y - prev.start.y;
    const d1z = prev.end.z - prev.start.z;
    const d2x = leg.end.x - leg.start.x;
    const d2y = leg.end.y - leg.start.y;
    const d2z = leg.end.z - leg.start.z;
    // Cross product of the plan directions must vanish, and vertical rise
    // per metre must match (or both be flat).
    const cross = d1x * d2z - d1z * d2x;
    const l1 = Math.hypot(d1x, d1z);
    const l2 = Math.hypot(d2x, d2z);
    const slope1 = l1 > 1e-9 ? d1y / l1 : 0;
    const slope2 = l2 > 1e-9 ? d2y / l2 : 0;
    if (Math.abs(cross) < 1e-9 && Math.abs(slope1 - slope2) < 1e-6) {
      out[out.length - 1] = {
        start: prev.start,
        end: leg.end,
        length: prev.length + leg.length,
        planAngle: Math.atan2(leg.end.z - prev.start.z, leg.end.x - prev.start.x),
        isVertical: prev.isVertical && leg.isVertical,
      };
    } else {
      out.push({ ...leg });
    }
  }
  return out;
}

// ── Tap / takeoff ────────────────────────────────────────────────────────

export interface TapPoint {
  /** Takeoff point on the run. */
  point: Vec3;
  /** Plan angle of the host run (radians). */
  hostAngle: number;
  /** Unit branch directions perpendicular to the host (plan). */
  perpLeft: Vec3;
  perpRight: Vec3;
}

/**
 * Branch takeoff geometry at a distance along a leg — the anchor of
 * tee / wye placement tools.
 */
export function tapPoint(leg: RouteLeg, distanceM: number): TapPoint {
  const [a] = splitLegAt(leg, distanceM, true);
  const p = a.end;
  const dx = leg.end.x - leg.start.x;
  const dz = leg.end.z - leg.start.z;
  const len = Math.max(1e-9, Math.hypot(dx, dz));
  const nx = -dz / len;
  const nz = dx / len;
  return {
    point: p,
    hostAngle: leg.planAngle,
    perpLeft: { x: p.x + nx, y: p.y, z: p.z + nz },
    perpRight: { x: p.x - nx, y: p.y, z: p.z - nz },
  };
}

// ── Resize / transition decisions ────────────────────────────────────────

export interface ResizeDecision {
  /** Newly sized cross-section. */
  size: { thickness: number; height: number; velocity: number; area: number; rule: string };
  /** True when the neighbouring run's size differs and a transition/reducer is needed. */
  transitionNeeded: boolean;
  /** Sizing rule and transition explanation, for the property palette. */
  notes: string[];
}

/**
 * Parametric resize of a run for a new flow rate. Compares the fresh
 * ASHRAE sizing with the current cross-section and decides whether the
 * upstream/downstream connection needs a reducer or transition fitting.
 */
export function resizeRunDecision(
  system: MepSystem,
  currentSize: { thickness: number; height: number },
  newFlowRate: number,
  maxVelocity?: number,
): ResizeDecision {
  const result = sizeForSystem(system, newFlowRate, maxVelocity);
  const same = Math.abs(result.size.thickness - currentSize.thickness) < 1e-9
    && Math.abs(result.size.height - currentSize.height) < 1e-9;
  const notes = [`Resized by rule: ${result.size.rule}`];
  notes.push(...result.warnings);
  if (!same) {
    notes.push(
      `Size changes from ${currentSize.thickness}×${currentSize.height} m to ` +
      `${result.size.thickness}×${result.size.height} m — a transition fitting is required at the connection.`,
    );
  }
  return {
    size: result.size,
    transitionNeeded: !same,
    notes,
  };
}

// ── Slope compliance ─────────────────────────────────────────────────────

/** Minimum design slope per gravity system (percent). */
export const MIN_SLOPE_PERCENT: Partial<Record<MepSystem, number>> = {
  sanitary: 1.0,
  condensate: 0.5,
  "domestic-cold": 0,
  "domestic-hot": 0,
};

export interface SlopeVerdict {
  slopePercent: number;
  minPercent: number;
  ok: boolean;
  message: string;
}

/** Check a run's slope against the gravity-system minimum. */
export function slopeCheck(
  system: MepSystem,
  startElevM: number,
  endElevM: number,
  horizontalLengthM: number,
): SlopeVerdict {
  const min = MIN_SLOPE_PERCENT[system] ?? 0;
  const pct = horizontalLengthM > 1e-9 ? ((endElevM - startElevM) / horizontalLengthM) * 100 : 0;
  const ok = pct >= min - 1e-9;
  return {
    slopePercent: pct,
    minPercent: min,
    ok,
    message: min === 0
      ? `Slope ${pct.toFixed(2)}% — no minimum applies to ${system}.`
      : ok
        ? `Slope ${pct.toFixed(2)}% meets the ${min}% minimum for ${system}.`
        : `Slope ${pct.toFixed(2)}% is below the ${min}% minimum for ${system} — re-pitch the run.`,
  };
}

// ── Acoustic banding ─────────────────────────────────────────────────────

export interface NoiseEstimate {
  /** Approximate NC band of the duct noise at the given velocity. */
  ncApprox: number;
  /** Human band label. */
  band: "quiet" | "moderate" | "noisy" | "very noisy";
  note: string;
}

/**
 * Rough NC banding for air systems by duct velocity (ASHRAE Applications
 * guidance: mains sized ~4.5-6 m/s for NC 25-40 spaces). Non-air systems
 * return the quiet band with a note.
 */
export function noiseEstimate(velocityMs: number, system: MepSystem): NoiseEstimate {
  const isAir = system.endsWith("-air");
  if (!isAir) {
    return { ncApprox: 0, band: "quiet", note: "Noise banding applies to air systems only." };
  }
  const nc = velocityMs <= 4.5 ? 25
    : velocityMs <= 6 ? 35
    : velocityMs <= 7.5 ? 45
    : 55;
  const band = nc <= 25 ? "quiet"
    : nc <= 35 ? "moderate"
    : nc <= 45 ? "noisy"
    : "very noisy";
  return {
    ncApprox: nc,
    band,
    note: `≈NC ${nc} at ${velocityMs.toFixed(2)} m/s — ${band}. Attenuators or larger ducts are needed for NC-critical rooms.`,
  };
}
