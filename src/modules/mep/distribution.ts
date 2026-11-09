/**
 * Electrical distribution cascade — upstream panel hierarchy, demand
 * roll-up, feeder checks, and wire-sizing-enhanced panel schedules.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Complements src/modules/mep/electrical.ts (panels/circuits) and
 * electrical-calc.ts (conductors/voltage drop), which it imports.
 *
 * What Revit parity means here:
 *   - Revit panels know their upstream panel/transformer and roll demand
 *     up the tree. `buildDistributionSummary` does the same for links
 *     supplied by the model, with cycle/multi-parent guards and
 *     feeder-breaker adequacy checks.
 *   - Revit panel schedules can show wire sizes. `enhancePanelSchedule`
 *     auto-selects a conductor from the design current (IEC 60364-5-52
 *     style reference table) and reports the voltage drop when the
 *     circuit's route length is known.
 */

import {
  buildPanelSchedule, validateElectricalDistribution, currentFromVA,
} from "./electrical";
import type {
  ElectricalPanel, ElectricalLoad, ElectricalDiagnostic,
  PanelSchedule, PanelScheduleRow, CircuitStatus,
} from "./electrical";
import { selectConductor, voltageDrop, AMPACITY_CU_PVC_C, CONDUCTOR_SIZES } from "./electrical-calc";

/** Reference ampacity lookup for override sizes (0 when unknown). */
const AMPACITY_BY_SIZE = new Map(CONDUCTOR_SIZES.map((mm2) => [mm2, AMPACITY_CU_PVC_C[String(mm2)] ?? 0]));

// ── Enhanced panel schedule (wire sizing + voltage drop) ───────────────────

/** Optional circuit extension consumed by the enhanced schedule. */
export interface CircuitWireInfo {
  circuitId: string;
  /** One-way route length (m) — enables the voltage-drop advisory. */
  routeLengthM?: number;
  /** Override the auto-selected conductor with a design decision (mm²). */
  conductorMm2Override?: number;
  /** Permitted voltage-drop percentage (default 3). */
  maxDropPercent?: number;
}

export interface EnhancedPanelRow extends PanelScheduleRow {
  /** Auto-selected conductor (mm²) from the design current, or the override. */
  recommendedConductorMm2: number | null;
  /** Reference ampacity of the selected conductor (A). */
  recommendedConductorAmpacityA: number | null;
  /** Voltage drop (%) when a route length was supplied, else null. */
  voltageDropPercent: number | null;
  /** Row-level wire findings. */
  wireFindings: string[];
}

export interface EnhancedPanelSchedule extends PanelSchedule {
  rows: EnhancedPanelRow[];
  /** Circuit wire-info records accepted (for audit). */
  wireInfoAccepted: number;
  /** Rows carrying at least one wire finding. */
  wireIssueCount: number;
}

/**
 * Build the panel schedule and enrich every row with an auto-selected
 * conductor and (when route length is known) the voltage drop.
 */
export function enhancePanelSchedule(
  panel: ElectricalPanel,
  loads: readonly ElectricalLoad[],
  wireInfo: readonly CircuitWireInfo[] = [],
): EnhancedPanelSchedule {
  const base = buildPanelSchedule(panel, loads);
  const infoById = new Map(wireInfo.map((w) => [w.circuitId, w]));
  const rows: EnhancedPanelRow[] = base.rows.map((row) => {
    const findings: string[] = [];
    const info = infoById.get(row.circuitId);
    let mm2: number | null = null;
    let ampacity: number | null = null;
    if (info?.conductorMm2Override != null) {
      mm2 = info.conductorMm2Override;
      ampacity = AMPACITY_BY_SIZE.get(mm2) ?? 0;
      if (ampacity === 0) {
        findings.push(`Conductor override ${mm2} mm² is not in the reference ampacity table.`);
        ampacity = null;
      }
    } else if (row.designCurrentA > 0) {
      const sel = selectConductor(row.designCurrentA);
      if (sel) { mm2 = sel.mm2; ampacity = sel.ampacityA; }
      else findings.push(`No conductor in the reference table covers ${row.designCurrentA.toFixed(1)} A.`);
    }
    let dropPercent: number | null = null;
    if (info?.routeLengthM != null && info.routeLengthM > 0 && mm2 != null && row.designCurrentA > 0) {
      const vd = voltageDrop({
        phase: row.phase,
        voltageV: row.voltageV,
        currentA: row.designCurrentA,
        lengthM: info.routeLengthM,
        conductorMm2: mm2,
      });
      dropPercent = vd.dropPercent;
      const limit = info.maxDropPercent ?? 3;
      if (vd.dropPercent > limit) {
        findings.push(`Voltage drop ${vd.dropPercent.toFixed(2)}% exceeds the ${limit}% limit — upsize or shorten the run.`);
      }
    }
    if (ampacity != null && row.breakerRatingA > ampacity + 1e-6) {
      findings.push(`Breaker ${row.breakerRatingA} A exceeds the ${ampacity} A ampacity of the ${mm2} mm² conductor.`);
    }
    return {
      ...row,
      recommendedConductorMm2: mm2,
      recommendedConductorAmpacityA: ampacity,
      voltageDropPercent: dropPercent,
      wireFindings: findings,
    };
  });
  const wireIssueCount = rows.filter((r) => r.wireFindings.length > 0).length;
  return {
    ...base,
    rows,
    wireInfoAccepted: wireInfo.length,
    wireIssueCount,
  };
}

// ── Upstream distribution cascade ───────────────────────────────────────────

/** A feeder link between two panels (downstream is fed from upstream). */
export interface PanelLink {
  downstreamPanelId: string;
  upstreamPanelId: string;
  /** Upstream breaker protecting the feeder (A). */
  feedBreakerA?: number;
  /** Feeder route length (m) — enables the feeder voltage-drop advisory. */
  cableLengthM?: number;
  /** Feeder conductor (mm²) — enables the feeder voltage-drop advisory. */
  cableMm2?: number;
  /** Demand diversity applied to the downstream panel's demand when rolling up (default 1). */
  downstreamDemandFactor?: number;
}

export interface PanelRollup {
  panelId: string;
  /** The panel's own circuit demand (VA). */
  ownDemandVA: number;
  /** Sum of downstream panels' rolled-up demand (VA), after diversity. */
  downstreamDemandVA: number;
  /** Total demand this panel's bus must carry (VA). */
  totalDemandVA: number;
  /** Total demand current at this panel's voltage/phase (A). */
  totalDemandCurrentA: number;
  upstreamPanelId: string | null;
  feedBreakerA: number | null;
  /** Depth in the distribution tree (source panel = 0). */
  depth: number;
  /** Direct downstream panel ids. */
  feedsPanelIds: string[];
}

export interface DistributionDiagnostic {
  code: string;
  severity: CircuitStatus;
  message: string;
  panelId?: string;
  linkIndex?: number;
}

export interface DistributionSummary {
  rollups: PanelRollup[];
  diagnostics: DistributionDiagnostic[];
  /** Panel ids that feed no other panel (leaf panels). */
  leafPanelIds: string[];
  /** True when every panel is reachable from exactly one root. */
  treeOk: boolean;
}

/**
 * Roll demand up a panel hierarchy.
 *
 * Each panel's own demand comes from its panel schedule; each feeder
 * link adds the downstream panel's total demand (× its diversity factor)
 * to the upstream panel. Guards: unknown panels, duplicate parents,
 * cycles, depth cap, feeder breaker adequacy, and an optional feeder
 * voltage-drop advisory.
 */
export function buildDistributionSummary(
  panels: readonly ElectricalPanel[],
  loads: readonly ElectricalLoad[],
  links: readonly PanelLink[],
  opts: { defaultDownstreamDemandFactor?: number; validateAssignments?: boolean } = {},
): DistributionSummary {
  const diagnostics: DistributionDiagnostic[] = [];
  const panelById = new Map(panels.map((p) => [p.id, p]));
  const ownDemand = new Map<string, number>();
  for (const p of panels) {
    ownDemand.set(p.id, buildPanelSchedule(p, loads).totalDemandVA);
  }
  if (opts.validateAssignments !== false) {
    // Surface classic electrical issues as distribution diagnostics.
    for (const d of validateElectricalDistribution(panels, loads)) {
      diagnostics.push({ code: `ELECTRICAL_${d.code}`, severity: d.severity, message: d.message, panelId: d.panelId });
    }
  }

  const upstreamOf = new Map<string, { upstream: string; linkIndex: number }>();
  links.forEach((link, i) => {
    if (!panelById.has(link.downstreamPanelId)) {
      diagnostics.push({ code: "LINK_DOWNSTREAM_UNKNOWN", severity: "error", message: `Feeder link ${i} references unknown downstream panel '${link.downstreamPanelId}'.`, linkIndex: i });
      return;
    }
    if (!panelById.has(link.upstreamPanelId)) {
      diagnostics.push({ code: "LINK_UPSTREAM_UNKNOWN", severity: "error", message: `Feeder link ${i} references unknown upstream panel '${link.upstreamPanelId}'.`, linkIndex: i });
      return;
    }
    if (link.downstreamPanelId === link.upstreamPanelId) {
      diagnostics.push({ code: "LINK_SELF", severity: "error", message: `Panel '${link.downstreamPanelId}' cannot feed itself.`, linkIndex: i });
      return;
    }
    if (upstreamOf.has(link.downstreamPanelId)) {
      diagnostics.push({ code: "LINK_MULTIPLE_PARENTS", severity: "error", message: `Panel '${link.downstreamPanelId}' is fed by more than one upstream panel — radial distribution requires exactly one.`, linkIndex: i });
      return;
    }
    upstreamOf.set(link.downstreamPanelId, { upstream: link.upstreamPanelId, linkIndex: i });
  });

  // Downstream adjacency + cycle/depth guard.
  const feeds = new Map<string, string[]>();
  for (const [down, { upstream }] of upstreamOf) {
    if (!feeds.has(upstream)) feeds.set(upstream, []);
    feeds.get(upstream)!.push(down);
  }
  const depthOf = new Map<string, number>();
  const inCycle = new Set<string>();
  const depth = (id: string, path: Set<string>): number => {
    if (depthOf.has(id)) return depthOf.get(id)!;
    if (path.has(id)) {
      diagnostics.push({ code: "LINK_CYCLE", severity: "error", message: `Feeder cycle detected through panel '${id}' — demand is not rolled up across cycles.` });
      inCycle.add(id);
      return 0;
    }
    path.add(id);
    const up = upstreamOf.get(id);
    const d = up ? 1 + depth(up.upstream, path) : 0;
    path.delete(id);
    depthOf.set(id, d);
    return d;
  };
  for (const p of panels) depth(p.id, new Set());

  // Post-order roll-up (memoised by depth).
  const rolled = new Map<string, { downstreamVA: number }>();
  const rollDown = (id: string): number => {
    if (rolled.has(id)) return rolled.get(id)!.downstreamVA;
    if (inCycle.has(id)) { rolled.set(id, { downstreamVA: 0 }); return 0; }
    let sum = 0;
    for (const child of feeds.get(id) ?? []) {
      const factor = links[upstreamOf.get(child)!.linkIndex].downstreamDemandFactor
        ?? opts.defaultDownstreamDemandFactor ?? 1;
      sum += ownDemand.get(child)! * factor + rollDown(child);
    }
    rolled.set(id, { downstreamVA: sum });
    return sum;
  };

  const rollups: PanelRollup[] = panels.map((p) => {
    const own = ownDemand.get(p.id) ?? 0;
    const downVA = rollDown(p.id);
    const total = own + downVA;
    const up = upstreamOf.get(p.id);
    const panel = panelById.get(p.id)!;
    let feedBreakerA: number | null = null;
    if (up) {
      const link = links[up.linkIndex];
      feedBreakerA = link.feedBreakerA ?? null;
      if (link.feedBreakerA != null) {
        if (!(link.feedBreakerA > 0)) {
          diagnostics.push({ code: "FEED_BREAKER_INVALID", severity: "error", message: `Feeder breaker for '${p.id}' must be a positive number.`, panelId: p.id, linkIndex: up.linkIndex });
        } else {
          const current = panel.voltageV > 0 ? currentFromVA(total, panel.voltageV, panel.phase) : 0;
          if (current > link.feedBreakerA + 1e-6) {
            diagnostics.push({ code: "FEED_BREAKER_UNDERRATED", severity: "error", message: `Demand current ${current.toFixed(1)} A through panel '${p.id}' exceeds its ${link.feedBreakerA} A feeder breaker.`, panelId: p.id, linkIndex: up.linkIndex });
          }
          const parent = panelById.get(link.upstreamPanelId)!;
          if (parent.voltageV !== panel.voltageV || parent.phase !== panel.phase) {
            diagnostics.push({ code: "FEED_VOLTAGE_MISMATCH", severity: "error", message: `Feeder to '${p.id}' connects a ${panel.voltageV} V panel to a ${parent.voltageV} V supply — a transformer is required.`, panelId: p.id, linkIndex: up.linkIndex });
          }
          if (link.cableLengthM != null && link.cableLengthM > 0 && link.cableMm2 != null) {
            const vd = voltageDrop({
              phase: panel.phase, voltageV: panel.voltageV,
              currentA: current, lengthM: link.cableLengthM, conductorMm2: link.cableMm2,
            });
            if (vd.dropPercent > 3) {
              diagnostics.push({ code: "FEED_VOLTAGE_DROP", severity: "warning", message: `Feeder to '${p.id}' drops ${vd.dropPercent.toFixed(2)}% over ${link.cableLengthM} m at ${link.cableMm2} mm².`, panelId: p.id, linkIndex: up.linkIndex });
            }
          }
        }
      }
    }
    return {
      panelId: p.id,
      ownDemandVA: own,
      downstreamDemandVA: downVA,
      totalDemandVA: total,
      totalDemandCurrentA: panel.voltageV > 0 ? currentFromVA(total, panel.voltageV, panel.phase) : 0,
      upstreamPanelId: up ? up.upstream : null,
      feedBreakerA,
      depth: depthOf.get(p.id) ?? 0,
      feedsPanelIds: [...(feeds.get(p.id) ?? [])],
    };
  });

  const leafPanelIds = rollups.filter((r) => r.feedsPanelIds.length === 0).map((r) => r.panelId);
  const treeOk = !diagnostics.some((d) =>
    d.code === "LINK_CYCLE" || d.code === "LINK_MULTIPLE_PARENTS" || d.code === "LINK_SELF");
  return { rollups, diagnostics, leafPanelIds, treeOk };
}
