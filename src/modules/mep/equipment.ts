/**
 * Air-side and hydronic equipment duty selection — the numbers RVT's
 * system inspector gives you for fan/pump selection.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Fan duty:
 *   - Fan total pressure = system worst-path total pressure drop + the
 *     discharge velocity head (dynamic pressure at the fan exit), times a
 *     safety factor.
 *   - Fan static pressure = total pressure − exit velocity head.
 *   - Air power = Q · Δp_total. Shaft power = air power / mechanical
 *     efficiency. Motor power = shaft power / motor efficiency, rounded up
 *     to the next standard IEC motor frame rating.
 *
 * Pump duty:
 *   - Duty head = worst-path head loss + static lift + required residual
 *     head at the most remote terminal, times a safety factor.
 *   - Hydraulic power = ρ·g·Q·H. Shaft = hydraulic / pump efficiency.
 *     Motor = shaft / motor efficiency, rounded to the next standard frame.
 *
 * Standard IEC motor ratings: 0.37 ... 250 kW.
 */

/** Standard IEC motor ratings (kW), ascending. */
export const MOTOR_FRAMES_KW = [
  0.37, 0.55, 0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22,
  30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250,
];

/** Next standard motor frame at or above the required power (kW). */
export function nextMotorFrame(requiredKw: number): number {
  for (const f of MOTOR_FRAMES_KW) if (f >= requiredKw - 1e-9) return f;
  return Math.ceil(requiredKw);
}

const G = 9.80665;

export interface FanSelectionInput {
  /** Total pressure drop along the worst system path (Pa). */
  worstPathDpPa: number;
  /** Design airflow through the fan (m³/s). */
  flowM3s: number;
  /** Discharge velocity (m/s) — adds the exit velocity head to the total. */
  exitVelocityMs?: number;
  /** Safety factor on the system drop (default 1.1). */
  safetyFactor?: number;
  /** Fan mechanical (total) efficiency 0..1 (default 0.65). */
  mechanicalEfficiency?: number;
  /** Motor efficiency 0..1 (default 0.92). */
  motorEfficiency?: number;
  /** Air density (kg/m³, default 1.204). */
  densityKgM3?: number;
}

export interface FanSelectionResult {
  /** Required fan total pressure (Pa). */
  fanTotalPressurePa: number;
  /** Fan static pressure (Pa) — total minus exit velocity head. */
  fanStaticPressurePa: number;
  /** Exit velocity head included in the total (Pa). */
  exitVelocityHeadPa: number;
  /** Air (gas) power (W). */
  airPowerW: number;
  /** Shaft power at the fan (W). */
  shaftPowerW: number;
  /** Motor power draw estimate (W). */
  motorPowerW: number;
  /** Recommended standard motor frame (kW). */
  recommendedMotorKw: number;
  warnings: string[];
}

/** Fan duty from a worst-path pressure drop. */
export function fanSelection(input: FanSelectionInput): FanSelectionResult {
  const safety = input.safetyFactor ?? 1.1;
  const mechEff = input.mechanicalEfficiency ?? 0.65;
  const motorEff = input.motorEfficiency ?? 0.92;
  const rho = input.densityKgM3 ?? 1.204;
  const warnings: string[] = [];
  if (!(input.worstPathDpPa >= 0)) throw new Error("worstPathDpPa must be non-negative");
  if (!(input.flowM3s > 0)) throw new Error("flowM3s must be positive");
  if (!(mechEff > 0 && mechEff <= 1)) throw new Error("mechanicalEfficiency must be in (0, 1]");
  if (!(motorEff > 0 && motorEff <= 1)) throw new Error("motorEfficiency must be in (0, 1]");
  if (mechEff > 0.8) warnings.push("Mechanical efficiency above 0.8 is optimistic for catalogue fans; verify against the fan curve.");

  const exitHead = input.exitVelocityMs != null && input.exitVelocityMs > 0
    ? (rho * input.exitVelocityMs * input.exitVelocityMs) / 2
    : 0;
  const systemDp = input.worstPathDpPa * safety;
  const total = systemDp + exitHead;
  const airPower = input.flowM3s * total;
  const shaft = airPower / mechEff;
  const motor = shaft / motorEff;
  return {
    fanTotalPressurePa: total,
    fanStaticPressurePa: total - exitHead,
    exitVelocityHeadPa: exitHead,
    airPowerW: airPower,
    shaftPowerW: shaft,
    motorPowerW: motor,
    recommendedMotorKw: nextMotorFrame(motor / 1000),
    warnings,
  };
}

export interface PumpSelectionInput {
  /** Worst-path head loss of the distribution circuit (m of fluid). */
  worstPathHeadLossM: number;
  /** Static lift from pump to the most remote terminal (m, positive up). */
  staticLiftM?: number;
  /** Required residual head at the most remote terminal (m, default 0). */
  terminalResidualHeadM?: number;
  /** Design flow (L/s). */
  flowLs: number;
  /** Safety factor on the required head (default 1.1). */
  safetyFactor?: number;
  /** Pump efficiency 0..1 (default 0.7). */
  pumpEfficiency?: number;
  /** Motor efficiency 0..1 (default 0.92). */
  motorEfficiency?: number;
  /** Fluid density (kg/m³, default 998.2 — water 20 °C). */
  densityKgM3?: number;
}

export interface PumpSelectionResult {
  /** Duty head (m of fluid). */
  dutyHeadM: number;
  /** Duty head (kPa). */
  dutyHeadKPa: number;
  /** Duty head (bar). */
  dutyHeadBar: number;
  hydraulicPowerW: number;
  shaftPowerW: number;
  motorPowerW: number;
  recommendedMotorKw: number;
  warnings: string[];
}

/** Pump duty from a worst-path head loss. */
export function pumpSelection(input: PumpSelectionInput): PumpSelectionResult {
  const safety = input.safetyFactor ?? 1.1;
  const eff = input.pumpEfficiency ?? 0.7;
  const motorEff = input.motorEfficiency ?? 0.92;
  const rho = input.densityKgM3 ?? 998.2;
  const warnings: string[] = [];
  if (!(input.worstPathHeadLossM >= 0)) throw new Error("worstPathHeadLossM must be non-negative");
  if (!(input.flowLs > 0)) throw new Error("flowLs must be positive");
  if (!(eff > 0 && eff <= 1)) throw new Error("pumpEfficiency must be in (0, 1]");
  if (!(motorEff > 0 && motorEff <= 1)) throw new Error("motorEfficiency must be in (0, 1]");
  if (eff > 0.85) warnings.push("Pump efficiency above 0.85 is optimistic outside the BEP region; verify against the pump curve.");

  const required =
    input.worstPathHeadLossM +
    (input.staticLiftM ?? 0) +
    (input.terminalResidualHeadM ?? 0);
  const head = required * safety;
  const q = input.flowLs / 1000;
  const hydraulic = rho * G * q * head;
  const shaft = hydraulic / eff;
  const motor = shaft / motorEff;
  return {
    dutyHeadM: head,
    dutyHeadKPa: (head * rho * G) / 1000,
    dutyHeadBar: (head * rho * G) / 1e5,
    hydraulicPowerW: hydraulic,
    shaftPowerW: shaft,
    motorPowerW: motor,
    recommendedMotorKw: nextMotorFrame(motor / 1000),
    warnings,
  };
}
