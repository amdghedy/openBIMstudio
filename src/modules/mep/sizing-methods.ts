/**
 * MEP sizing by friction rate and static regain — the two sizing methods
 * RVT offers alongside velocity sizing.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Methods:
 *   - Friction method: pick the smallest standard cross-section whose
 *     specific friction rate (Pa/m) at the design flow is at or below the
 *     target. The friction rate is computed with the same physics as
 *     pressure.ts: Darcy–Weisbach with the Colebrook–White friction
 *     factor, hydraulic diameter for rectangular ducts.
 *   - Static regain method (duct mains): size the first section by the
 *     friction method, then allow each successive section to run slower
 *     only while the drop in velocity head across the section covers that
 *     section's friction loss (classic static-regain sizing). This keeps
 *     the static pressure roughly constant along the main so branch
 *     dampers are not needed to balance.
 *
 * Typical friction-rate targets (ASHRAE practice):
 *   - Low-velocity supply ducts: 0.8–1.0 Pa/m
 *   - Hospital/quiet: 0.4–0.6 Pa/m
 *   - Chilled/hot water: 100–400 Pa/m (m head per 100 m of pipe)
 *
 * Pure engineering aids — manufacturer data and local codes govern.
 */

import { colebrook, FLUID, ROUGHNESS } from "./pressure";
import type { RoughnessMaterial } from "./pressure";
import { DUCT_WIDTHS, DUCT_HEIGHTS, PIPE_DN } from "./sizing";
import type { MepSystem } from "./types";

/** Standard round duct diameters (m). */
export const ROUND_DUCT_DN = [
  0.1, 0.125, 0.15, 0.18, 0.2, 0.224, 0.25, 0.28, 0.315, 0.355, 0.4, 0.45,
  0.5, 0.56, 0.63, 0.71, 0.8, 0.9, 1.0, 1.12, 1.25,
];

export interface FrictionDuctResult {
  /** Rect width (m) — equal to height for round. */
  thickness: number;
  /** Rect height (m) — equal to thickness for round. */
  height: number;
  /** True when the selected cross-section is round. */
  round: boolean;
  velocity: number;
  area: number;
  /** Specific friction rate (Pa/m) at the design flow. */
  frictionRatePaM: number;
  rule: string;
  warnings: string[];
}

interface DuctCandidate {
  w: number; h: number; round: boolean; area: number;
  velocity: number; rate: number;
}

function ductRate(
  flow: number, w: number, h: number, eps: number, rho: number, mu: number,
): DuctCandidate {
  const area = w * h;
  const velocity = flow / area;
  const dh = (2 * w * h) / (w + h);
  const re = (rho * velocity * dh) / mu;
  const f = colebrook(re, eps / dh);
  const vHead = (rho * velocity * velocity) / 2;
  return { w, h, round: false, area, velocity, rate: (f / dh) * vHead };
}

function roundRate(
  flow: number, d: number, eps: number, rho: number, mu: number,
): DuctCandidate {
  const area = (Math.PI * d * d) / 4;
  const velocity = flow / area;
  const re = (rho * velocity * d) / mu;
  const f = colebrook(re, eps / d);
  const vHead = (rho * velocity * velocity) / 2;
  return { w: d, h: d, round: true, area, velocity, rate: (f / d) * vHead };
}

function finishDuctPick(
  best: DuctCandidate, flow: number, target: number, maxVelocity: number,
): FrictionDuctResult {
  const warnings: string[] = [];
  const sizeLabel = best.round
    ? `⌀ ${(best.w * 1000).toFixed(0)} mm`
    : `${(best.w * 1000).toFixed(0)}×${(best.h * 1000).toFixed(0)} mm`;
  if (best.rate > target) {
    warnings.push(
      `Smallest rate available is ${best.rate.toFixed(3)} Pa/m — above the ${target} Pa/m target even at the largest standard size.`,
    );
  }
  if (best.velocity > maxVelocity) {
    warnings.push(`Velocity ${best.velocity.toFixed(2)} m/s exceeds the ${maxVelocity} m/s cap.`);
  }
  return {
    thickness: best.round ? best.w : best.w,
    height: best.round ? best.w : best.h,
    round: best.round,
    velocity: best.velocity,
    area: best.area,
    frictionRatePaM: best.rate,
    rule: `friction method: ${sizeLabel}, ${best.rate.toFixed(3)} Pa/m ≤ ${target} Pa/m target, velocity ${best.velocity.toFixed(2)} m/s @ ${(flow).toFixed(3)} m³/s`,
    warnings,
  };
}

/**
 * Size a rectangular duct so its friction rate stays at or below
 * `targetFrictionPaM` at the design flow. Picks the smallest standard
 * W×H whose rate qualifies, preferring aspect ratios 1:1 → 4:1.
 */
export function sizeRectDuctByFriction(
  flowM3s: number,
  targetFrictionPaM = 0.8,
  opts: {
    material?: RoughnessMaterial;
    roughness?: number;
    densityKgM3?: number;
    viscosityPaS?: number;
    maxVelocity?: number;
  } = {},
): FrictionDuctResult {
  if (!(flowM3s > 0)) throw new Error("flowM3s must be positive");
  if (!(targetFrictionPaM > 0)) throw new Error("targetFrictionPaM must be positive");
  const eps = opts.roughness ?? ROUGHNESS[opts.material ?? "galvanized-steel"];
  const rho = opts.densityKgM3 ?? FLUID.air.rho;
  const mu = opts.viscosityPaS ?? FLUID.air.mu;
  const maxV = opts.maxVelocity ?? 6;

  let best: DuctCandidate | null = null;
  for (const ar of [1, 2, 3, 4]) {
    for (const w of DUCT_WIDTHS) {
      const h = DUCT_HEIGHTS.find((hh) => hh >= w / ar) ?? w / ar;
      const c = ductRate(flowM3s, w, h, eps, rho, mu);
      if (c.rate <= targetFrictionPaM && c.velocity <= maxV) {
        if (best === null || c.area < best.area) best = c;
        break; // smallest qualifying width for this aspect ratio
      }
    }
  }
  if (!best) {
    // Fall back to the candidate with the lowest rate overall.
    for (const w of DUCT_WIDTHS) {
      for (const h of DUCT_HEIGHTS) {
        const c = ductRate(flowM3s, w, h, eps, rho, mu);
        if (best === null || c.rate < best.rate) best = c;
      }
    }
  }
  return finishDuctPick(best!, flowM3s, targetFrictionPaM, maxV);
}

/** Size a round duct by friction rate. */
export function sizeRoundDuctByFriction(
  flowM3s: number,
  targetFrictionPaM = 0.8,
  opts: Parameters<typeof sizeRectDuctByFriction>[2] = {},
): FrictionDuctResult {
  if (!(flowM3s > 0)) throw new Error("flowM3s must be positive");
  const eps = opts.roughness ?? ROUGHNESS[opts.material ?? "galvanized-steel"];
  const rho = opts.densityKgM3 ?? FLUID.air.rho;
  const mu = opts.viscosityPaS ?? FLUID.air.mu;
  const maxV = opts.maxVelocity ?? 6;

  let best: DuctCandidate | null = null;
  for (const d of ROUND_DUCT_DN) {
    const c = roundRate(flowM3s, d, eps, rho, mu);
    if (c.rate <= targetFrictionPaM && c.velocity <= maxV) { best = c; break; }
  }
  if (!best) {
    for (const d of ROUND_DUCT_DN) {
      const c = roundRate(flowM3s, d, eps, rho, mu);
      if (best === null || c.rate < best.rate) best = c;
    }
  }
  return finishDuctPick(best!, flowM3s, targetFrictionPaM, maxV);
}

export interface FrictionPipeResult {
  /** Nominal diameter (m). */
  diameter: number;
  velocity: number;
  /** Specific friction rate (Pa/m). */
  frictionRatePaM: number;
  /** Head loss per 100 m of pipe (m of fluid). */
  headLossPer100m: number;
  rule: string;
  warnings: string[];
}

/**
 * Size a circular pipe so its friction rate stays at or below
 * `targetFrictionPaM` (water systems commonly 100–400 Pa/m).
 */
export function sizePipeByFriction(
  flowLs: number,
  targetFrictionPaM = 150,
  opts: {
    material?: RoughnessMaterial;
    roughness?: number;
    densityKgM3?: number;
    viscosityPaS?: number;
    maxVelocity?: number;
  } = {},
): FrictionPipeResult {
  if (!(flowLs > 0)) throw new Error("flowLs must be positive");
  if (!(targetFrictionPaM > 0)) throw new Error("targetFrictionPaM must be positive");
  const flowM3s = flowLs / 1000;
  const eps = opts.roughness ?? ROUGHNESS[opts.material ?? "steel-pipe"];
  const rho = opts.densityKgM3 ?? FLUID.water.rho;
  const mu = opts.viscosityPaS ?? FLUID.water.mu;
  const maxV = opts.maxVelocity ?? 2.5;

  let best: { d: number; velocity: number; rate: number } | null = null;
  for (const d of PIPE_DN) {
    const area = (Math.PI * d * d) / 4;
    const velocity = flowM3s / area;
    const re = (rho * velocity * d) / mu;
    const f = colebrook(re, eps / d);
    const rate = (f / d) * ((rho * velocity * velocity) / 2);
    if (rate <= targetFrictionPaM && velocity <= maxV) { best = { d, velocity, rate }; break; }
  }
  const warnings: string[] = [];
  if (!best) {
    for (const d of PIPE_DN) {
      const area = (Math.PI * d * d) / 4;
      const velocity = flowM3s / area;
      const re = (rho * velocity * d) / mu;
      const f = colebrook(re, eps / d);
      const rate = (f / d) * ((rho * velocity * velocity) / 2);
      if (best === null || rate < best.rate) best = { d, velocity, rate };
    }
    warnings.push(
      `Lowest achievable rate is ${best!.rate.toFixed(1)} Pa/m — above the ${targetFrictionPaM} Pa/m target even at the largest standard DN.`,
    );
  }
  const headLossPer100m = (best!.rate * 100) / (rho * 9.80665);
  return {
    diameter: best!.d,
    velocity: best!.velocity,
    frictionRatePaM: best!.rate,
    headLossPer100m,
    rule: `friction method: DN ${(best!.d * 1000).toFixed(0)} mm, ${best!.rate.toFixed(1)} Pa/m ≤ ${targetFrictionPaM} Pa/m target, velocity ${best!.velocity.toFixed(2)} m/s @ ${flowLs.toFixed(2)} L/s`,
    warnings,
  };
}

// ── Static regain (duct mains) ──────────────────────────────────────────────

export interface RegainSectionSpec {
  /** Design flow through this main section (m³/s). */
  flowM3s: number;
  /** Section length (m). */
  lengthM: number;
}

export interface RegainSectionResult {
  thickness: number;
  height: number;
  velocity: number;
  /** Velocity head at this section (Pa). */
  velocityHeadPa: number;
  /** Friction loss along this section (Pa). */
  frictionLossPa: number;
  /** Velocity-head regain available at this section's junction (Pa). */
  regainAvailablePa: number;
  sizedBy: "initial-friction" | "regain" | "held";
  warnings: string[];
}

/**
 * Classic static-regain sizing of a duct main.
 *
 * Section 0 is sized by the friction method (`targetFrictionPaM`).
 * Each following section is sized down only while the regain of velocity
 * head (previous velocity head − this section's velocity head) covers the
 * section's friction loss times `regainFactor`. Sections that cannot pay
 * for their friction from regain keep the previous size (`held`).
 */
export function staticRegainSeries(
  sections: RegainSectionSpec[],
  opts: {
    targetFrictionPaM?: number;
    material?: RoughnessMaterial;
    roughness?: number;
    densityKgM3?: number;
    viscosityPaS?: number;
    /** Fraction of the velocity-head drop credited as regain (≤ 1). Default 1. */
    regainFactor?: number;
    maxVelocity?: number;
  } = {},
): RegainSectionResult[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("sections must be a non-empty array");
  }
  for (const s of sections) {
    if (!(s.flowM3s > 0) || !(s.lengthM >= 0)) {
      throw new Error("every section needs a positive flow and a non-negative length");
    }
  }
  const eps = opts.roughness ?? ROUGHNESS[opts.material ?? "galvanized-steel"];
  const rho = opts.densityKgM3 ?? FLUID.air.rho;
  const mu = opts.viscosityPaS ?? FLUID.air.mu;
  const target = opts.targetFrictionPaM ?? 0.8;
  const regainFactor = Math.min(1, Math.max(0, opts.regainFactor ?? 1));
  const maxV = opts.maxVelocity ?? 6;

  const first = sizeRectDuctByFriction(sections[0].flowM3s, target, { roughness: eps, densityKgM3: rho, viscosityPaS: mu, maxVelocity: maxV });
  let prevW = first.thickness;
  let prevH = first.height;
  let prevCandidate = ductRate(sections[0].flowM3s, prevW, prevH, eps, rho, mu);

  const results: RegainSectionResult[] = [{
    thickness: prevW,
    height: prevH,
    velocity: prevCandidate.velocity,
    velocityHeadPa: (rho * prevCandidate.velocity * prevCandidate.velocity) / 2,
    frictionLossPa: prevCandidate.rate * sections[0].lengthM,
    regainAvailablePa: 0,
    sizedBy: "initial-friction",
    warnings: [...first.warnings],
  }];

  for (let i = 1; i < sections.length; i++) {
    const spec = sections[i];
    const warnings: string[] = [];
    const prevHead = (rho * prevCandidate.velocity * prevCandidate.velocity) / 2;
    // Candidates: non-larger cross-sections. Static regain wants the most
    // aggressive downsize that still pays its own way: as the area shrinks
    // the section runs faster, the regain shrinks and the friction grows —
    // so the satisfying set is "area ≥ A*" and we scan ascending, taking
    // the first (smallest) area whose regain covers its friction.
    const candidates = DUCT_WIDTHS
      .flatMap((w) => DUCT_HEIGHTS.map((h) => ({ w, h })))
      .filter(({ w, h }) => w * h <= prevCandidate.area + 1e-12)
      .sort((a, b) => a.w * a.h - b.w * b.h);

    let chosen: DuctCandidate | null = null;
    let sizedBy: RegainSectionResult["sizedBy"] = "held";
    if (spec.lengthM === 0) {
      // No friction to pay for — a downsize would be free regain with no cause.
      chosen = prevCandidate;
    } else {
      for (const { w, h } of candidates) {
        const c = ductRate(spec.flowM3s, w, h, eps, rho, mu);
        if (c.velocity > maxV) continue;
        const head = (rho * c.velocity * c.velocity) / 2;
        const regain = prevHead - head;
        const needed = c.rate * spec.lengthM * regainFactor;
        if (regain >= needed) {
          chosen = c;
          sizedBy = w === prevW && h === prevH ? "held" : "regain";
          break;
        }
      }
    }
    if (!chosen) {
      chosen = prevCandidate;
      warnings.push("Regain could not cover the section friction — size held at the previous section.");
    }
    results.push({
      thickness: chosen.w,
      height: chosen.h,
      velocity: chosen.velocity,
      velocityHeadPa: (rho * chosen.velocity * chosen.velocity) / 2,
      frictionLossPa: chosen.rate * spec.lengthM,
      regainAvailablePa: Math.max(0, prevHead - (rho * chosen.velocity * chosen.velocity) / 2),
      sizedBy,
      warnings,
    });
    prevW = chosen.w;
    prevH = chosen.h;
    prevCandidate = chosen;
  }
  return results;
}

/** Dispatch friction sizing by MEP system (air → duct, water → pipe). */
export function sizeByFriction(
  system: MepSystem,
  flow: number,
  targetFrictionPaM?: number,
): { kind: "duct"; result: FrictionDuctResult } | { kind: "pipe"; result: FrictionPipeResult } {
  if (system === "supply-air" || system === "return-air" ||
      system === "exhaust-air" || system === "outside-air") {
    return { kind: "duct", result: sizeRectDuctByFriction(flow, targetFrictionPaM ?? 0.8) };
  }
  return { kind: "pipe", result: sizePipeByFriction(flow, targetFrictionPaM ?? 150) };
}
