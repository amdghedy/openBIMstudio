/**
 * Sanitary drainage sizing by drainage fixture units (DFU) — IPC Tables
 * 709.1, 710.1(1) and 710.1(2).
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * This is a capability Revit does not ship out of the box (Revit sizes
 * drainage by flow only; DFU sizing needs an add-in or a separate tool).
 *
 * Data (verified against the published ICC tables, 2024 IPC):
 *   - Table 709.1: per-fixture DFU weights.
 *   - Table 710.1(1): building drains and sewers — max DFU by diameter
 *     at 1/16, 1/8, 1/4 and 1/2 inch-per-foot slopes. Footnote (a): the
 *     minimum size of any building drain serving a water closet is 3 in.
 *   - Table 710.1(2): horizontal branches and stacks — branch total,
 *     one-branch-interval discharge, stacks of three intervals or less,
 *     and stacks of more than three intervals.
 *
 * Pipe sizes are nominal inches (the code's native unit); metric
 * equivalents are returned alongside. Results are sizing aids — the AHJ
 * and the governing local code (IPC / UPC / EN 12056) win.
 */

/** Inches → millimetres (nominal pipe size conversion for reporting). */
export const IN_TO_MM = 25.4;

/**
 * Per-fixture DFU weights — IPC Table 709.1 (2024). Keys are snake_case
 * identifiers; trap sizes are nominal inches.
 */
export const FIXTURE_DFU: Record<string, { dfu: number; trapIn: number }> = {
  "bathroom-group-1.6-gpf": { dfu: 5, trapIn: 0 },
  "bathroom-group-over-1.6-gpf": { dfu: 6, trapIn: 0 },
  "bathtub": { dfu: 2, trapIn: 1.5 },
  "bidet": { dfu: 1, trapIn: 1.25 },
  "combination-sink-and-tray": { dfu: 2, trapIn: 1.5 },
  "dental-lavatory": { dfu: 1, trapIn: 1.25 },
  "dental-unit-or-cuspidor": { dfu: 1, trapIn: 1.25 },
  "drinking-fountain": { dfu: 0.5, trapIn: 1.25 },
  "dishwasher-domestic": { dfu: 2, trapIn: 1.5 },
  "floor-drain": { dfu: 2, trapIn: 2 },
  "kitchen-sink-domestic": { dfu: 2, trapIn: 1.5 },
  "lavatory": { dfu: 1, trapIn: 1.25 },
  "laundry-tray": { dfu: 2, trapIn: 1.5 },
  "shower-5.7-gpm-or-less": { dfu: 2, trapIn: 1.5 },
  "shower-over-5.7-to-12.3-gpm": { dfu: 3, trapIn: 2 },
  "shower-over-12.3-to-25.8-gpm": { dfu: 5, trapIn: 3 },
  "shower-over-25.8-to-55.6-gpm": { dfu: 6, trapIn: 4 },
  "service-sink-mop": { dfu: 2, trapIn: 1.5 },
  "sink": { dfu: 2, trapIn: 1.5 },
  "urinal-standard": { dfu: 4, trapIn: 0 },
  "urinal-1-gpf-or-less": { dfu: 2, trapIn: 0 },
  "urinal-nonwater-supplied": { dfu: 0.5, trapIn: 0 },
  "wash-sink-circular-or-multiple": { dfu: 2, trapIn: 1.5 },
  "water-closet-flushometer-tank": { dfu: 4, trapIn: 0 },
  "water-closet-private-1.6-gpf": { dfu: 3, trapIn: 0 },
  "water-closet-private-over-1.6-gpf": { dfu: 4, trapIn: 0 },
  "water-closet-public-1.6-gpf": { dfu: 4, trapIn: 0 },
  "water-closet-public-over-1.6-gpf": { dfu: 6, trapIn: 0 },
};

/**
 * Sum a bag of fixture counts into total DFU, e.g.
 * `totalDfu({ "water-closet-public-1.6-gpf": 12, "lavatory": 24 })`.
 * Unknown keys return -1 so callers can surface a warning.
 */
export function totalDfu(counts: Record<string, number>): number {
  let total = 0;
  for (const [key, count] of Object.entries(counts)) {
    const w = FIXTURE_DFU[key];
    if (w == null) return -1;
    total += w.dfu * count;
  }
  return total;
}

/** Slop-sink/hose values and trap-arm details are code footnotes — not modelled here. */
export type DrainSlopeInFt = 0.0625 | 0.125 | 0.25 | 0.5; // 1/16, 1/8, 1/4, 1/2 in/ft

/** Explicit pipe-size order — Object.keys would hoist integer-like keys ("2","3",…) first. */
const DRAIN_ORDER = ["1.25", "1.5", "2", "2.5", "3", "4", "5", "6", "8", "10", "12", "15"];

/**
 * IPC Table 710.1(1) — building drains and sewers: maximum DFU by
 * diameter and slope. `null` = not permitted at that slope.
 */
export const BUILDING_DRAIN_DFUS: Record<DrainSlopeInFt, Record<string, number | null>> = {
  0.0625: { "1.25": null, "1.5": null, "2": null, "2.5": null, "3": null, "4": null, "5": null, "6": null, "8": 1400, "10": 2500, "12": 3900, "15": 7000 },
  0.125:  { "1.25": null, "1.5": null, "2": null, "2.5": null, "3": 36, "4": 180, "5": 390, "6": 700, "8": 1600, "10": 2900, "12": 4600, "15": 8300 },
  0.25:   { "1.25": 1, "1.5": 3, "2": 21, "2.5": 24, "3": 42, "4": 216, "5": 480, "6": 840, "8": 1920, "10": 3500, "12": 5600, "15": 10000 },
  0.5:    { "1.25": 1, "1.5": 3, "2": 26, "2.5": 31, "3": 50, "4": 250, "5": 575, "6": 1000, "8": 2300, "10": 4200, "12": 6700, "15": 12000 },
};

/**
 * IPC Table 710.1(2) — horizontal branches and stacks (max DFU):
 * branch total, discharge into one branch interval, stack of three
 * intervals or less, stack of more than three intervals.
 */
export const BRANCH_STACK_DFUS: Record<string, {
  branch: number; oneInterval: number; stackThreeOrLess: number; stackOverThree: number;
}> = {
  "1.5": { branch: 3, oneInterval: 2, stackThreeOrLess: 4, stackOverThree: 8 },
  "2":   { branch: 6, oneInterval: 6, stackThreeOrLess: 10, stackOverThree: 24 },
  "2.5": { branch: 12, oneInterval: 9, stackThreeOrLess: 20, stackOverThree: 42 },
  "3":   { branch: 20, oneInterval: 20, stackThreeOrLess: 48, stackOverThree: 72 },
  "4":   { branch: 160, oneInterval: 90, stackThreeOrLess: 240, stackOverThree: 500 },
  "5":   { branch: 360, oneInterval: 200, stackThreeOrLess: 540, stackOverThree: 1100 },
  "6":   { branch: 620, oneInterval: 350, stackThreeOrLess: 960, stackOverThree: 1900 },
  "8":   { branch: 1400, oneInterval: 600, stackThreeOrLess: 2200, stackOverThree: 3600 },
  "10":  { branch: 2500, oneInterval: 1000, stackThreeOrLess: 3800, stackOverThree: 5600 },
  "12":  { branch: 3900, oneInterval: 1500, stackThreeOrLess: 6000, stackOverThree: 8400 },
  "15":  { branch: 7000, oneInterval: 7000, stackThreeOrLess: 7000, stackOverThree: 7000 },
};

/** Drainage element to size. */
export type DrainElement = "horizontal-branch" | "stack" | "building-drain";

/** Which stack-interval column applies (Table 710.1(2)). */
export type StackIntervals = "1" | "2" | "3-or-less" | "over-3";

export interface DrainSizingResult {
  element: DrainElement;
  dfu: number;
  /** Selected nominal diameter, inches (the code's native unit). */
  diameterIn: number;
  diameterMm: number;
  slopeInFt?: DrainSlopeInFt;
  intervals?: StackIntervals;
  /** Capacity of the selected size (DFU). */
  capacityDfu: number;
  /** Code notes that apply to the selection. */
  notes: string[];
  rule: string;
  warnings: string[];
}

const ORDER = ["1.5", "2", "2.5", "3", "4", "5", "6", "8", "10", "12", "15"];

type StackColumn = "branch" | "oneInterval" | "stackThreeOrLess" | "stackOverThree";

function pickBranchStack(dfu: number, col: StackColumn): { size: string; capacity: number } | null {
  for (const size of ORDER) {
    const row = BRANCH_STACK_DFUS[size];
    if (row && row[col] >= dfu) return { size, capacity: row[col] };
  }
  return null;
}

/**
 * Size a horizontal branch, a stack, or a building drain for a DFU load.
 *
 * - `horizontal-branch`: Table 710.1(2) "total for horizontal branch".
 * - `stack`: Table 710.1(2) — picks the tighter of the per-interval
 *   discharge limit and the stack total for the given interval count.
 * - `building-drain`: Table 710.1(1) at the given slope; footnote (a)
 *   enforces a 3-inch minimum when the drain serves a water closet
 *   (`servesWaterCloset`).
 */
export function sizeDrain(
  element: DrainElement,
  dfu: number,
  opts: { slopeInFt?: DrainSlopeInFt; intervals?: StackIntervals; servesWaterCloset?: boolean } = {},
): DrainSizingResult {
  if (!Number.isFinite(dfu) || dfu <= 0) throw new Error("dfu must be a positive number");
  const warnings: string[] = [];
  const notes: string[] = [];

  if (element === "building-drain") {
    const slope = opts.slopeInFt ?? 0.25;
    const table = BUILDING_DRAIN_DFUS[slope];
    const minSize = opts.servesWaterCloset ? 3 : 0;
    if (minSize) notes.push("Minimum 3-inch building drain for any drain serving a water closet (IPC 710.1(1) footnote a).");
    for (const size of DRAIN_ORDER) {
      if (!(size in table)) continue;
      if (Number(size) < minSize) continue;
      const cap = table[size];
      if (cap == null) continue;
      if (cap >= dfu) {
        return {
          element, dfu, diameterIn: Number(size), diameterMm: Number(size) * IN_TO_MM,
          slopeInFt: slope, capacityDfu: cap, notes,
          rule: `building drain: ${size} in at ${slope} in/ft carries ${cap} DFU ≥ ${dfu} DFU (IPC Table 710.1(1))`,
          warnings,
        };
      }
    }
    throw new Error(`DFU load ${dfu} exceeds the largest tabulated building drain (15 in) at ${slope} in/ft`);
  }

  if (element === "horizontal-branch") {
    const pick = pickBranchStack(dfu, "branch");
    if (!pick) throw new Error(`DFU load ${dfu} exceeds the largest tabulated horizontal branch (15 in)`);
    return {
      element, dfu, diameterIn: Number(pick.size), diameterMm: Number(pick.size) * IN_TO_MM,
      capacityDfu: pick.capacity, notes,
      rule: `horizontal branch: ${pick.size} in carries ${pick.capacity} DFU ≥ ${dfu} DFU (IPC Table 710.1(2))`,
      warnings,
    };
  }

  // stack
  const intervals = opts.intervals ?? "3-or-less";
  const perIntervalCap = intervals === "1"
    ? "oneInterval" as const
    : intervals === "2" || intervals === "3-or-less"
      ? "stackThreeOrLess" as const
      : "stackOverThree" as const;
  // A stack is governed by both the total column and the one-interval limit.
  const oneInterval = pickBranchStack(dfu, "oneInterval");
  const totalCol = pickBranchStack(dfu, perIntervalCap);
  if (!oneInterval || !totalCol) {
    throw new Error(`DFU load ${dfu} exceeds the largest tabulated stack (15 in)`);
  }
  const chosen = Number(oneInterval.size) >= Number(totalCol.size) ? oneInterval : totalCol;
  if (intervals === "over-3") notes.push("Stacks greater than three branch intervals use the >3-intervals column (IPC Table 710.1(2)).");
  notes.push(`Discharge into any one branch interval is limited to ${oneInterval.capacity} DFU at ${oneInterval.size} in.`);
  return {
    element, dfu, diameterIn: Number(chosen.size), diameterMm: Number(chosen.size) * IN_TO_MM,
    intervals, capacityDfu: chosen.capacity, notes,
    rule: `stack (${intervals} branch intervals): ${chosen.size} in carries ${chosen.capacity} DFU ≥ ${dfu} DFU (IPC Table 710.1(2))`,
    warnings,
  };
}

/**
 * Inverse check: how many DFU a given drain size may carry.
 */
export function drainCapacity(
  element: DrainElement,
  diameterIn: number,
  opts: { slopeInFt?: DrainSlopeInFt; intervals?: StackIntervals } = {},
): { capacityDfu: number; notes: string[] } {
  const key = String(diameterIn);
  const notes: string[] = [];
  if (element === "building-drain") {
    const slope = opts.slopeInFt ?? 0.25;
    const cap = BUILDING_DRAIN_DFUS[slope][key];
    if (cap == null) throw new Error(`A ${key} in building drain is not tabulated at ${slope} in/ft`);
    return { capacityDfu: cap, notes };
  }
  const row = BRANCH_STACK_DFUS[key];
  if (!row) throw new Error(`A ${key} in drainage pipe is not tabulated`);
  if (element === "horizontal-branch") return { capacityDfu: row.branch, notes };
  const intervals = opts.intervals ?? "3-or-less";
  if (intervals === "1") return { capacityDfu: row.oneInterval, notes };
  if (intervals === "over-3") { notes.push(">3-interval stacks: 15 in has no tabulated value (IPC note c)."); return { capacityDfu: row.stackOverThree, notes }; }
  return { capacityDfu: row.stackThreeOrLess, notes };
}

/** Convenience: full fixture-bag sizing — counts → DFU → building drain. */
export function sizeDrainFromFixtures(
  counts: Record<string, number>,
  opts: { slopeInFt?: DrainSlopeInFt; servesWaterCloset?: boolean } = {},
): { dfu: number; drain: DrainSizingResult } | { error: string } {
  const dfu = totalDfu(counts);
  if (dfu < 0) return { error: "unknown fixture key in counts bag" };
  if (dfu === 0) return { error: "fixture counts sum to zero" };
  return { dfu, drain: sizeDrain("building-drain", dfu, opts) };
}
