/**
 * Rebar scheduling — Bar Bending Schedule (BBS) generator.
 *
 * Converts a RebarLayout into a structured bar bending schedule, matching
 * the format used in construction documents worldwide (BS 8666, ACI 315,
 * IS 1786). The schedule groups bars by mark, shape, and diameter, then
 * computes total lengths and masses per group.
 *
 * Output formats:
 *   - BBSRow[]: structured data for programmatic consumption
 *   - CSV: standard bar bending schedule table
 *   - JSON: full schedule with all metadata
 *
 * Pure TypeScript: no DOM, no three.js. Safe to unit-test in Node.
 */

import type { RebarBar, RebarLayout, RebarShapeCode } from "./types";
import { barArea, STEEL_DENSITY } from "./types";

/** A single row in a Bar Bending Schedule. */
export interface BBSRow {
  /** Bar mark (e.g. "1B", "2T", "S1"). */
  mark: string;
  /** Shape code per ACI 315. */
  shape: RebarShapeCode;
  /** Bar diameter in mm (e.g. 16 for D16). */
  diameterMm: number;
  /** Number of bars with this mark. */
  count: number;
  /** Length per bar in metres. */
  lengthPerBar: number;
  /** Total length of all bars with this mark (m). */
  totalLength: number;
  /** Total mass of all bars with this mark (kg). */
  totalMass: number;
  /** Role of the bar (main-bottom, main-top, stirrup, etc.). */
  role: string;
  /** Shape description for human reading. */
  shapeDescription: string;
}

/** The complete Bar Bending Schedule. */
export interface BBSSchedule {
  /** Project / host element name. */
  elementName: string;
  /** Host element type (beam, column, etc.). */
  elementType: string;
  /** Schedule rows, grouped by mark. */
  rows: BBSRow[];
  /** Total number of bars. */
  totalBars: number;
  /** Total steel mass (kg). */
  totalMass: number;
  /** Total steel length (m). */
  totalLength: number;
  /** Steel ratio (%). */
  steelRatio: number;
  /** Generation timestamp (ISO string). */
  generatedAt: string;
}

/** Human-readable shape descriptions per ACI 315 shape code. */
const SHAPE_DESCRIPTIONS: Record<RebarShapeCode, string> = {
  "straight": "Straight",
  "L-bend": "L-bend (90° hook one end)",
  "double-L": "Double L (90° hooks both ends)",
  "U-bar": "U-bar (180° bend)",
  "stirrup": "Closed stirrup (rectangular)",
  "stirrup-open": "Open stirrup (3 bends)",
  "candy": "Open stirrup (alias)",
};

/** Diameter in metres → mm string (e.g. 0.016 → "16"). */
function diameterToMm(d: number): number {
  return Math.round(d * 1000);
}

/**
 * Generate a Bar Bending Schedule from a RebarLayout.
 *
 * Groups bars by (mark, shape, diameter) and computes per-group totals.
 * Rows are sorted by mark for easy reading.
 */
export function generateBBS(
  layout: RebarLayout,
  elementName: string = "Element",
): BBSSchedule {
  const host = layout.host;

  // Group bars by (mark, shape, diameter).
  const groups = new Map<string, BBSRow>();

  for (const bar of layout.bars) {
    const key = `${bar.mark ?? "???"}-${bar.shape}-${bar.diameter}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalLength += bar.totalLength;
      existing.totalMass += bar.mass;
    } else {
      groups.set(key, {
        mark: bar.mark ?? "???",
        shape: bar.shape,
        diameterMm: diameterToMm(bar.diameter),
        count: 1,
        lengthPerBar: bar.totalLength,
        totalLength: bar.totalLength,
        totalMass: bar.mass,
        role: bar.role,
        shapeDescription: SHAPE_DESCRIPTIONS[bar.shape] ?? bar.shape,
      });
    }
  }

  // Sort rows by mark (alphabetical), with numeric-aware sorting for marks like "1B", "2T", "10B".
  const rows = [...groups.values()].sort((a, b) => {
    const an = parseInt(a.mark.replace(/\D/g, ""), 10) || 0;
    const bn = parseInt(b.mark.replace(/\D/g, ""), 10) || 0;
    if (an !== bn) return an - bn;
    return a.mark.localeCompare(b.mark);
  });

  // Recompute lengthPerBar as the average (in case of rounding differences).
  for (const row of rows) {
    row.lengthPerBar = row.totalLength / row.count;
  }

  return {
    elementName,
    elementType: host.type,
    rows,
    totalBars: layout.bars.length,
    totalMass: layout.totalMass,
    totalLength: layout.bars.reduce((s, b) => s + b.totalLength, 0),
    steelRatio: layout.steelRatio,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Export a BBS as CSV (standard bar bending schedule format).
 *
 * Columns: Mark, Shape, Diameter (mm), Count, Length/Bar (m),
 * Total Length (m), Total Mass (kg), Role, Shape Description
 */
export function bbsToCSV(schedule: BBSSchedule): string {
  const header = [
    "Mark", "Shape", "Diameter (mm)", "Count",
    "Length/Bar (m)", "Total Length (m)", "Total Mass (kg)",
    "Role", "Shape Description",
  ];
  const lines = [header.join(",")];

  for (const row of schedule.rows) {
    lines.push([
      `"${row.mark}"`,
      row.shape,
      row.diameterMm,
      row.count,
      row.lengthPerBar.toFixed(3),
      row.totalLength.toFixed(3),
      row.totalMass.toFixed(2),
      row.role,
      `"${row.shapeDescription}"`,
    ].join(","));
  }

  // Summary rows.
  lines.push("");
  lines.push(`"TOTAL"|"Bars=${schedule.totalBars}"|"Mass=${schedule.totalMass.toFixed(2)} kg"|"Length=${schedule.totalLength.toFixed(2)} m"|"Steel ratio=${(schedule.steelRatio * 100).toFixed(2)}%"`);
  lines.push(`"Generated"|"${schedule.generatedAt}"`);
  lines.push(`"Element"|"${schedule.elementName} (${schedule.elementType})"`);

  return lines.join("\r\n");
}

/**
 * Export a BBS as JSON.
 */
export function bbsToJSON(schedule: BBSSchedule): string {
  return JSON.stringify(schedule, null, 2);
}

/**
 * Export a BBS as a formatted text table (for console display).
 */
export function bbsToText(schedule: BBSSchedule): string {
  const lines: string[] = [];
  lines.push(`Bar Bending Schedule — ${schedule.elementName} (${schedule.elementType})`);
  lines.push(`Generated: ${schedule.generatedAt}`);
  lines.push("");
  lines.push(
    "Mark".padEnd(8) +
    "Shape".padEnd(16) +
    "Ø(mm)".padStart(6) +
    "Count".padStart(6) +
    "L/bar(m)".padStart(10) +
    "Total L(m)".padStart(12) +
    "Mass(kg)".padStart(10) +
    "  Role",
  );
  lines.push("-".repeat(80));

  for (const row of schedule.rows) {
    lines.push(
      row.mark.padEnd(8) +
      row.shape.padEnd(16) +
      String(row.diameterMm).padStart(6) +
      String(row.count).padStart(6) +
      row.lengthPerBar.toFixed(3).padStart(10) +
      row.totalLength.toFixed(3).padStart(12) +
      row.totalMass.toFixed(2).padStart(10) +
      "  " + row.role,
    );
  }

  lines.push("-".repeat(80));
  lines.push(
    "TOTAL".padEnd(8) +
    "".padEnd(16) +
    "".padStart(6) +
    String(schedule.totalBars).padStart(6) +
    "".padStart(10) +
    schedule.totalLength.toFixed(3).padStart(12) +
    schedule.totalMass.toFixed(2).padStart(10),
  );
  lines.push("");
  lines.push(`Steel ratio: ${(schedule.steelRatio * 100).toFixed(2)}%`);

  return lines.join("\n");
}
