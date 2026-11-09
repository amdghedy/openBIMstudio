/**
 * Model-native MEP network audit — flow accumulation, section auto-sizing,
 * per-section pressure losses, critical path and equipment duty.
 *
 * This is the parity item for Revit's System Inspector / Duct & Pipe
 * Pressure Loss Report / Auto-Size: it walks the *actual* distribution
 * tree of the model (segments between nodes), accumulates the design flow
 * from the terminals upstream to the source, sizes or checks every
 * section, computes every section's pressure loss with the same physics
 * as pressure.ts, finds the critical path, and derives the fan/pump duty.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Flow units follow the module convention:
 *   - Air systems (supply/return/exhaust/outside-air): m³/s
 *   - Water/gas/medical/sprinkler systems: L/s
 */

import { sizeForSystem, MAX_VELOCITY } from "./sizing";
import { sizeByFriction } from "./sizing-methods";
import {
  ductPressureDrop, pipePressureDrop, worstPath, FLUID,
} from "./pressure";
import type { SegmentFitting, RoughnessMaterial, PressureResult } from "./pressure";
import { elementTypeFor } from "./types";
import type { MepSystem, MepSize } from "./types";
import { fanSelection, pumpSelection } from "./equipment";
import type { FanSelectionResult, PumpSelectionResult } from "./equipment";

const AIR_SYSTEMS = new Set<MepSystem>(["supply-air", "return-air", "exhaust-air", "outside-air"]);

export const isAirSystem = (s: MepSystem): boolean => AIR_SYSTEMS.has(s);

export interface NetworkSegmentInput {
  id: string;
  /** Upstream node id (towards the source). */
  from: string;
  /** Downstream node id. */
  to: string;
  /** Section length (m). */
  lengthM: number;
  system: MepSystem;
  /** Existing round size (m). Provide diameter or width+height. */
  diameter?: number;
  width?: number;
  height?: number;
  material?: RoughnessMaterial;
  fittings?: SegmentFitting[];
}

export interface AuditOptions {
  /** Sizing method for sections that need one. Default "velocity". */
  method?: "velocity" | "friction";
  /** Friction target (Pa/m) for the friction method. Default 0.8 duct / 150 pipe. */
  targetFrictionPaM?: number;
  /** Re-size sections whose velocity exceeds the system cap. Default true. */
  resizeUndersized?: boolean;
  /** Fan/pump safety factor (default 1.1). */
  safetyFactor?: number;
  /** Static lift for pumps (m). */
  staticLiftM?: number;
  /** Required residual head at the most remote terminal (m, pumps). */
  terminalResidualHeadM?: number;
  /** Fan discharge velocity (m/s). */
  exitVelocityMs?: number;
}

export interface SegmentAuditRow {
  id: string;
  from: string;
  to: string;
  /** Accumulated design flow, in the system's native unit (m³/s air, L/s water). */
  flowNative: number;
  /** Accumulated design flow in m³/s (what the physics uses). */
  flowM3s: number;
  /** Final cross-section used (m). */
  size: MepSize;
  /** True when this audit re-sized the section. */
  resized: boolean;
  /** True when no size existed and the auditor created one. */
  sizedNow: boolean;
  velocity: number;
  /** Specific friction rate (Pa/m). */
  frictionRatePaM: number;
  /** Total section pressure loss (Pa), friction + fittings. */
  dpTotal: number;
  warnings: string[];
}

export interface NetworkAuditReport {
  system: MepSystem;
  /** Segment rows in input order. */
  rows: SegmentAuditRow[];
  /** Total design flow at the source, native unit. */
  sourceFlowNative: number;
  /** Critical-path segment ids (highest total drop source→sink). */
  criticalPathSegmentIds: string[];
  /** Critical-path node ids. */
  criticalPathNodeIds: string[];
  /** Total pressure drop along the critical path (Pa). */
  worstPathDpPa: number;
  /** Fan duty (air systems). */
  fan: FanSelectionResult | null;
  /** Pump duty (water systems). */
  pump: PumpSelectionResult | null;
  /** Network-level diagnostics (cycles, unknown nodes, missing demands…). */
  diagnostics: string[];
  warnings: string[];
}

interface FlowNode {
  id: string;
  terminalFlowNative: number;
  incoming: NetworkSegmentInput[];
  outgoing: NetworkSegmentInput[];
}

function segmentArea(seg: NetworkSegmentInput): number {
  if (seg.diameter && seg.diameter > 0) return (Math.PI * seg.diameter * seg.diameter) / 4;
  if (seg.width && seg.height && seg.width > 0 && seg.height > 0) return seg.width * seg.height;
  return 0;
}

function segmentPressure(
  seg: NetworkSegmentInput, size: MepSize, flowM3s: number,
): PressureResult {
  if (isAirSystem(seg.system)) {
    return ductPressureDrop({
      length: seg.lengthM,
      flow: flowM3s,
      width: size.thickness,
      height: size.height,
      material: seg.material,
      fittings: seg.fittings,
    });
  }
  return pipePressureDrop({
    length: seg.lengthM,
    flow: flowM3s,
    diameter: size.thickness,
    material: seg.material,
    fittings: seg.fittings,
  });
}

/**
 * Audit a distribution tree: accumulate flows, size/check every section,
 * compute losses, find the critical path and derive the equipment duty.
 *
 * `terminals` maps node ids to their design demand in the system's native
 * unit (m³/s for air, L/s for water). Non-source nodes with no demand and
 * no downstream demand produce a diagnostic.
 */
export function auditNetwork(
  segments: NetworkSegmentInput[],
  terminals: Record<string, number>,
  sourceNodeId: string,
  opts: AuditOptions = {},
): NetworkAuditReport {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("segments must be a non-empty array");
  }
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  const system = segments[0].system;
  const air = isAirSystem(system);
  for (const s of segments) {
    if (s.system !== system) throw new Error(`All segments must share one system for a single audit (found '${s.system}' on '${s.id}' vs '${system}').`);
    if (!(s.lengthM >= 0)) throw new Error(`Segment '${s.id}' length must be non-negative`);
  }

  // ── Topology ────────────────────────────────────────────────────────────
  const nodes = new Map<string, FlowNode>();
  const nodeOf = (id: string): FlowNode => {
    let n = nodes.get(id);
    if (!n) { n = { id, terminalFlowNative: 0, incoming: [], outgoing: [] }; nodes.set(id, n); }
    return n;
  };
  for (const [id, demand] of Object.entries(terminals)) {
    if (!Number.isFinite(demand) || demand < 0) throw new Error(`Terminal demand at '${id}' must be finite and non-negative`);
    nodeOf(id).terminalFlowNative = demand;
  }
  for (const s of segments) {
    const a = nodeOf(s.from), b = nodeOf(s.to);
    a.outgoing.push(s);
    b.incoming.push(s);
  }
  if (!nodes.has(sourceNodeId)) throw new Error(`Source node '${sourceNodeId}' does not appear in the network`);
  const source = nodes.get(sourceNodeId)!;
  if (source.incoming.length > 0) {
    diagnostics.push(`Source node '${sourceNodeId}' has ${source.incoming.length} incoming segment(s) — a distribution source should only feed outward.`);
  }

  // Cycle guard + reachability (iterative DFS, stack-based).
  const reachFlow = new Map<string, number>(); // segment id → accumulated native flow
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const accumulate = (node: FlowNode): number => {
    if (visited.has(node.id)) return 0;
    if (visiting.has(node.id)) {
      diagnostics.push(`Cycle detected through node '${node.id}' — distribution trees must be acyclic; flows downstream of the cycle are not accumulated.`);
      return 0;
    }
    visiting.add(node.id);
    let total = node.terminalFlowNative;
    for (const out of node.outgoing) {
      total += accumulate(nodes.get(out.to)!);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    // Store the flow on every incoming segment of this node: a segment
    // carries its downstream subtree's demand.
    for (const inc of node.incoming) reachFlow.set(inc.id, total);
    return total;
  };
  const sourceTotal = accumulate(source);
  if (sourceTotal <= 0) diagnostics.push("Total demand at the source is zero — check the terminal demands.");

  // Segments that never received a flow are unreachable from the source.
  for (const s of segments) {
    if (!reachFlow.has(s.id)) {
      diagnostics.push(`Segment '${s.id}' is not reachable from source '${sourceNodeId}' — excluded from the audit.`);
    }
  }
  // Non-source, non-terminal nodes with neither demand nor downstream demand.
  for (const n of nodes.values()) {
    if (n.id === sourceNodeId) continue;
    if (!terminals[n.id] && n.outgoing.length === 0) {
      diagnostics.push(`Terminal node '${n.id}' has no demand — add it to 'terminals'.`);
    }
  }

  // ── Sizing + hydraulics per reachable segment ───────────────────────────
  const rows: SegmentAuditRow[] = [];
  const auditOpts = opts;
  for (const seg of segments) {
    const flowNative = reachFlow.get(seg.id);
    if (flowNative == null) continue;
    const flowM3s = air ? flowNative : flowNative / 1000;

    let size: MepSize | null = null;
    let resized = false;
    let sizedNow = false;
    const segWarnings: string[] = [];

    const existingArea = segmentArea(seg);
    if (existingArea > 0) {
      const velocity = flowM3s / existingArea;
      const cap = MAX_VELOCITY[system];
      const needsResize = (auditOpts.resizeUndersized ?? true) && cap > 0 && velocity > cap;
      if (!needsResize) {
        size = {
          thickness: seg.diameter ?? seg.width ?? 0,
          height: seg.diameter ?? seg.height ?? 0,
          velocity, area: existingArea,
          rule: "existing model size",
        };
      } else {
        segWarnings.push(`Existing size runs at ${velocity.toFixed(2)} m/s — above the ${cap} m/s cap; re-sizing.`);
      }
    } else {
      sizedNow = true;
      segWarnings.push("No size on the model section — sized from the accumulated flow.");
    }

    if (!size) {
      resized = sizedNow;
      if (auditOpts.method === "friction") {
        const r = sizeByFriction(system, air ? flowM3s : flowNative, auditOpts.targetFrictionPaM);
        if (r.kind === "duct") {
          size = {
            thickness: r.result.thickness, height: r.result.height,
            velocity: r.result.velocity, area: r.result.area, rule: r.result.rule,
          };
        } else {
          const area = (Math.PI * r.result.diameter * r.result.diameter) / 4;
          size = {
            thickness: r.result.diameter, height: r.result.diameter,
            velocity: r.result.velocity, area, rule: r.result.rule,
          };
        }
        segWarnings.push(...r.result.warnings);
      } else {
        const r = sizeForSystem(system, air ? flowM3s : flowNative);
        size = r.size;
        segWarnings.push(...r.warnings);
      }
      if (!sizedNow) resized = true;
    }

    const pr = segmentPressure(seg, size, flowM3s);
    if (pr.velocity > MAX_VELOCITY[system] && MAX_VELOCITY[system] > 0) {
      segWarnings.push(`Velocity ${pr.velocity.toFixed(2)} m/s exceeds the ${MAX_VELOCITY[system]} m/s cap for ${system}.`);
    }
    rows.push({
      id: seg.id, from: seg.from, to: seg.to,
      flowNative, flowM3s,
      size, resized: resized === true, sizedNow,
      velocity: pr.velocity,
      frictionRatePaM: pr.frictionRate,
      dpTotal: pr.dpTotal,
      warnings: segWarnings,
    });
  }

  // ── Critical path + duty ────────────────────────────────────────────────
  const edges = rows.map((r) => ({ id: r.id, from: r.from, to: r.to, dp: r.dpTotal, label: r.id }));
  const wp = worstPath({ edges, source: sourceNodeId });
  const worstDp = wp.totalDp;

  let fan: FanSelectionResult | null = null;
  let pump: PumpSelectionResult | null = null;
  if (air) {
    fan = fanSelection({
      worstPathDpPa: worstDp,
      flowM3s: sourceTotal,
      exitVelocityMs: opts.exitVelocityMs,
      safetyFactor: opts.safetyFactor,
    });
  } else if (sourceTotal > 0) {
    const rho = FLUID.water.rho;
    pump = pumpSelection({
      worstPathHeadLossM: worstDp / (rho * 9.80665),
      staticLiftM: opts.staticLiftM,
      terminalResidualHeadM: opts.terminalResidualHeadM,
      flowLs: sourceTotal,
      safetyFactor: opts.safetyFactor,
    });
  }

  for (const r of rows) for (const w of r.warnings) warnings.push(`${r.id}: ${w}`);

  return {
    system,
    rows,
    sourceFlowNative: sourceTotal,
    criticalPathSegmentIds: wp.edgeIds,
    criticalPathNodeIds: wp.nodes,
    worstPathDpPa: worstDp,
    fan,
    pump,
    diagnostics,
    warnings,
  };
}

/** IFC entity hint for an audited segment's element type. */
export function ifcEntityForSystem(system: MepSystem): string {
  return elementTypeFor(system) === "duct" ? "IfcDuctSegment" : "IfcPipeSegment";
}
