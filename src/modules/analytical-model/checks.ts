/**
 * Member code checks — preliminary steel and reinforced-concrete checks fed
 * by the 2D frame solver (fem.ts).
 *
 * Scope (deliberately):
 *   - Steel: compact I-shaped sections, fully braced, strong-axis bending
 *     (φMp = 0.9·Fy·Zx), shear (φVn = 1.0·0.6·Fy·Aw), and deflection
 *     limits. No lateral-torsional buckling, no holes, no axial interaction
 *     yet — this is a preliminary sizing tool, not a replacement for a
 *     full design code engine.
 *   - RC: singly reinforced rectangular sections in flexure (ACI-style
 *     rectangular stress block) plus one-way shear with vertical stirrups.
 *
 * Every result carries the assumptions in `notes` so downstream reports can
 * print them next to the numbers.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

import type { SteelSection } from "./sections";

export interface SteelDemand {
  /** Required moment at any point on the member (N·m, sagging magnitude). */
  Mu: number;
  /** Required shear magnitude (N). */
  Vu: number;
  /** Max deflection along the span (m), absolute. */
  deflection: number;
  /** Span length (m). */
  span: number;
}

export interface SteelCheckResult {
  sectionId: string;
  /** Flexural utilization = Mu / φMp. */
  flexUtil: number;
  /** Shear utilization = Vu / φVn. */
  shearUtil: number;
  /** Deflection ratio = δ / δlimit. */
  deflUtil: number;
  /** Governing (max) utilization. */
  utilization: number;
  pass: boolean;
  /** φMp (N·m), φVn (N), δlimit (m) for reports. */
  phiMp: number;
  phiVn: number;
  deflLimit: number;
  notes: string[];
}

export interface SteelCheckOptions {
  /** Deflection limit as span fraction (default L/240). */
  deflSpanFraction?: number;
  /** Flexural resistance factor (default 0.9). */
  phiB?: number;
  /** Shear resistance factor (default 1.0). */
  phiV?: number;
  /** Override yield strength (Pa); default from the catalog entry. */
  Fy?: number;
}

/** Check a steel I-section against bending/shear/deflection demand. */
export function checkSteel(
  section: SteelSection,
  demand: SteelDemand,
  opts: SteelCheckOptions = {},
): SteelCheckResult {
  const notes: string[] = [
    "compact section, fully braced, strong-axis bending",
  ];
  const phiB = opts.phiB ?? 0.9;
  const phiV = opts.phiV ?? 1.0;
  const Fy = opts.Fy ?? section.Fy;

  const Aw = section.d * section.tw;
  const phiMp = phiB * Fy * section.Zx;
  const phiVn = phiV * 0.6 * Fy * Aw;
  const deflLimit = demand.span / (opts.deflSpanFraction ? 1 / opts.deflSpanFraction : 240);

  const flexUtil = demand.Mu / phiMp;
  const shearUtil = demand.Vu / phiVn;
  const deflUtil = demand.deflection / deflLimit;
  const utilization = Math.max(flexUtil, shearUtil, deflUtil);

  if (flexUtil > 1) notes.push("flexural over-stress");
  if (shearUtil > 1) notes.push("shear over-stress");
  if (deflUtil > 1) notes.push("deflection exceeds limit");

  return {
    sectionId: section.id,
    flexUtil,
    shearUtil,
    deflUtil,
    utilization,
    pass: utilization <= 1,
    phiMp,
    phiVn,
    deflLimit,
    notes,
  };
}

export interface RcvSectionInput {
  /** Width (m). */
  b: number;
  /** Overall depth (m). */
  h: number;
  /** Effective depth d = h − cover − stirrup − bar/2 (m). */
  d: number;
  /** Concrete compressive strength (Pa). */
  fc: number;
  /** Steel yield strength (Pa). */
  fy: number;
}

export interface RcCheckResult {
  /** Required tension reinforcement (m²). */
  AsReq: number;
  /** Equivalent stress-block depth (m). */
  a: number;
  /** Design moment capacity with AsReq (N·m). */
  phiMn: number;
  /** Concrete shear capacity φVc (N). */
  phiVc: number;
  /** Required vertical stirrup spacing for the given Vu (m); null if none needed. */
  stirrupSpacing: number | null;
  /** Bending utilization Mu / φMn (≈1 by construction when sizing). */
  flexUtil: number;
  /** Shear utilization Vu / φVc (can exceed 1 — stirrups then required). */
  shearUtil: number;
  pass: boolean;
  notes: string[];
}

export interface RcCheckOptions {
  /** Required shear (N). Default 0. */
  Vu?: number;
  /** Required moment (N·m). Default 0. */
  Mu?: number;
  /** Stirrup bar area (m²), for spacing calc. Default 100 mm² (2 legs of 8 mm). */
  Av?: number;
  /** Flexural resistance factor. Default 0.9. */
  phiB?: number;
  /** Shear resistance factor. Default 0.75. */
  phiV?: number;
}

/**
 * Size flexural reinforcement for a singly reinforced rectangular RC
 * section (ACI 318-style rectangular stress block, SI units) and report
 * the concrete shear capacity plus required stirrup spacing.
 */
export function checkRcBeam(
  input: RcvSectionInput,
  opts: RcCheckOptions = {},
): RcCheckResult {
  const notes: string[] = ["singly reinforced, rectangular stress block"];
  const Mu = opts.Mu ?? 0;
  const Vu = opts.Vu ?? 0;
  const phiB = opts.phiB ?? 0.9;
  const phiV = opts.phiV ?? 0.75;
  const Av = opts.Av ?? 100e-6;

  const { b, d, fc, fy } = input;

  // ρ from Rn: Rn = Mu / (φ b d²); ρ = 0.85fc/fy (1 − √(1 − 2Rn/(0.85fc)))
  const Rn = Mu / (phiB * b * d * d);
  const disc = 1 - (2 * Rn) / (0.85 * fc);
  let AsReq = 0;
  let a = 0;
  if (disc >= 0 && Rn > 0) {
    const rho = ((0.85 * fc) / fy) * (1 - Math.sqrt(disc));
    AsReq = rho * b * d;
    a = (AsReq * fy) / (0.85 * fc * b);
  } else if (Rn > 0) {
    notes.push("section too small for the required moment (no tension-controlled solution)");
  }
  const phiMn = phiB * AsReq * fy * (d - a / 2);

  // Concrete shear: φVc = φ · 0.17 · √f'c(MPa) · b·d  (N, SI)
  const phiVc = phiV * 0.17 * Math.sqrt(fc / 1e6) * 1e6 * b * d;
  const shearUtil = phiVc > 0 ? Vu / phiVc : Infinity;

  // Stirrups: Vu > φVc/2 → need stirrups; s = Av·fy·d / max(Vu − φVc/2, ε)
  let stirrupSpacing: number | null = null;
  if (Vu > phiVc / 2) {
    const demand = Math.max(Vu - phiVc / 2, 1);
    stirrupSpacing = Math.min((Av * fy * d) / demand, d / 2, 0.6);
    notes.push("stirrups required");
  }

  const flexUtil = phiMn > 0 ? Mu / phiMn : Mu > 0 ? Infinity : 0;
  const pass = flexUtil <= 1.001 && shearUtil <= 2 && !(Rn > 0 && AsReq === 0);

  return {
    AsReq,
    a,
    phiMn,
    phiVc,
    stirrupSpacing,
    flexUtil,
    shearUtil,
    pass,
    notes,
  };
}
