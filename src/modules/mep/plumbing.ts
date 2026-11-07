/**
 * Plumbing demand engineering — Hunter's curve & water-hammer surge.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Fixture-unit demand:
 *   The probable peak demand for a domestic water system is estimated from
 *   the total water-supply fixture-unit (WSFU) load using Hunter's curve
 *   (NBS BMS 65, reproduced in IPC Appendix E / UPC Appendix B Table B.5.4).
 *   Two curves exist: one for systems where water closets are flushed by
 *   flush tanks and a higher one for flushometer (flush-valve) systems; the
 *   two converge at 1000 WSFU. We interpolate the published table in
 *   log(FU)-log(gpm) space, which is how the curve is usually read, and
 *   extrapolate beyond the last table row with the final segment's slope.
 *
 * Water hammer:
 *   Joukowsky surge ΔP = ρ · c · Δv, with the pressure-wave speed in a
 *   thin-walled pipe c = c_fluid / sqrt(1 + (K·D)/(E·e)).
 *
 * Results are estimation aids for early design and auditing; final sizing
 * must follow the governing local code (IPC / UPC / EN 806 as applicable).
 */

/** One published demand-table row: [WSFU, GPM]. */
type HunterRow = [number, number];

/**
 * Flush-tank curve (IPC/UPC Table B.5.4, "GPM Flush Tanks" column).
 * Rows verified against the published table; extrapolated beyond 4000 FU.
 */
const HUNTER_TANK: HunterRow[] = [
  [3, 3], [4, 4], [5, 4.5], [6, 5], [7, 6], [8, 7], [9, 7.5], [10, 8],
  [11, 8.5], [12, 9], [13, 10], [14, 10.5], [15, 11], [16, 12], [17, 12.5],
  [18, 13], [19, 13.5], [20, 14], [25, 17], [120, 49], [140, 53], [160, 57],
  [180, 61], [200, 65], [225, 70], [250, 75], [300, 85], [400, 105],
  [500, 125], [750, 170], [1000, 210], [1250, 240], [1500, 270], [1750, 300],
  [2000, 325], [2500, 380], [3000, 435], [4000, 525],
];

/**
 * Flush-valve (flushometer) curve ("GPM Flush Valves" column). The curve
 * converges with the flush-tank curve at 1000 WSFU; beyond that the tank
 * table is used directly.
 */
const HUNTER_VALVE: HunterRow[] = [
  [5, 22], [6, 23], [7, 24], [8, 25], [9, 26], [10, 27], [11, 28], [12, 29],
  [13, 29.5], [14, 30], [15, 31], [16, 32], [17, 33], [18, 33.5], [19, 34],
  [20, 35], [25, 38], [120, 74], [140, 78], [160, 83], [180, 87], [200, 91],
  [225, 95], [250, 100], [300, 110], [400, 125], [500, 140], [750, 175],
  [1000, 210],
];

/** US gallons per minute → litres per second. */
export const GPM_TO_LS = 0.0630902;

/** Water-closet flush type — selects the Hunter curve branch. */
export type WcFlush = "tank" | "valve";

/**
 * Log-log interpolation over a demand table. Above the last row the value
 * is extrapolated with the final segment's slope; below the first row the
 * first row's demand is used (conservative minimum).
 */
function interpHunter(table: HunterRow[], fu: number): number {
  if (!Number.isFinite(fu) || fu <= 0) return table[0][1];
  if (fu <= table[0][0]) return table[0][1];
  const last = table.length - 1;
  if (fu >= table[last][0]) {
    // Log-log extrapolation with the last segment's slope.
    const [x0, y0] = table[last - 1];
    const [x1, y1] = table[last];
    const slope = Math.log(y1 / y0) / Math.log(x1 / x0);
    return y1 * Math.pow(fu / x1, slope);
  }
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (fu <= x1) {
      const slope = Math.log(y1 / y0) / Math.log(x1 / x0);
      return y0 * Math.pow(fu / x0, slope);
    }
  }
  return table[last][1];
}

/**
 * Probable peak domestic-water demand for a WSFU load.
 * Returns both gpm and L/s plus the curve used, for audit.
 */
export function fixtureUnitsToDemand(
  fixtureUnits: number,
  wcFlush: WcFlush = "valve",
): { gpm: number; ls: number; curve: string } {
  const table = wcFlush === "valve" && fixtureUnits < 1000 ? HUNTER_VALVE : HUNTER_TANK;
  const gpm = interpHunter(table, fixtureUnits);
  return {
    gpm,
    ls: gpm * GPM_TO_LS,
    curve: `Hunter ${wcFlush === "valve" && fixtureUnits < 1000 ? "flush-valve" : "flush-tank"} curve @ ${fixtureUnits} WSFU`,
  };
}

/** Common fixture WSFU weights (IPC Appendix E, typical values). */
export const FIXTURE_WSFU: Record<string, number> = {
  "water-closet-flush-valve": 10,
  "water-closet-tank": 5,
  "lavatory-private": 1,
  "lavatory-public": 2,
  "sink-kitchen-private": 2,
  "sink-kitchen-public": 4,
  "shower-head": 4,
  "bathtub": 8,
  "bidet": 2,
  "urinal-wall": 5,
  "flush-valve-slop-sink": 8,
  "hose-bibb": 5,
  "washing-machine-domestic": 4,
  "dishwasher-domestic": 2,
  "drinking-fountain": 1,
};

/**
 * Sum a bag of fixture counts into total WSFU, e.g.
 * `totalWsfu({ "water-closet-flush-valve": 12, lavatory: 24 })`.
 * Unknown keys return -1 so callers can surface a warning.
 */
export function totalWsfu(counts: Record<string, number>): number {
  let total = 0;
  for (const [key, count] of Object.entries(counts)) {
    const w = FIXTURE_WSFU[key];
    if (w == null) return -1;
    total += w * count;
  }
  return total;
}

/**
 * End-to-end sizing helper: fixture counts → WSFU → peak demand L/s,
 * which can be fed straight into `sizeForSystem("domestic-cold"|"domestic-hot", ls)`.
 */
export function demandFromFixtures(
  counts: Record<string, number>,
  wcFlush: WcFlush = "valve",
): { wsfu: number; ls: number; gpm: number; curve: string } | { error: string } {
  const wsfu = totalWsfu(counts);
  if (wsfu < 0) return { error: "unknown fixture key in counts bag" };
  if (wsfu === 0) return { error: "fixture counts sum to zero" };
  const d = fixtureUnitsToDemand(wsfu, wcFlush);
  return { wsfu, ls: d.ls, gpm: d.gpm, curve: d.curve };
}

/**
 * Joukowsky water-hammer surge for a sudden valve closure.
 * D and e describe the pipe (e = wall thickness); when either is omitted
 * the fluid is treated as rigid (c = sqrt(K/ρ), ≈1483 m/s for water).
 */
export function waterHammerSurge(input: {
  /** Change in flow velocity at the closure (m/s). */
  velocityChangeMs: number;
  /** Pipe inner diameter (m). */
  innerDiameterM?: number;
  /** Pipe wall thickness (m). */
  wallThicknessM?: number;
  /** Fluid bulk modulus (Pa). Default water 2.19 GPa. */
  fluidBulkModulusPa?: number;
  /** Fluid density (kg/m^3). Default 1000. */
  fluidDensityKgM3?: number;
  /** Pipe elastic modulus (Pa). Default steel 200 GPa. */
  pipeElasticModulusPa?: number;
}): { waveSpeedMs: number; surgePressurePa: number; surgePressureBar: number } {
  const dv = input.velocityChangeMs;
  const rho = input.fluidDensityKgM3 ?? 1000;
  const K = input.fluidBulkModulusPa ?? 2.19e9;
  const E = input.pipeElasticModulusPa ?? 200e9;
  const c0 = Math.sqrt(K / rho);

  let c = c0;
  const D = input.innerDiameterM;
  const e = input.wallThicknessM;
  if (D != null && e != null && e > 0) {
    c = c0 / Math.sqrt(1 + (K * D) / (E * e));
  }

  const dP = rho * c * dv;
  return {
    waveSpeedMs: c,
    surgePressurePa: dP,
    surgePressureBar: dP / 1e5,
  };
}

/** Minimum recommended surge margin: surge pressure + working pressure vs pipe rating. */
export function surgeMarginCheck(input: {
  workingPressureBar: number;
  surgePressureBar: number;
  pipeRatingBar: number;
}): { ok: boolean; totalBar: number; marginBar: number; message: string } {
  const total = input.workingPressureBar + input.surgePressureBar;
  const margin = input.pipeRatingBar - total;
  return {
    ok: margin >= 0,
    totalBar: total,
    marginBar: margin,
    message: margin >= 0
      ? `Working + surge ${total.toFixed(2)} bar fits the ${input.pipeRatingBar} bar pipe rating (margin ${margin.toFixed(2)} bar).`
      : `Working + surge ${total.toFixed(2)} bar exceeds the ${input.pipeRatingBar} bar pipe rating by ${(-margin).toFixed(2)} bar — add slow-closing valves or surge vessels.`,
  };
}
