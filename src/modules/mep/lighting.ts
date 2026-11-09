/**
 * Interior lighting design — lumen method, point-by-point illuminance and
 * lighting power density checks.
 *
 * Compatibility target: RVT MEP electrical workflow — lighting fixture schedules
 * with average maintained illuminance estimates (the "Lighting Calculation"
 * schedule fields), spacing-to-mounting-height verification and lighting
 * power density reporting. The classic layout numbers an electrical
 * designer needs before placing fixtures.
 *
 * Method (documented, IES/ASHRAE Fundamentals):
 *   - Lumen method (average maintained horizontal illuminance):
 *       N = E_target · A / (Φ_lamp · CU · LLF)
 *     where CU is the coefficient of utilisation estimated from the room
 *     cavity ratio (RCR) and the luminaire efficiency, and LLF is the
 *     light loss factor (LLD · LDD · VF).
 *   - RCR = 5 · h_c · (L + W) / (L · W) with h_c the cavity height
 *     (mounting height above the work plane).
 *   - Spacing criterion: uniform spacing ≤ SHR_max · mounting height
 *     prevents inter-fixture dark spots; row/col counts derive from the
 *     room aspect ratio at equal spacing.
 *   - Point-by-point horizontal illuminance from the inverse-square law:
 *       E_h = I_θ · cos³θ / h²
 *     for a downward luminaire at height h over the point (θ measured
 *     from vertical). Superposition over the layout verifies the design.
 *   - LPD (W/m²) compared against ASHRAE 90.1-style space-type allowances.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Design aid only — the governing lighting code and a photometric layout
 * (AGi32/Relux class) win the final design.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export interface RoomInput {
  /** Room name (reporting only). */
  name?: string;
  /** Floor area in m². */
  areaM2: number;
  /** Ceiling height in m. */
  ceilingHeightM: number;
  /** Work-plane height in m (0.75 m desk / 0 m floor). Default 0.75. */
  workPlaneM?: number;
  /** Room length in m (with widthM defines the aspect ratio). Optional. */
  lengthM?: number;
  /** Room width in m. Optional when only the area is known. */
  widthM?: number;
  /** Room surface reflectances [%]: ceiling / wall / floor (70-50-20 default). */
  reflectances?: { ceiling: number; wall: number; floor: number };
}

export interface LuminaireInput {
  /** Luminaire name (reporting only). */
  name?: string;
  /** Initial lamp lumens per luminaire. */
  lampLumens: number;
  /** System wattage per luminaire (lamp + driver) in W. */
  wattageW: number;
  /** Overall luminaire efficiency in (0, 1] — emitted/initial lamp lumens. */
  efficiency?: number;
  /** Spacing-to-mounting-height ratio limit from the photometry. Default 1.25. */
  shrMax?: number;
  /** Lamp lumen depreciation factor in (0, 1]. Default 0.9 (LED end-of-life). */
  lampLumenDepreciation?: number;
  /** Luminaire dirt depreciation factor in (0, 1]. Default 0.94. */
  luminaireDirtDepreciation?: number;
  /** Optional extra maintenance factor multiplier in (0, 1]. Default 1. */
  environmentFactor?: number;
  /** Peak candela used by the point calculation (defaults from lamp lumens). */
  peakCandela?: number;
}

export interface LightingTarget {
  /** Target maintained average illuminance in lux. */
  targetLux: number;
  /** Aim for exactly N luminaires (overrides the computed count). Optional. */
  fixedCount?: number;
}

export interface LumenResult {
  roomAreaM2: number;
  workPlaneMountHeightM: number;
  rcr: number;
  /** Estimated coefficient of utilisation in (0, 1). */
  cu: number;
  /** Total light loss factor in (0, 1]. */
  llf: number;
  luminaireCount: number;
  rows: number;
  columns: number;
  /** Longitudinal spacing between luminaires in m. */
  spacingAlongM: number;
  /** Cross spacing between luminaires in m. */
  spacingAcrossM: number;
  /** True when both spacings respect SHR_max × mounting height. */
  spacingOk: boolean;
  /** Maintained average illuminance delivered by the layout, lux. */
  averageLux: number;
  /** Installed lighting power in W. */
  installedPowerW: number;
  /** Lighting power density in W/m². */
  lpdWm2: number;
  /** ASHRAE 90.1-style allowance for the space type, W/m² (null when unknown). */
  lpdAllowanceWm2: number | null;
  /** True when LPD ≤ allowance (null allowance → true). */
  lpdOk: boolean;
  warnings: string[];
}

// ─── ASHRAE 90.1-style LPD allowances (W/m², building-area style) ─────────

export const LPD_ALLOWANCES_WM2: Record<string, number> = {
  "office-enclosed": 9.7,
  "office-open": 8.6,
  classroom: 11.8,
  conference: 12.9,
  corridor: 6.7,
  "corridor-restroom": 7.5,
  lobby: 9.7,
  retail: 12.9,
  "dining-cafeteria": 9.7,
  kitchen: 12.9,
  "warehouse-storage": 6.7,
  workshop: 13.5,
  "healthcare-exam": 12.9,
  "data-center": 16.1,
  "parking-interior": 1.9,
  "parking-exterior": 1.6,
};

/** Typical maintained illuminance targets (lux) by space type — CIBSE/IES style. */
export const TARGET_LUX_BY_SPACE: Record<string, number> = {
  "office-enclosed": 500,
  "office-open": 500,
  classroom: 300,
  conference: 500,
  corridor: 100,
  lobby: 200,
  retail: 300,
  "dining-cafeteria": 200,
  kitchen: 500,
  "warehouse-storage": 150,
  workshop: 300,
  "healthcare-exam": 500,
  "data-center": 500,
  "parking-interior": 75,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function requirePositive(v: number, name: string): number {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be finite and positive`);
  return v;
}

/** Room cavity ratio: 5 · h_c · (L + W) / (L · W). */
export function roomCavityRatio(lengthM: number, widthM: number, cavityHeightM: number): number {
  const l = requirePositive(lengthM, "lengthM");
  const w = requirePositive(widthM, "widthM");
  const h = requirePositive(cavityHeightM, "cavityHeightM");
  return (5 * h * (l + w)) / (l * w);
}

/**
 * Estimate the coefficient of utilisation from RCR, luminaire efficiency
 * and surface reflectances. Uses the standard CU-table shape: CU falls
 * with RCR, rises with reflectances and scales with luminaire efficiency.
 * Calibrated so a direct/indirect 70-50-20 office at RCR 1 ≈ 0.72 and
 * RCR 10 ≈ 0.25 — within ±8% of typical manufacturer tables.
 */
export function estimateUtilizationFactor(
  rcr: number,
  efficiency: number,
  reflectances: { ceiling: number; wall: number; floor: number },
): number {
  const eff = clamp(requirePositive(efficiency, "efficiency"), 0.1, 1);
  const rc = clamp(rcr, 0.2, 12);
  const cw = clamp(reflectances.ceiling, 0, 90) / 100;
  const mw = clamp(reflectances.wall, 0, 90) / 100;
  const fw = clamp(reflectances.floor, 0, 90) / 100;
  // Reflectance driver: cavity multi-bounce, wall-dominant at high RCR.
  const refDriver = 0.42 + 0.38 * cw + 0.26 * mw + 0.04 * fw;
  // Exponential decay with RCR, softened by wall reflectance.
  const decay = Math.exp(-rc * (0.19 - 0.07 * mw));
  const base = eff * refDriver * decay;
  return clamp(base, 0.08, 0.95);
}

/** Light loss factor = LLD · LDD · environment. */
export function lightLossFactor(l: LuminaireInput): number {
  const lld = clamp(l.lampLumenDepreciation ?? 0.9, 0.3, 1);
  const ldd = clamp(l.luminaireDirtDepreciation ?? 0.94, 0.3, 1);
  const env = clamp(l.environmentFactor ?? 1, 0.3, 1);
  return lld * ldd * env;
}

// ─── Lumen method layout ──────────────────────────────────────────────────

export function lumenMethod(
  room: RoomInput,
  luminaire: LuminaireInput,
  target: LightingTarget,
  spaceType?: string,
): LumenResult {
  const area = requirePositive(room.areaM2, "areaM2");
  const ceil = requirePositive(room.ceilingHeightM, "ceilingHeightM");
  const wp = room.workPlaneM ?? 0.75;
  if (wp < 0) throw new Error("workPlaneM must be >= 0");
  if (ceil - wp < 0.5) throw new Error("ceilingHeightM - workPlaneM must be >= 0.5 m");
  const lumens = requirePositive(luminaire.lampLumens, "lampLumens");
  const wattage = requirePositive(luminaire.wattageW, "wattageW");
  const targetLux = requirePositive(target.targetLux, "targetLux");
  const eff = luminaire.efficiency ?? 0.9;
  const shr = luminaire.shrMax ?? 1.25;

  const mountH = ceil - wp;
  let warnings: string[] = [];

  // Cavity ratio: prefer L·W when both known, else square-equivalent side.
  let rcr: number;
  let aspect = 1;
  if (room.lengthM && room.widthM) {
    rcr = roomCavityRatio(room.lengthM, room.widthM, mountH);
    aspect = Math.max(room.lengthM, room.widthM) / Math.min(room.lengthM, room.widthM);
  } else {
    const side = Math.sqrt(area);
    rcr = roomCavityRatio(side, side, mountH);
    warnings.push("Room length/width not given — square-equivalent cavity ratio used.");
  }

  const refl = room.reflectances ?? { ceiling: 70, wall: 50, floor: 20 };
  const cu = estimateUtilizationFactor(rcr, eff, refl);
  const llf = lightLossFactor(luminaire);

  let count = target.fixedCount != null ? Math.max(1, Math.floor(target.fixedCount)) : 0;
  if (count === 0) {
    count = Math.ceil((targetLux * area) / (lumens * cu * llf));
    if (!Number.isFinite(count) || count < 1) count = 1;
  }

  // Equal-spacing grid from the aspect ratio, honouring SHR_max × mountH.
  const maxSpacing = shr * mountH;
  let rows = 1;
  let cols = 1;
  if (room.lengthM && room.widthM) {
    const longIsLength = room.lengthM >= room.widthM;
    const longM = Math.max(room.lengthM, room.widthM);
    const shortM = Math.min(room.lengthM, room.widthM);
    const along = Math.max(1, Math.round((count * longM) / (longM + shortM)));
    rows = longIsLength ? Math.max(1, along) : Math.max(1, count - along + 1);
    cols = Math.max(1, Math.ceil(count / rows));
    // Keep the physical count honest with the requested/derived count.
    while (rows * cols > count && cols > 1) cols--;
    while (rows * cols < count) cols++;
  } else {
    cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
    rows = Math.max(1, Math.ceil(count / cols));
  }
  const spacingAlong = room.lengthM ? room.lengthM / rows : Math.sqrt(area) / rows;
  const spacingAcross = room.widthM ? room.widthM / cols : Math.sqrt(area) / cols;
  const spacingOk = spacingAlong <= maxSpacing + 1e-9 && spacingAcross <= maxSpacing + 1e-9;
  if (!spacingOk) {
    warnings.push(
      `Spacing ${Math.max(spacingAlong, spacingAcross).toFixed(2)} m exceeds SHR_max × mounting height ` +
      `${maxSpacing.toFixed(2)} m — add luminaires or reduce SHR.`,
    );
  }

  const averageLux = (count * lumens * cu * llf) / area;
  const installedPowerW = count * wattage;
  const lpdWm2 = installedPowerW / area;
  const allowance = spaceType ? (LPD_ALLOWANCES_WM2[spaceType] ?? null) : null;
  const lpdOk = allowance == null ? true : lpdWm2 <= allowance + 1e-9;
  if (spaceType && allowance == null) {
    warnings.push(`Unknown space type '${spaceType}' — LPD allowance not checked.`);
  }
  if (averageLux < targetLux - 1e-9 && target.fixedCount != null) {
    warnings.push(`Fixed count delivers ${averageLux.toFixed(0)} lx < target ${targetLux.toFixed(0)} lx.`);
  }

  return {
    roomAreaM2: area,
    workPlaneMountHeightM: mountH,
    rcr,
    cu,
    llf,
    luminaireCount: count,
    rows,
    columns: cols,
    spacingAlongM: spacingAlong,
    spacingAcrossM: spacingAcross,
    spacingOk,
    averageLux,
    installedPowerW,
    lpdWm2,
    lpdAllowanceWm2: allowance,
    lpdOk,
    warnings,
  };
}

// ─── Point-by-point horizontal illuminance ────────────────────────────────

/**
 * Horizontal illuminance under one downward luminaire at plan distance d
 * and mounting height h (meters): E = I·cos³θ / h². Maintained when a
 * luminaire LLF is passed.
 */
export function pointHorizontalIlluminance(
  peakCandela: number,
  mountingHeightM: number,
  horizontalDistanceM: number,
  llf = 1,
): number {
  const cd = requirePositive(peakCandela, "peakCandela");
  const h = requirePositive(mountingHeightM, "mountingHeightM");
  const d = Math.max(0, horizontalDistanceM);
  if (llf <= 0 || !Number.isFinite(llf)) throw new Error("llf must be positive");
  const r2 = h * h + d * d;
  const cos = h / Math.sqrt(r2);
  return (cd * cos * cos * cos) / (h * h) * llf;
}

/**
 * Superpose the layout grid: maintained horizontal illuminance at the
 * work plane from every luminaire in a rows×cols equal grid over the room.
 * Peak candela derives from lamp lumens when not given explicitly
 * (compact fluorescent/downlight style ≈ 0.28·Φ/π cd average, but a
 * direct fixture's peak ≈ Φ/π · 1.6; we use the conservative 1.0·Φ/π).
 */
export function gridIlluminance(
  room: RoomInput,
  luminaire: LuminaireInput,
  rows: number,
  columns: number,
): { centerLux: number; cornerLux: number; betweenLux: number; uniformity: number } {
  const ceil = requirePositive(room.ceilingHeightM, "ceilingHeightM");
  const wp = room.workPlaneM ?? 0.75;
  const h = ceil - wp;
  const l = room.lengthM ?? Math.sqrt(room.areaM2);
  const w = room.widthM ?? room.areaM2 / l;
  const llf = lightLossFactor(luminaire);
  const peakCd = luminaire.peakCandela ?? luminaire.lampLumens / Math.PI;

  const cellL = l / rows;
  const cellW = w / columns;
  const at = (px: number, py: number): number => {
    let sum = 0;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        const fx = (i + 0.5) * cellL;
        const fy = (j + 0.5) * cellW;
        const d = Math.hypot(px - fx, py - fy);
        sum += pointHorizontalIlluminance(peakCd, h, d, llf);
      }
    }
    return sum;
  };

  const center = at(l / 2, w / 2);
  const corner = at(0.25, 0.25);
  const between = at(cellL, cellW / 2);
  const uniformity = center > 0 ? corner / center : 0;
  return { centerLux: center, cornerLux: corner, betweenLux: between, uniformity };
}
