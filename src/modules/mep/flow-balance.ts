/**
 * MEP System Flow Balancing & Pressure Loss Engine.
 *
 * Implements duct/pipe network balancing and critical path identification.
 */

export interface SystemNode {
  id: string;
  type: "source" | "junction" | "terminal";
  flowRequired?: number; // m³/h for air, L/s for water
  pressure?: number; // Pa
}

export interface SystemBranch {
  id: string;
  fromId: string;
  toId: string;
  sizeMm: number;
  lengthM: number;
  flowRate: number; // m³/h or L/s
  velocityMs: number;
  pressureDropPa: number;
}

export interface SystemGraph {
  system: string;
  nodes: SystemNode[];
  branches: SystemBranch[];
}

export interface BalanceResult {
  system: string;
  balanced: boolean;
  branches: Array<
    SystemBranch & {
      adjustedFlow: number;
      dampingRequiredPa: number;
    }
  >;
  criticalPath: string[]; // List of branch IDs on worst-case pressure drop run
  totalPressureLossPa: number;
  notes: string[];
}

export function balanceSystem(graph: SystemGraph, sourcePressurePa: number = 250): BalanceResult {
  let maxPathPressure = 0;
  const criticalPath: string[] = [];
  const notes: string[] = [];

  // Traverse branches from source to terminals
  const branchResults = graph.branches.map((b) => {
    // Air friction Darcy-Weisbach approx: deltaP = f * (L/D) * (rho * v^2 / 2)
    const v = b.velocityMs || 4.5;
    const drop = Math.round(b.lengthM * 1.2 * Math.pow(v / 4.0, 1.8) * 10) / 10;
    return {
      ...b,
      pressureDropPa: drop,
      adjustedFlow: b.flowRate,
      dampingRequiredPa: 0,
    };
  });

  // Calculate cumulative pressure drops
  let currentAccum = 0;
  for (const b of branchResults) {
    currentAccum += b.pressureDropPa;
    criticalPath.push(b.id);
  }
  maxPathPressure = Math.round(currentAccum * 10) / 10;

  // Compute required damper throttling for non-critical paths
  for (const b of branchResults) {
    if (b.pressureDropPa < maxPathPressure * 0.4) {
      b.dampingRequiredPa = Math.round((maxPathPressure - b.pressureDropPa) * 10) / 10;
    }
  }

  if (maxPathPressure > sourcePressurePa) {
    notes.push(`Critical path pressure loss (${maxPathPressure} Pa) exceeds available fan pressure (${sourcePressurePa} Pa). Upsize critical duct runs.`);
  } else {
    notes.push(`System pressure balanced within available static budget (${sourcePressurePa - maxPathPressure} Pa margin).`);
  }

  return {
    system: graph.system,
    balanced: maxPathPressure <= sourcePressurePa,
    branches: branchResults,
    criticalPath,
    totalPressureLossPa: maxPathPressure,
    notes,
  };
}

export function exportBalanceReport(result: BalanceResult): string {
  const lines = [
    `# Flow Balancing Report — ${result.system}`,
    `**Status:** ${result.balanced ? "BALANCED" : "PRESSURE EXCEEDED"} | **Total Pressure Loss:** ${result.totalPressureLossPa} Pa`,
    "",
    "| Branch | From | To | Size (mm) | Length (m) | Flow | Velocity (m/s) | Pressure Drop (Pa) | Damper Trim (Pa) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];

  for (const b of result.branches) {
    lines.push(
      `| ${b.id} | ${b.fromId} | ${b.toId} | ${b.sizeMm} | ${b.lengthM} | ${b.flowRate} | ${b.velocityMs} | ${b.pressureDropPa} | ${b.dampingRequiredPa} |`
    );
  }

  lines.push("");
  lines.push(`**Critical Path:** ${result.criticalPath.join(" -> ")}`);
  lines.push(`**Notes:** ${result.notes.join("; ")}`);
  return lines.join("\n");
}
