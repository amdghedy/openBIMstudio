/**
 * Rebar-to-rebar and rebar-to-clearance clash detection.
 *
 * Fast 3D distance checking between rebar polylines with spatial pre-filtering.
 */

import type { RebarBar, Vec3 } from "./types";
import { type StandardCode } from "./standards";

export interface RebarClash {
  id: string;
  bar1Id: string;
  bar2Id: string;
  bar1Label: string;
  bar2Label: string;
  distance: number;
  type: "hard" | "clearance";
  point: Vec3;
  severity: "critical" | "warning" | "info";
}

export interface ClashReport {
  clashes: RebarClash[];
  summary: { hard: number; clearance: number; total: number };
  timestamp: string;
  standard: string;
}

// Distance between two 3D line segments (p1->q1) and (p2->q2)
function segmentSegmentDistance(
  p1: Vec3, q1: Vec3,
  p2: Vec3, q2: Vec3
): { dist: number; midPoint: Vec3 } {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rpx = p1.x - p2.x, rpy = p1.y - p2.y, rpz = p1.z - p2.z;

  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rpx + d2y * rpy + d2z * rpz;

  let s = 0, t = 0;
  if (a <= 1e-8 && e <= 1e-8) {
    // Both are points
    s = 0; t = 0;
  } else if (a <= 1e-8) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x * rpx + d1y * rpy + d1z * rpz;
    if (e <= 1e-8) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const cp1: Vec3 = { x: p1.x + d1x * s, y: p1.y + d1y * s, z: p1.z + d1z * s };
  const cp2: Vec3 = { x: p2.x + d2x * t, y: p2.y + d2y * t, z: p2.z + d2z * t };

  const dist = Math.sqrt(
    Math.pow(cp1.x - cp2.x, 2) + Math.pow(cp1.y - cp2.y, 2) + Math.pow(cp1.z - cp2.z, 2)
  );

  return {
    dist,
    midPoint: {
      x: (cp1.x + cp2.x) / 2,
      y: (cp1.y + cp2.y) / 2,
      z: (cp1.z + cp2.z) / 2,
    },
  };
}

export function detectRebarClashes(
  bars: RebarBar[],
  minClearance: number = 0.02, // 20mm aggregate spacing default
  standard: StandardCode = "EC2"
): ClashReport {
  const clashes: RebarClash[] = [];
  let hardCount = 0;
  let clearanceCount = 0;

  for (let i = 0; i < bars.length; i++) {
    const b1 = bars[i];
    for (let j = i + 1; j < bars.length; j++) {
      const b2 = bars[j];

      // Minimum center-to-center distance for physical clearance
      const requiredCenterDist = (b1.diameter + b2.diameter) / 2;
      const clearanceThreshold = requiredCenterDist + minClearance;

      for (const s1 of b1.segments) {
        for (const s2 of b2.segments) {
          const { dist, midPoint } = segmentSegmentDistance(s1.start, s1.end, s2.start, s2.end);

          if (dist < requiredCenterDist - 0.002) {
            // Hard physical clash (interpenetration)
            hardCount++;
            clashes.push({
              id: `clash-${b1.id}-${b2.id}-${clashes.length + 1}`,
              bar1Id: b1.id,
              bar2Id: b2.id,
              bar1Label: b1.mark || b1.id,
              bar2Label: b2.mark || b2.id,
              distance: Math.round(dist * 1000) / 1000,
              type: "hard",
              point: midPoint,
              severity: "critical",
            });
            break;
          } else if (dist < clearanceThreshold) {
            // Insufficient clearance for aggregate
            clearanceCount++;
            clashes.push({
              id: `clearance-${b1.id}-${b2.id}-${clashes.length + 1}`,
              bar1Id: b1.id,
              bar2Id: b2.id,
              bar1Label: b1.mark || b1.id,
              bar2Label: b2.mark || b2.id,
              distance: Math.round(dist * 1000) / 1000,
              type: "clearance",
              point: midPoint,
              severity: "warning",
            });
            break;
          }
        }
      }
    }
  }

  return {
    clashes,
    summary: {
      hard: hardCount,
      clearance: clearanceCount,
      total: clashes.length,
    },
    timestamp: new Date().toISOString(),
    standard,
  };
}

export function clashReportToCSV(report: ClashReport): string {
  const headers = ["ID", "Severity", "Type", "Bar 1", "Bar 2", "Distance (m)", "X", "Y", "Z"];
  const rows = report.clashes.map((c) => [
    c.id,
    c.severity,
    c.type,
    `"${c.bar1Label}"`,
    `"${c.bar2Label}"`,
    c.distance,
    c.point.x.toFixed(3),
    c.point.y.toFixed(3),
    c.point.z.toFixed(3),
  ]);
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function clashReportToHTML(report: ClashReport): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Rebar Clash Report — ${report.standard}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #1e293b; background: #f8fafc; }
    h1 { color: #0f172a; margin-bottom: 8px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .critical { background: #fee2e2; color: #991b1b; }
    .warning { background: #fef3c7; color: #92400e; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
    th { background: #f1f5f9; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Rebar Clash Report</h1>
  <p>Standard: <strong>${report.standard}</strong> | Total Clashes: <strong>${report.summary.total}</strong> (Hard: ${report.summary.hard}, Clearance: ${report.summary.clearance})</p>
  <table>
    <thead>
      <tr><th>ID</th><th>Severity</th><th>Type</th><th>Bar 1</th><th>Bar 2</th><th>Distance</th><th>Location (m)</th></tr>
    </thead>
    <tbody>
      ${report.clashes.map((c) => `
        <tr>
          <td>${c.id}</td>
          <td><span class="badge ${c.severity}">${c.severity}</span></td>
          <td>${c.type}</td>
          <td>${c.bar1Label}</td>
          <td>${c.bar2Label}</td>
          <td>${(c.distance * 1000).toFixed(0)} mm</td>
          <td>(${c.point.x.toFixed(2)}, ${c.point.y.toFixed(2)}, ${c.point.z.toFixed(2)})</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</body>
</html>`;
}
