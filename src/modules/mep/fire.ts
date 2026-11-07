/**
 * Fire sprinkler hydraulics — head flow, density/area design and checks.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Physics and practice:
 *   - Head discharge follows the K-factor law Q = K·sqrt(P), with Q in
 *     L/min and P in bar for metric K-factors (K80 ≈ imperial K5.6,
 *     K115 ≈ K8.0, K135 ≈ K10.0 ...).
 *   - Density/area design (NFPA 13 style): the remote-area demand is the
 *     design density times the design area; the most remote head must
 *     deliver at least density × its coverage area, which fixes the
 *     minimum end-head pressure via the K-factor law.
 *   - Pipe velocity practice keeps below ~6.1 m/s (20 ft/s) to limit
 *     friction and permission of CPVC/polybutylene listings.
 *
 * Values are design aids, not a code substitute — the AHJ and the listed
 * design criteria govern the final calculation.
 */

/** Discharge of a sprinkler head (L/min) from metric K-factor and pressure (bar). */
export function headFlowLmin(kFactor: number, pressureBar: number): number {
  if (kFactor <= 0 || pressureBar < 0) return 0;
  return kFactor * Math.sqrt(pressureBar);
}

/** Minimum pressure (bar) for a head to discharge the required flow. */
export function minHeadPressureBar(kFactor: number, flowLmin: number): number {
  if (kFactor <= 0 || flowLmin < 0) return 0;
  return Math.pow(flowLmin / kFactor, 2);
}

/** Flow (L/min) implied by a design density over a coverage area. */
export function densityFlowLmin(densityLminPerM2: number, coverageAreaM2: number): number {
  if (densityLminPerM2 < 0 || coverageAreaM2 < 0) return 0;
  return densityLminPerM2 * coverageAreaM2;
}

/**
 * Minimum end-head pressure (bar) to achieve a design density over the
 * head's coverage area — the anchor point of every hydraulic calculation.
 */
export function headPressureForDensity(
  kFactor: number,
  densityLminPerM2: number,
  coverageAreaM2: number,
): number {
  return minHeadPressureBar(kFactor, densityFlowLmin(densityLminPerM2, coverageAreaM2));
}

/** Typical NFPA 13 occupancy hazard presets (design aids, not criteria). */
export interface HazardPreset {
  id: string;
  label: string;
  /** Design density (L/min/m^2). */
  densityLminM2: number;
  /** Max coverage per standard-spray head (m^2). */
  maxCoverageM2: number;
  /** Inside + outside hose stream allowance (L/min). */
  hoseAllowanceLmin: number;
  /** Water supply duration (minutes). */
  durationMin: number;
}

export const HAZARD_PRESETS: HazardPreset[] = [
  { id: "light", label: "Light hazard (office, school, hotel)", densityLminM2: 4.1, maxCoverageM2: 20.9, hoseAllowanceLmin: 378, durationMin: 30 },
  { id: "ordinary-1", label: "Ordinary hazard group 1", densityLminM2: 6.1, maxCoverageM2: 12.1, hoseAllowanceLmin: 946, durationMin: 60 },
  { id: "ordinary-2", label: "Ordinary hazard group 2", densityLminM2: 8.1, maxCoverageM2: 12.1, hoseAllowanceLmin: 946, durationMin: 60 },
  { id: "extra-1", label: "Extra hazard group 1", densityLminM2: 12.2, maxCoverageM2: 9.3, hoseAllowanceLmin: 1893, durationMin: 90 },
  { id: "extra-2", label: "Extra hazard group 2", densityLminM2: 16.3, maxCoverageM2: 9.3, hoseAllowanceLmin: 1893, durationMin: 90 },
];

/** Look up a hazard preset by id (case-insensitive, prefix match allowed). */
export function hazardPreset(id: string): HazardPreset | null {
  const k = id.trim().toLowerCase();
  return HAZARD_PRESETS.find((h) => h.id === k) ?? null;
}

export interface DesignDemandInput {
  /** Hazard preset id (see HAZARD_PRESETS) or blank for fully custom values. */
  hazardId?: string;
  /** Custom design density (L/min/m^2) when hazardId is omitted. */
  densityLminM2?: number;
  /** Remote-area design area (m^2). Typical: 139 m^2 (1500 ft^2) with reductions. */
  designAreaM2: number;
  /** Coverage area per head (m^2). Must not exceed the preset maximum. */
  headCoverageM2: number;
  /** Metric K-factor of the selected head (e.g. 80, 115, 135). */
  kFactor: number;
  /** Number of heads assumed flowing in the remote area (0 = area/coverage). */
  headCount?: number;
}

export interface DesignDemandResult {
  densityLminM2: number;
  designAreaM2: number;
  headCoverageM2: number;
  headCount: number;
  /** Minimum flow of the most remote head (L/min). */
  endHeadFlowLmin: number;
  /** Minimum end-head pressure (bar). */
  endHeadPressureBar: number;
  /** Sprinkler demand over the remote area (L/min). */
  sprinklerDemandLmin: number;
  /** Hose stream allowance (L/min). */
  hoseAllowanceLmin: number;
  /** Total water supply demand (L/min). */
  totalDemandLmin: number;
  /** Required supply duration (minutes). */
  durationMin: number;
  /** Non-fatal design warnings. */
  warnings: string[];
}

/** Full density/area design demand for a sprinkler system. */
export function designDemand(input: DesignDemandInput): DesignDemandResult {
  const preset = input.hazardId ? hazardPreset(input.hazardId) : null;
  const density = preset ? preset.densityLminM2 : (input.densityLminM2 ?? 0);
  const warnings: string[] = [];
  if (density <= 0) warnings.push("No design density — pass hazardId or densityLminM2.");

  const coverage = input.headCoverageM2;
  if (preset && coverage > preset.maxCoverageM2 + 1e-9) {
    warnings.push(
      `Head coverage ${coverage.toFixed(1)} m^2 exceeds the ${preset.maxCoverageM2} m^2 maximum for ${preset.id}.`,
    );
  }

  const headCount = input.headCount && input.headCount > 0
    ? input.headCount
    : Math.max(1, Math.ceil(input.designAreaM2 / Math.max(coverage, 0.01)));

  const endHeadFlow = densityFlowLmin(density, coverage);
  const endHeadPressure = minHeadPressureBar(input.kFactor, endHeadFlow);
  const sprinklerDemand = endHeadFlow * headCount;
  const hose = preset ? preset.hoseAllowanceLmin : 0;
  const duration = preset ? preset.durationMin : 30;

  if (endHeadPressure < 0.35) {
    warnings.push(
      `End-head pressure ${endHeadPressure.toFixed(2)} bar is below the usual 0.35 bar (5 psi) minimum — check head spacing or K-factor.`,
    );
  }

  return {
    densityLminM2: density,
    designAreaM2: input.designAreaM2,
    headCoverageM2: coverage,
    headCount,
    endHeadFlowLmin: endHeadFlow,
    endHeadPressureBar: endHeadPressure,
    sprinklerDemandLmin: sprinklerDemand,
    hoseAllowanceLmin: hose,
    totalDemandLmin: sprinklerDemand + hose,
    durationMin: duration,
    warnings,
  };
}

/** Practical pipe velocity limit for sprinkler piping (m/s). */
export const SPRINKLER_MAX_VELOCITY_MS = 6.1;

/** Velocity check for a sprinkler branch/main carrying a known flow. */
export function pipeVelocityCheck(
  flowLmin: number,
  innerDiameterM: number,
): { velocityMs: number; ok: boolean; limitMs: number; message: string } {
  const area = Math.PI * innerDiameterM * innerDiameterM / 4;
  const v = area > 0 ? (flowLmin / 60000) / area : 0;
  const ok = v <= SPRINKLER_MAX_VELOCITY_MS + 1e-9;
  return {
    velocityMs: v,
    ok,
    limitMs: SPRINKLER_MAX_VELOCITY_MS,
    message: ok
      ? `Velocity ${v.toFixed(2)} m/s is within the ${SPRINKLER_MAX_VELOCITY_MS} m/s practice limit.`
      : `Velocity ${v.toFixed(2)} m/s exceeds the ${SPRINKLER_MAX_VELOCITY_MS} m/s practice limit — upsize the pipe.`,
  };
}

/** Common metric K-factors (L/min/bar^0.5) with their imperial twins. */
export const K_FACTORS: Array<{ k: number; imperial: string; use: string }> = [
  { k: 57, imperial: "K2.8", use: "light hazard, small orifice" },
  { k: 80, imperial: "K5.6", use: "standard light/ordinary hazard" },
  { k: 115, imperial: "K8.0", use: "ordinary hazard, storage" },
  { k: 135, imperial: "K10.0", use: "storage, large drop" },
  { k: 160, imperial: "K11.2", use: "ESFR / storage" },
  { k: 200, imperial: "K14.0", use: "ESFR" },
  { k: 240, imperial: "K16.8", use: "ESFR high" },
  { k: 360, imperial: "K25.2", use: "large-drop / ESFR boost" },
];
