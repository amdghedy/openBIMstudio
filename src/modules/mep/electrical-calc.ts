/**
 * Electrical quick engineering — voltage drop, conductor selection, checks.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Complements src/modules/mep/electrical.ts (panels/circuits schedules).
 *
 * Method:
 *   - Conductor DC resistance per IEC 60228 at 20 °C, corrected to the
 *     operating temperature with the temperature coefficient of copper
 *     (α ≈ 0.00393 /K; aluminium ≈ 0.00403 /K).
 *   - Voltage drop for single-phase uses the full loop (2·L); for
 *     three-phase the line-to-neutral path uses √3·L, and the load's power
 *     factor weighs resistance and reactance: ΔV = I·k·(R'·cosφ + X'·sinφ).
 *   - Ampacity reference: IEC 60364-5-52 Table B.52.4, method C (clipped
 *     direct), PVC insulation, two loaded conductors, 30 °C ambient — a
 *     typical reference that must be re-checked against the actual
 *     installation method and any derating.
 *
 * All results are checking aids; the governing installation code wins.
 */

/** IEC 60228 DC resistance of copper conductors (Ω/km at 20 °C). */
export const CU_RESISTANCE_OHM_KM: Record<string, number> = {
  "1.5": 12.1, "2.5": 7.41, "4": 4.61, "6": 3.08, "10": 1.83,
  "16": 1.15, "25": 0.727, "35": 0.524, "50": 0.387, "70": 0.268,
  "95": 0.193, "120": 0.153, "150": 0.124, "185": 0.0991, "240": 0.0754,
};

/** Aluminium resistivity factor vs copper for the same cross-section. */
export const AL_RESISTANCE_FACTOR = 1.64;

/** Temperature coefficient of resistance (per K). */
export const ALPHA_CU = 0.00393;
export const ALPHA_AL = 0.00403;

/**
 * Reference ampacity (A) — Cu, PVC insulated, method C (clipped direct),
 * two loaded conductors, 30 °C ambient (IEC 60364-5-52 B.52.4 style).
 */
export const AMPACITY_CU_PVC_C: Record<string, number> = {
  "1.5": 17.5, "2.5": 24, "4": 32, "6": 41, "10": 57, "16": 76,
  "25": 101, "35": 125, "50": 153, "70": 196, "95": 238, "120": 276,
  "150": 319, "185": 364, "240": 430,
};

/** Conductor sizes (mm^2) in ascending order. */
export const CONDUCTOR_SIZES = Object.keys(CU_RESISTANCE_OHM_KM)
  .map(Number)
  .sort((a, b) => a - b);

export type ConductorMaterial = "cu" | "al";

/** Resistance of one conductor at operating temperature (Ω/km). */
export function conductorResistanceOhmKm(
  sizeMm2: number,
  material: ConductorMaterial = "cu",
  operatingTempC: number = 70,
): number {
  const key = String(sizeMm2);
  const cu20 = CU_RESISTANCE_OHM_KM[key];
  if (cu20 == null) return 0;
  const alpha = material === "al" ? ALPHA_AL : ALPHA_CU;
  const r = cu20 * (1 + alpha * (operatingTempC - 20));
  return material === "al" ? r * AL_RESISTANCE_FACTOR : r;
}

export interface VoltageDropInput {
  /** 1 = single-phase (2·L loop), 3 = three-phase (√3·L). */
  phase: 1 | 3;
  /** System voltage (V): line-to-line for both cases as commonly quoted. */
  voltageV: number;
  /** Design current (A). */
  currentA: number;
  /** One-way route length (m). */
  lengthM: number;
  /** Conductor cross-section (mm^2). */
  conductorMm2: number;
  /** Power factor 0..1 (default 1 — resistive). */
  powerFactor?: number;
  /** Conductor material (default cu). */
  material?: ConductorMaterial;
  /** Conductor operating temperature (°C, default 70). */
  operatingTempC?: number;
  /** Line reactance (Ω/km). Default 0.08 for multicore cables. */
  reactanceOhmKm?: number;
}

export interface VoltageDropResult {
  /** Voltage drop magnitude (V). */
  dropV: number;
  /** Drop as a percentage of the system voltage. */
  dropPercent: number;
  /** Resistance term (Ω). */
  resistanceOhm: number;
  /** Reactance term (Ω). */
  reactanceOhm: number;
  /** Distance factor used: 2 (1φ) or √3 (3φ). */
  pathFactor: number;
}

/**
 * Voltage drop of a feeder. Accepts the actual load current; percent drop
 * is referenced to the given system voltage.
 */
export function voltageDrop(input: VoltageDropInput): VoltageDropResult {
  const pf = input.powerFactor == null ? 1 : Math.min(1, Math.max(0, input.powerFactor));
  const sinPhi = Math.sqrt(Math.max(0, 1 - pf * pf));
  const rOhmKm = conductorResistanceOhmKm(
    input.conductorMm2, input.material ?? "cu", input.operatingTempC ?? 70,
  );
  const xOhmKm = input.reactanceOhmKm ?? 0.08;
  const k = input.phase === 1 ? 2 : Math.sqrt(3);
  const km = input.lengthM / 1000;
  const resistanceOhm = k * km * rOhmKm;
  const reactanceOhm = k * km * xOhmKm;
  const dropV = input.currentA * (resistanceOhm * pf + reactanceOhm * sinPhi);
  return {
    dropV,
    dropPercent: input.voltageV > 0 ? (dropV / input.voltageV) * 100 : 0,
    resistanceOhm,
    reactanceOhm,
    pathFactor: k,
  };
}

/**
 * Maximum one-way length (m) for a permitted voltage-drop percentage.
 * Same model as `voltageDrop`; inverts the equation analytically.
 */
export function maxCableLengthForDrop(input: {
  phase: 1 | 3;
  voltageV: number;
  currentA: number;
  conductorMm2: number;
  maxDropPercent: number;
  powerFactor?: number;
  material?: ConductorMaterial;
  operatingTempC?: number;
  reactanceOhmKm?: number;
}): number {
  const pf = input.powerFactor == null ? 1 : Math.min(1, Math.max(0, input.powerFactor));
  const sinPhi = Math.sqrt(Math.max(0, 1 - pf * pf));
  const rOhmKm = conductorResistanceOhmKm(
    input.conductorMm2, input.material ?? "cu", input.operatingTempC ?? 70,
  );
  const xOhmKm = input.reactanceOhmKm ?? 0.08;
  const k = input.phase === 1 ? 2 : Math.sqrt(3);
  const allowedV = (input.maxDropPercent / 100) * input.voltageV;
  const perAmpPerKm = k * (rOhmKm * pf + xOhmKm * sinPhi);
  if (perAmpPerKm <= 0 || input.currentA <= 0) return 0;
  return (allowedV / (input.currentA * perAmpPerKm)) * 1000;
}

/**
 * Smallest standard conductor whose reference ampacity covers the design
 * current. Returns 0 when nothing in the table fits.
 */
export function selectConductor(
  designCurrentA: number,
  material: ConductorMaterial = "cu",
): { mm2: number; ampacityA: number } | null {
  // Reference table is for copper; aluminium is derated ~0.78 from copper.
  const needed = material === "al" ? designCurrentA / 0.78 : designCurrentA;
  for (const size of CONDUCTOR_SIZES) {
    const iz = AMPACITY_CU_PVC_C[String(size)];
    if (iz != null && iz >= needed) return { mm2: size, ampacityA: iz };
  }
  return null;
}

export interface ConductorCheckInput {
  /** Actual design current of the circuit (A). */
  designCurrentA: number;
  /** Protective device rating (A). */
  breakerRatingA: number;
  /** Selected conductor size (mm^2). */
  conductorMm2: number;
  /** Permitted voltage drop (%). Default 3 for feeders, 5 total per IEC practice. */
  maxDropPercent?: number;
  /** Circuit length (m) for the drop advisory. */
  lengthM?: number;
  /** System voltage (V) for the drop advisory. */
  voltageV?: number;
  /** Phase for the drop advisory. */
  phase?: 1 | 3;
  /** Power factor for the drop advisory (default 1 — resistive). */
  powerFactor?: number;
  material?: ConductorMaterial;
}

export interface ConductorCheckResult {
  ok: boolean;
  /** Human-readable findings; empty when everything passes. */
  findings: string[];
  /** Voltage drop percent when length was supplied (else null). */
  dropPercent: number | null;
}

/**
 * Classic overcurrent coordination check (IEC 60364-4-43 style):
 *   Ib ≤ In ≤ Iz   (design current ≤ breaker rating ≤ cable ampacity)
 * plus an optional voltage-drop advisory.
 */
export function conductorCheck(input: ConductorCheckInput): ConductorCheckResult {
  const findings: string[] = [];
  const iz = AMPACITY_CU_PVC_C[String(input.conductorMm2)] ?? 0;
  if (iz === 0) findings.push(`Unknown conductor size ${input.conductorMm2} mm^2.`);
  if (input.designCurrentA > input.breakerRatingA) {
    findings.push(
      `Design current ${input.designCurrentA} A exceeds the ${input.breakerRatingA} A breaker — upsize the breaker or trim the load.`,
    );
  }
  if (iz > 0 && input.breakerRatingA > iz) {
    findings.push(
      `Breaker ${input.breakerRatingA} A exceeds conductor ampacity ${iz} A (${input.conductorMm2} mm^2) — In ≤ Iz violated.`,
    );
  }
  if (iz > 0 && input.designCurrentA > iz) {
    findings.push(
      `Design current ${input.designCurrentA} A exceeds conductor ampacity ${iz} A — upsize the cable.`,
    );
  }

  let dropPercent: number | null = null;
  if (input.lengthM != null && input.voltageV != null && input.voltageV > 0) {
    const vd = voltageDrop({
      phase: input.phase ?? 3,
      voltageV: input.voltageV,
      currentA: input.designCurrentA,
      lengthM: input.lengthM,
      conductorMm2: input.conductorMm2,
      powerFactor: input.powerFactor,
      material: input.material ?? "cu",
    });
    dropPercent = vd.dropPercent;
    const limit = input.maxDropPercent ?? 3;
    if (vd.dropPercent > limit) {
      findings.push(
        `Voltage drop ${vd.dropPercent.toFixed(2)}% exceeds the ${limit}% limit — upsize or shorten the run.`,
      );
    }
  }

  return { ok: findings.length === 0, findings, dropPercent };
}
