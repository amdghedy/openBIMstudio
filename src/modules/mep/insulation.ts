/**
 * Thermal insulation for pipes and ducts — heat loss, surface temperature,
 * procurement takeoff and condensation screening.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Models:
 *   - Pipe: radial steady-state conduction through the insulation cylinder
 *     plus convective film at the outer surface.
 *         q' = (Tf - Ta) / ( ln(r2/r1)/(2πk) + 1/(2π·r2·h_out) )
 *   - Duct: flat-wall conduction through the wrap plus the outer film.
 *         U = 1 / ( t/k + 1/h_out ),  q' = U · perimeter · (Ti - Ta)
 *   - Dew point via the Magnus formula, for the "will it sweat?" check.
 */

export interface PipeInsulationInput {
  /** Pipe outer diameter (m). */
  outerDiameterM: number;
  /** Insulation thickness (m). */
  insulationThicknessM: number;
  /** Insulation thermal conductivity (W/m·K). */
  conductivityWmK: number;
  /** Fluid / internal temperature (°C). */
  fluidC: number;
  /** Ambient air temperature (°C). */
  ambientC: number;
  /** Outer surface coefficient (W/m^2·K). Default 9 (still air). */
  outerCoefficientWm2K?: number;
}

export interface PipeInsulationResult {
  /** Heat loss per metre of run (W/m). */
  heatLossWPerM: number;
  /** Outer diameter including insulation (m). */
  insulatedOuterDiameterM: number;
  /** Exposed surface area per metre (m^2/m). */
  surfaceAreaM2PerM: number;
  /** Predicted outer surface temperature (°C). */
  surfaceTempC: number;
}

/** Steady-state heat loss of an insulated pipe (W per metre of run). */
export function insulatePipe(input: PipeInsulationInput): PipeInsulationResult {
  const r1 = input.outerDiameterM / 2;
  const r2 = r1 + Math.max(0, input.insulationThicknessM);
  const k = Math.max(1e-6, input.conductivityWmK);
  const hOut = input.outerCoefficientWm2K ?? 9;

  const rCond = Math.log(r2 / r1) / (2 * Math.PI * k);
  const rConv = r2 > 0 ? 1 / (2 * Math.PI * r2 * hOut) : 0;
  const dT = input.fluidC - input.ambientC;
  const q = dT / (rCond + rConv);
  const surfaceTemp = input.ambientC + q * rConv;

  return {
    heatLossWPerM: q,
    insulatedOuterDiameterM: r2 * 2,
    surfaceAreaM2PerM: 2 * Math.PI * r2,
    surfaceTempC: surfaceTemp,
  };
}

export interface DuctInsulationInput {
  /** Duct width (m). */
  widthM: number;
  /** Duct height (m). */
  heightM: number;
  /** Insulation thickness (m). */
  insulationThicknessM: number;
  /** Insulation thermal conductivity (W/m·K). */
  conductivityWmK: number;
  /** Internal air temperature (°C). */
  internalC: number;
  /** Ambient air temperature (°C). */
  ambientC: number;
  /** Outer surface coefficient (W/m^2·K). Default 8.3. */
  outerCoefficientWm2K?: number;
}

export interface DuctInsulationResult {
  /** Heat loss per metre of run (W/m). */
  heatLossWPerM: number;
  /** U-value of the insulated envelope (W/m^2·K). */
  uValueWm2K: number;
  /** Insulated outer width (m). */
  insulatedWidthM: number;
  /** Insulated outer height (m). */
  insulatedHeightM: number;
  /** Exposed surface area per metre (m^2/m). */
  surfaceAreaM2PerM: number;
  /** Predicted outer surface temperature (°C). */
  surfaceTempC: number;
}

/** Steady-state heat loss of an insulated rectangular duct (W per metre). */
export function insulateDuct(input: DuctInsulationInput): DuctInsulationResult {
  const t = Math.max(0, input.insulationThicknessM);
  const k = Math.max(1e-6, input.conductivityWmK);
  const hOut = input.outerCoefficientWm2K ?? 8.3;

  const u = 1 / (t / k + 1 / hOut);
  const w = input.widthM + 2 * t;
  const h = input.heightM + 2 * t;
  const perimeter = 2 * (w + h);
  const dT = input.internalC - input.ambientC;
  const q = u * perimeter * dT;
  const surfaceTemp = input.ambientC + (dT * (1 / hOut)) / (t / k + 1 / hOut);

  return {
    heatLossWPerM: q,
    uValueWm2K: u,
    insulatedWidthM: w,
    insulatedHeightM: h,
    surfaceAreaM2PerM: perimeter,
    surfaceTempC: surfaceTemp,
  };
}

export interface InsulationTakeoff {
  /** Exposed jacket area for the run (m^2). */
  areaM2: number;
  /** Insulation material volume for the run (m^3). */
  volumeM3: number;
  /** Insulated cross-section perimeter used (m). */
  perimeterM: number;
}

/**
 * Procurement takeoff: jacket area + material volume for a run of
 * `lengthM` metres, given the bare cross-section and insulation thickness.
 */
export function runTakeoff(
  lengthM: number,
  crossSection: { widthM: number; heightM?: number } | { outerDiameterM: number },
  insulationThicknessM: number,
): InsulationTakeoff {
  const t = Math.max(0, insulationThicknessM);
  let perimeterM: number;
  if ("outerDiameterM" in crossSection) {
    perimeterM = Math.PI * (crossSection.outerDiameterM + 2 * t);
  } else {
    perimeterM = 2 * (crossSection.widthM + 2 * t + (crossSection.heightM ?? 0) + 2 * t);
  }
  const areaM2 = perimeterM * lengthM;
  // Volume uses the bare perimeter (mid-plane approximation of the wrap).
  const barePerimeter = "outerDiameterM" in crossSection
    ? Math.PI * crossSection.outerDiameterM
    : 2 * (crossSection.widthM + (crossSection.heightM ?? 0));
  return { areaM2, volumeM3: areaM2 > 0 ? barePerimeter * lengthM * t : 0, perimeterM };
}

/** Dew point (°C) from ambient temperature and relative humidity (%). */
export function dewPointC(ambientC: number, relativeHumidityPercent: number): number {
  const rh = Math.min(100, Math.max(1, relativeHumidityPercent));
  const a = 17.27;
  const b = 237.7;
  const gamma = Math.log(rh / 100) + (a * ambientC) / (b + ambientC);
  return (b * gamma) / (a - gamma);
}

export interface CondensationVerdict {
  risk: boolean;
  dewPointC: number;
  surfaceTempC: number;
  message: string;
}

/** Will an insulated surface running at `surfaceTempC` sweat at this ambient? */
export function condensationRisk(
  surfaceTempC: number,
  ambientC: number,
  relativeHumidityPercent: number,
): CondensationVerdict {
  const td = dewPointC(ambientC, relativeHumidityPercent);
  const risk = surfaceTempC < td;
  return {
    risk,
    dewPointC: td,
    surfaceTempC,
    message: risk
      ? `Surface ${surfaceTempC.toFixed(1)} °C is below the ${td.toFixed(1)} °C dew point — increase insulation thickness (condensation risk).`
      : `Surface ${surfaceTempC.toFixed(1)} °C stays above the ${td.toFixed(1)} °C dew point — no condensation expected.`,
  };
}
