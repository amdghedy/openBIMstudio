/**
 * Code-referenced calculation checks — ONE jurisdiction at a time.
 *
 * Rank 5 scope: the MEP maths is real (Darcy–Weisbach, Colebrook–White)
 * but no calculation was ever checked against a published reference for
 * any jurisdiction — every area was `unit-tested-only`. This module is
 * the first jurisdiction check, stated explicitly:
 *
 *   Jurisdiction: ASHRAE (US) — ASHRAE Handbook—Fundamentals,
 *   Chapter 21 (Duct Design), Fig. 12 friction chart for round
 *   galvanized-steel ducts, standard air.
 *
 * Each check runs the production `ductPressureDrop` (pressure.ts) on a
 * published chart point and reports the deviation from the published
 * value. This is a CHECK against published values, not a compliance
 * claim: reproducing a friction chart does not make a design comply with
 * any adopted code, and no check here says otherwise.
 *
 * Why ±10% on the chart points: the published sources disagree with each
 * other at that level. The ASHRAE chart is a log–log nomogram; the
 * standard power-law fit to it (Δp = 0.109136·Q^1.9/D^5.02, Δp in
 * in. w.g./100 ft, Q in CFM, D in inches) and independent Darcy–Weisbach
 * calculators differ by up to ~8% on the same point, and chart-reading
 * itself carries ~8% error (see the Ductulator worked example below).
 * A tighter band would be pretending the chart is more precise than it
 * is. The hand-worked case (Altshul–Tsal, fully shown arithmetic) is
 * held to ±2% because its inputs and method are exact, not chart-read.
 *
 * The chart is plotted for galvanized steel at ε = 0.09 mm — NOT the
 * 0.15 mm the module's own `galvanized-steel` roughness table carries.
 * The checks therefore pass explicit roughness 0.00009 m and say so; the
 * table value is a separate (flagged) discrepancy, not silently changed
 * here.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

import { ductPressureDrop } from "./pressure";

/** The single jurisdiction this module checks. Add a second jurisdiction
 * as a second check function — never by widening this one's claims. */
export const CODE_CHECK_JURISDICTION = "ASHRAE (US)";

export const ASHRAE_DUCT_FRICTION_REFERENCE =
  "ASHRAE Handbook—Fundamentals, Chapter 21 (Duct Design), Fig. 12 — friction chart for round galvanized-steel ducts, standard air";

export interface CodeReferenceCheck {
  /** Stable id, e.g. "ashrae-duct-friction-1". */
  id: string;
  jurisdiction: string;
  /** The published reference this check reproduces. */
  reference: string;
  /** What the case is, in words. */
  description: string;
  /** Inputs fed to the production calc (SI). */
  inputs: { flowM3PerS: number; diameterM: number; roughnessM: number; lengthM: number };
  /** Production result. */
  computed: {
    frictionRatePaPerM: number;
    frictionRateInWgPer100Ft: number;
    velocityMPerS: number;
    velocityFpm: number;
    reynolds: number;
    frictionFactor: number;
    totalDropPa: number;
  };
  /** Published value the check reproduces. */
  referenceValue: number;
  /** Unit of `referenceValue` (and of `computed`'s matching field). */
  referenceUnit: "Pa/m" | "in. w.g./100 ft";
  /** (computed − reference) / reference, in percent. */
  deviationPct: number;
  /** Pass band, in percent (see the module header for why it is ±10%). */
  tolerancePct: number;
  passed: boolean;
}

/** 1 in. w.g. per 100 ft, expressed as Pa/m. */
export const PA_PER_M_PER_INWG_PER_100FT = 249.0889 / 30.48;

const CFM_TO_M3_PER_S = 0.00047194745;
const IN_TO_M = 0.0254;
const M_PER_S_TO_FPM = 1 / 0.00508;

/** Galvanized-steel roughness the ASHRAE chart is plotted for (0.09 mm). */
export const ASHRAE_CHART_ROUGHNESS_M = 0.00009;

interface ChartCase {
  id: string;
  description: string;
  flowM3PerS: number;
  diameterM: number;
  lengthM: number;
  referenceValue: number;
  referenceUnit: "Pa/m" | "in. w.g./100 ft";
  tolerancePct: number;
  /** Published velocity for a secondary cross-check (fpm), when known. */
  velocityFpm?: number;
}

const CHART_CASES: ChartCase[] = [
  {
    id: "ashrae-duct-friction-1",
    description:
      "1,000 CFM in a 13.7-in round galvanized duct at standard air: the ASHRAE friction-chart worked example returns 0.10 in. w.g./100 ft at 983 fpm.",
    flowM3PerS: 1000 * CFM_TO_M3_PER_S,
    diameterM: 13.7 * IN_TO_M,
    lengthM: 1,
    referenceValue: 0.1,
    referenceUnit: "in. w.g./100 ft",
    tolerancePct: 10,
    velocityFpm: 983,
  },
  {
    id: "ashrae-duct-friction-2",
    description:
      "678 CFM in a 12-in round galvanized duct at standard air: the ASHRAE friction chart carries 678 CFM at 0.10 in. w.g./100 ft (863 fpm).",
    flowM3PerS: 678 * CFM_TO_M3_PER_S,
    diameterM: 12 * IN_TO_M,
    lengthM: 1,
    referenceValue: 0.1,
    referenceUnit: "in. w.g./100 ft",
    tolerancePct: 10,
    velocityFpm: 863,
  },
  {
    id: "ashrae-duct-friction-3",
    description:
      "0.5 m³/s in a 300 mm round galvanized spiral duct (ε = 0.09 mm) at 20 °C, sea level: hand-worked Darcy–Weisbach with the Altshul–Tsal friction factor (Re 140,932, f 0.018398) gives 1.848 Pa/m, 37.0 Pa over 20 m.",
    flowM3PerS: 0.5,
    diameterM: 0.3,
    lengthM: 20,
    referenceValue: 1.848,
    referenceUnit: "Pa/m",
    tolerancePct: 2,
  },
];

function runCase(c: ChartCase): CodeReferenceCheck {
  const r = ductPressureDrop({
    length: c.lengthM,
    flow: c.flowM3PerS,
    diameter: c.diameterM,
    roughness: ASHRAE_CHART_ROUGHNESS_M,
  });
  const computedRef =
    c.referenceUnit === "Pa/m"
      ? r.frictionRate
      : r.frictionRate / PA_PER_M_PER_INWG_PER_100FT;
  const deviationPct = ((computedRef - c.referenceValue) / c.referenceValue) * 100;
  return {
    id: c.id,
    jurisdiction: CODE_CHECK_JURISDICTION,
    reference: ASHRAE_DUCT_FRICTION_REFERENCE,
    description: c.description,
    inputs: {
      flowM3PerS: c.flowM3PerS,
      diameterM: c.diameterM,
      roughnessM: ASHRAE_CHART_ROUGHNESS_M,
      lengthM: c.lengthM,
    },
    computed: {
      frictionRatePaPerM: r.frictionRate,
      frictionRateInWgPer100Ft: r.frictionRate / PA_PER_M_PER_INWG_PER_100FT,
      velocityMPerS: r.velocity,
      velocityFpm: r.velocity * M_PER_S_TO_FPM,
      reynolds: r.reynolds,
      frictionFactor: r.frictionFactor,
      totalDropPa: r.dpFriction,
    },
    referenceValue: c.referenceValue,
    referenceUnit: c.referenceUnit,
    deviationPct,
    tolerancePct: c.tolerancePct,
    passed: Math.abs(deviationPct) <= c.tolerancePct,
  };
}

/**
 * Check duct friction against the published ASHRAE chart values
 * (Fundamentals Ch. 21, Fig. 12). One result per published point; every
 * result carries its reference, its deviation and its pass band.
 */
export function checkAshraeDuctFriction(): CodeReferenceCheck[] {
  return CHART_CASES.map(runCase);
}

/** All code-reference checks for every jurisdiction covered so far. */
export function runCodeReferenceChecks(): CodeReferenceCheck[] {
  return [...checkAshraeDuctFriction()];
}
