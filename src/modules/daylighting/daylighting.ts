/**
 * Daylighting Analysis — daylight factor + sDA + ASE metrics.
 *
 * BIM-equivalent of Revit's "Lighting Analysis" plugin. Computes:
 *  - Daylight Factor (DF) at each analysis point on a workplane
 *  - Spatial Daylight Autonomy (sDA300/50%)
 *  - Annual Sunlight Exposure (ASE300/250h)
 *
 * Uses a simplified split-flux method (sky component + externally reflected
 * component + internally reflected component) — fast enough for early-stage
 * design feedback in the browser.
 */

export interface DaylightAnalysisParams {
  /** Room dimensions (m). */
  room: { width: number; depth: number; height: number };
  /** Window area (m²) — total fenestration on one wall. */
  windowArea: number;
  /** Window visible transmittance (VT, 0-1). */
  visibleTransmittance: number;
  /** Reflectances (0-1). */
  reflectances: { ceiling: number; walls: number; floor: number };
  /** Target workplane height above floor (m). */
  workplaneHeight: number;
  /** Analysis grid resolution (m). */
  gridResolution: number;
  /** Exterior horizontal illuminance on overcast day (lux). */
  exteriorIlluminance: number;
}

export interface DaylightPoint {
  x: number;
  z: number;
  daylightFactor: number; // %
  illuminance: number; // lux
}

export interface DaylightResult {
  /** Average daylight factor across the workplane. */
  averageDF: number;
  /** Min DF. */
  minDF: number;
  /** Max DF. */
  maxDF: number;
  /** Percentage of points achieving DF ≥ 2% (BREEAM "good"). */
  passRate: number;
  /** Grid points with computed values. */
  points: DaylightPoint[];
  /** sDA300/50% — fraction of occupied hours above 300 lux. */
  sDA: number;
  /** ASE — fraction above 1000 lux direct sun > 250h/year. */
  ASE: number;
}

const DEFAULTS = {
  visibleTransmittance: 0.7,
  reflectances: { ceiling: 0.8, walls: 0.5, floor: 0.2 },
  workplaneHeight: 0.8,
  gridResolution: 0.5,
  exteriorIlluminance: 10000,
};

/** Run daylighting analysis. */
export function runDaylightAnalysis(input: Partial<DaylightAnalysisParams> = {}): DaylightResult {
  const p: DaylightAnalysisParams = { ...DEFAULTS, ...input } as DaylightAnalysisParams;
  if (!p.room) throw new Error("Room dimensions required");

  const { width, depth, height } = p.room;
  const points: DaylightPoint[] = [];
  let sumDF = 0;
  let minDF = Infinity;
  let maxDF = -Infinity;
  let passCount = 0;

  // Total interior surface area.
  const A_floor = width * depth;
  const A_ceiling = A_floor;
  const A_wall_long = depth * height;
  const A_wall_short = width * height;
  const A_total = 2 * (A_floor + A_ceiling) + 2 * (A_wall_long + A_wall_short);

  // Average interior reflectance (area-weighted).
  const r_avg =
    (p.reflectances.ceiling * A_ceiling +
      p.reflectances.floor * A_floor +
      p.reflectances.walls * (2 * (A_wall_long + A_wall_short))) / A_total;

  // Window-to-floor ratio.
  const WFR = p.windowArea / A_floor;

  // Iterate over workplane grid.
  for (let x = p.gridResolution * 0.5; x < width; x += p.gridResolution) {
    for (let z = p.gridResolution * 0.5; z < depth; z += p.gridResolution) {
      // Distance to window (window on wall at z = 0).
      const dist = z;
      // Sky component (simplified cosine falloff from window).
      const angleToWindow = Math.atan2(p.room.height - p.workplaneHeight, dist);
      const skyComponent = (p.windowArea * Math.sin(angleToWindow) * p.visibleTransmittance) /
        (2 * Math.PI * Math.max(dist, 0.5) * height);
      // Externally reflected component (~10% of sky).
      const extComponent = 0.1 * skyComponent;
      // Internally reflected component (BRE split-flux formula).
      const irc = (p.windowArea * p.visibleTransmittance * 0.5 * r_avg) /
        (A_total * (1 - r_avg));
      const DF = (skyComponent + extComponent + irc) * 100; // %
      const illuminance = (DF / 100) * p.exteriorIlluminance;
      points.push({ x, z, daylightFactor: DF, illuminance });
      sumDF += DF;
      if (DF < minDF) minDF = DF;
      if (DF > maxDF) maxDF = DF;
      if (DF >= 2) passCount++;
    }
  }

  const averageDF = points.length ? sumDF / points.length : 0;
  const passRate = points.length ? passCount / points.length : 0;

  // Approximate sDA & ASE from DF distribution.
  // sDA300/50% — fraction of points likely ≥ 300 lux ≥ 50% of occupied hours.
  // Heuristic: if avg DF > 3% and pass rate > 60%, sDA ≈ 0.55.
  const sDA = Math.min(1, Math.max(0, (averageDF / 5) * 0.7 + passRate * 0.3));
  // ASE — excess direct sun; if WFR > 0.25 and avg DF > 4%, ASE > 0.10.
  const ASE = WFR > 0.25 && averageDF > 4 ? Math.min(1, (WFR - 0.25) * 2) : 0;

  return {
    averageDF,
    minDF: minDF === Infinity ? 0 : minDF,
    maxDF: maxDF === -Infinity ? 0 : maxDF,
    passRate,
    points,
    sDA,
    ASE,
  };
}

/** Classify a daylight factor value. */
export function classifyDF(df: number): "insufficient" | "adequate" | "good" | "excellent" {
  if (df < 1) return "insufficient";
  if (df < 2) return "adequate";
  if (df < 5) return "good";
  return "excellent";
}
