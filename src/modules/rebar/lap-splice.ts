/**
 * Rebar Lap Splice verification & detailing.
 *
 * Checks overlap length against required lap lengths per chosen design standard.
 */

import type { RebarBar } from "./types";
import { type StandardCode, calcLapLength } from "./standards";

export interface LapSpliceResult {
  bar1Id: string;
  bar2Id: string;
  overlapLength: number; // in meters
  requiredLength: number; // in meters
  status: "pass" | "fail" | "marginal";
  zone: "tension" | "compression";
}

export function detectLapSplices(
  bars: RebarBar[],
  standard: StandardCode = "EC2",
  fck: number = 30
): LapSpliceResult[] {
  const results: LapSpliceResult[] = [];

  for (let i = 0; i < bars.length; i++) {
    const b1 = bars[i];
    if (b1.role === "stirrup" || b1.role === "stirrup-open") continue;

    for (let j = i + 1; j < bars.length; j++) {
      const b2 = bars[j];
      if (b2.role === "stirrup" || b2.role === "stirrup-open") continue;

      // Collinear or parallel bars with close center-to-center distance
      const d1 = b1.segments[0];
      const d2 = b2.segments[0];
      if (!d1 || !d2) continue;

      // Simple overlap calculation along principal axis (assumed longitudinal X or Z)
      const maxDia = Math.max(b1.diameter, b2.diameter);
      const reqLap = calcLapLength(standard, maxDia, fck);

      // Check distance between bar endpoints
      const dx1 = Math.abs(d1.end.x - d2.start.x);
      const dy1 = Math.abs(d1.end.y - d2.start.y);
      const dz1 = Math.abs(d1.end.z - d2.start.z);

      if (dy1 < 0.05 && (dx1 < 1.5 || dz1 < 1.5)) {
        // Parallel in Y, near in X/Z
        const overlap = Math.max(0, 1.2 - Math.min(dx1, dz1));
        if (overlap > 0.05) {
          const ratio = overlap / reqLap;
          const status = ratio >= 1.0 ? "pass" : ratio >= 0.85 ? "marginal" : "fail";
          results.push({
            bar1Id: b1.id,
            bar2Id: b2.id,
            overlapLength: Math.round(overlap * 1000) / 1000,
            requiredLength: reqLap,
            status,
            zone: b1.role === "main-bottom" ? "tension" : "compression",
          });
        }
      }
    }
  }

  return results;
}

export function renderLapSpliceOverlay(results: LapSpliceResult[]): string {
  const items = results.map((r, i) => {
    const color = r.status === "pass" ? "#10b981" : r.status === "marginal" ? "#f59e0b" : "#ef4444";
    return `
      <g transform="translate(10, ${20 + i * 28})">
        <rect width="380" height="24" rx="4" fill="#f8fafc" stroke="${color}" stroke-width="1.5"/>
        <text x="8" y="16" font-family="sans-serif" font-size="11" fill="#0f172a">
          Lap: ${r.bar1Id} &lt;-&gt; ${r.bar2Id} | Overlap: ${(r.overlapLength * 1000).toFixed(0)}mm / Req: ${(r.requiredLength * 1000).toFixed(0)}mm [${r.status.toUpperCase()}]
        </text>
      </g>
    `;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${Math.max(60, results.length * 30 + 30)}">
    ${items.join("")}
  </svg>`;
}
