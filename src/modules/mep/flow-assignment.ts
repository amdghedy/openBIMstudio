/**
 * Model-native MEP flow assignment — terminals carry design flow, the
 * connected graph accumulates it upstream to the source, and the result
 * feeds the network audit directly from model geometry.
 *
 * Parity target: Revit's "flow" column, which is not typed by the user per
 * segment — it is derived from the terminals (diffusers, coils, fixtures)
 * and accumulated through the distribution tree. Until now our network
 * audit needed a hand-built JSON tree; this module builds that tree from
 * the *actual* model elements using the same geometry-derived connectivity
 * as connectivity.ts (no stored links, works on existing models).
 *
 * Method:
 *   1. Pairwise connectivity (areConnected) over linear runs, fittings and
 *      equipment — O(n²), fine for the run sizes of a visual audit.
 *   2. Union-find merges element endpoints that touch the same fitting /
 *      equipment / another run's end into one graph node.
 *   3. Terminal flows are read from equipment properties (`flowRate` or
 *      `designFlow`), with optional unit tags (`flowUnit`: cfm, ls, m3h,
 *      m3s, gpm). Air systems accumulate in m³/s, water systems in L/s.
 *   4. The source is the equipment marked `isSource` (or the only equipment
 *      element when exactly one exists).
 *   5. BFS from the source orients every segment upstream→downstream for
 *      the audit; unreachable or looped parts are reported, not guessed.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

import { areConnected, isMepElement, LINEAR_MEP, linearEnds, pointTouches, type MepLike, type Pt3 } from "./connectivity";
import { auditNetwork, isAirSystem } from "./network";
import type { NetworkSegmentInput, NetworkAuditReport, AuditOptions } from "./network";
import type { MepSystem } from "./types";

const SYSTEMS: readonly MepSystem[] = [
  "supply-air", "return-air", "exhaust-air", "outside-air",
  "chilled-water", "hot-water", "domestic-cold", "domestic-hot",
  "sanitary", "condensate", "gas", "medical-vacuum", "medical-oxygen",
  "sprinkler", "cable-tray", "conduit",
];

const DEFAULT_SYSTEM_BY_TYPE: Record<string, MepSystem> = {
  duct: "supply-air",
  pipe: "domestic-cold",
};

/** Convert a flow value tagged with a unit to the system's native unit. */
export function normalizeFlow(value: number, unit: string | undefined, air: boolean): number {
  const v = value; // native when unit missing or matches native
  switch ((unit ?? "").toLowerCase()) {
    case "": case "native": case air ? "m3s" : "ls": return v;
    case "cfm": return v / 2118.88;         // CFM → m³/s
    case "m3h": return v / 3600;            // m³/h → m³/s
    case "m3s": return v;                   // m³/s → m³/s
    case "gpm": return v * 0.06309;         // GPM → L/s
    case "lpm": return v / 60;              // L/min → L/s
    case "ls": return v;                    // L/s → L/s
    default: return v;
  }
}

function propNumber(el: MepLike, keys: string[]): number | null {
  for (const k of keys) {
    const raw = el.properties?.[k];
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function ends3(e: MepLike): [Pt3, Pt3] | null {
  if (LINEAR_MEP.has(e.type)) return linearEnds(e);
  return null;
}

function dist3(a: Pt3, b: Pt3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ── Union-find over element endpoints ────────────────────────────────────

class DSU {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path compression
    let cur = x;
    while (this.parent.get(cur) && this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  ensure(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
}

export interface FlowBuildResult {
  segments: NetworkSegmentInput[];
  terminals: Record<string, number>;
  sourceNodeId: string;
  /** Node ids (equipment roots) with a terminal flow, for reporting. */
  terminalNodeIds: string[];
  warnings: string[];
}

export interface FlowBuildOptions {
  /** Explicit source element id; overrides the isSource/only-equipment rules. */
  sourceElementId?: string;
}

/**
 * Build the audit-ready network (segments + terminals + source) from raw
 * model elements. Throws when no source can be determined or when the
 * linear runs mix systems that cannot share one audit.
 */
export function buildNetworkFromElements(elements: MepLike[], options: FlowBuildOptions = {}): FlowBuildResult {
  const mep = elements.filter((e) => isMepElement(e));
  if (mep.length === 0) throw new Error("No MEP elements in the selection — nothing to audit.");
  const warnings: string[] = [];

  const linears = mep.filter((e) => LINEAR_MEP.has(e.type));
  const others = mep.filter((e) => !LINEAR_MEP.has(e.type));
  if (linears.length === 0) throw new Error("No duct/pipe runs in the selection — nothing to audit.");

  // One system per audit, resolved per the first linear element.
  const rawSystem = String(linears[0].properties?.system ?? "") as MepSystem;
  const system = SYSTEMS.includes(rawSystem) ? rawSystem : DEFAULT_SYSTEM_BY_TYPE[linears[0].type];
  if (!system) {
    throw new Error(
      `Segment '${linears[0].id}' has no system classification — set properties.system ` +
      `(one of ${SYSTEMS.join(", ")}).`,
    );
  }
  for (const l of linears) {
    const s = String(l.properties?.system ?? "") as MepSystem;
    const resolved = SYSTEMS.includes(s) ? s : DEFAULT_SYSTEM_BY_TYPE[l.type];
    if (resolved !== system) {
      throw new Error(`Mixed systems ('${system}' on '${linears[0].id}' vs '${resolved}' on '${l.id}') — audit one system at a time.`);
    }
  }
  const air = isAirSystem(system);

  // ── Connectivity graph + union-find over endpoints ──
  const dsu = new DSU();
  const endpointKey = (id: string, end: "start" | "end") => `node:${id}:${end}`;
  for (const e of mep) {
    dsu.ensure(e.type === "fitting" || e.type === "equipment" ? e.id : endpointKey(e.id, "start"));
    if (LINEAR_MEP.has(e.type)) dsu.ensure(endpointKey(e.id, "end"));
  }
  const endOf = (e: MepLike, pt: Pt3): "start" | "end" => {
    const ends = ends3(e)!;
    return dist3(pt, ends[0]) <= dist3(pt, ends[1]) ? "start" : "end";
  };
  const touchPoint = (a: MepLike, b: MepLike): Pt3 | null => {
    // Which point of `a` touches `b`? (linear ends first, then element anchor)
    const aEnds = ends3(a);
    if (aEnds) {
      if (aEnds[0] && areConnectedPoint(aEnds[0], b)) return aEnds[0];
      if (aEnds[1] && areConnectedPoint(aEnds[1], b)) return aEnds[1];
    }
    const anchor = aEnds ? aEnds[0] : anchorOf(a);
    return anchor && areConnectedPoint(anchor, b) ? anchor : null;
  };
  const areConnectedPoint = (pt: Pt3, e: MepLike): boolean => {
    // pointTouches from connectivity is the geometry gate.
    return pointTouchesSafe(pt, e);
  };
  for (let i = 0; i < mep.length; i++) {
    for (let j = i + 1; j < mep.length; j++) {
      const a = mep[i], b = mep[j];
      if (!areConnected(a, b)) continue;
      const pa = touchPoint(a, b);
      const pb = touchPoint(b, a);
      if (pa && ends3(a) && pb && ends3(b)) {
        // two runs end-to-end: merge the touching endpoints
        dsu.union(endpointKey(a.id, endOf(a, pa)), endpointKey(b.id, endOf(b, pb)));
      } else if (pa && ends3(a)) {
        // run end touches a fitting / equipment node
        dsu.union(endpointKey(a.id, endOf(a, pa)), b.id);
      } else if (pb && ends3(b)) {
        dsu.union(endpointKey(b.id, endOf(b, pb)), a.id);
      } else {
        // fitting/equipment adjacency: merge anchors directly
        dsu.union(a.id, b.id);
      }
    }
  }

  // ── Segments ──
  const segments: NetworkSegmentInput[] = [];
  for (const l of linears) {
    const ends = ends3(l)!;
    const len = dist3(ends[0], ends[1]);
    if (len < 1e-6) { warnings.push(`Segment '${l.id}' has zero length — skipped.`); continue; }
    const fromRoot = dsu.find(endpointKey(l.id, "start"));
    const toRoot = dsu.find(endpointKey(l.id, "end"));
    if (fromRoot === toRoot) { warnings.push(`Segment '${l.id}' loops back onto itself — skipped.`); continue; }
    const seg: NetworkSegmentInput = {
      id: l.id, from: fromRoot, to: toRoot, lengthM: Math.round(len * 1000) / 1000, system,
    };
    if (l.type === "pipe" || l.type === "conduit") seg.diameter = l.params.thickness;
    else if (l.type === "duct") { seg.width = l.params.thickness; seg.height = l.params.height; }
    segments.push(seg);
  }
  if (segments.length === 0) throw new Error("Every run in the selection was skipped (zero length / looped).");

  // ── Terminals (equipment with design flow) ──
  const terminals: Record<string, number> = {};
  const terminalNodeIds: string[] = [];
  for (const e of others) {
    const flow = propNumber(e, ["flowRate", "designFlow", "designFlowRate"]);
    if (flow == null || flow === 0) continue;
    const node = dsu.find(e.id);
    terminals[node] = (terminals[node] ?? 0) + normalizeFlow(flow, String(e.properties?.flowUnit ?? ""), air);
    terminalNodeIds.push(node);
  }

  // ── Source selection ──
  const equipment = others.filter((e) => e.type === "equipment");
  const marked = equipment.filter((e) => e.properties?.isSource === true || e.properties?.role === "source");
  let sourceEl: MepLike | undefined;
  if (options.sourceElementId) {
    sourceEl = equipment.find((e) => e.id === options.sourceElementId)
      ?? mep.find((e) => e.id === options.sourceElementId);
    if (!sourceEl) throw new Error(`Source element '${options.sourceElementId}' not found among the selection.`);
  } else if (marked.length === 1) {
    sourceEl = marked[0];
  } else if (marked.length > 1) {
    throw new Error(`${marked.length} elements are marked as source (${marked.map((e) => e.id).join(", ")}) — mark exactly one or pass sourceElementId.`);
  } else if (equipment.length === 1) {
    sourceEl = equipment[0];
  }
  if (!sourceEl) {
    throw new Error(
      "No source determined — mark the AHU / pump / main with properties.isSource = true " +
      "or pass sourceElementId.",
    );
  }
  const sourceNodeId = dsu.find(sourceEl.id);
  // Report equipment that will silently contribute nothing to the flows.
  for (const e of equipment) {
    if (e.id === sourceEl.id) continue;
    const flow = propNumber(e, ["flowRate", "designFlow", "designFlowRate"]);
    if (flow == null || flow === 0) {
      warnings.push(`Equipment '${e.id}' has no design flow — set properties.flowRate so it feeds the accumulation.`);
    }
  }

  // ── Orientation: BFS from the source ──
  const adjacency = new Map<string, Array<{ other: string; seg: NetworkSegmentInput }>>();
  for (const s of segments) {
    if (!adjacency.has(s.from)) adjacency.set(s.from, []);
    if (!adjacency.has(s.to)) adjacency.set(s.to, []);
    adjacency.get(s.from)!.push({ other: s.to, seg: s });
    adjacency.get(s.to)!.push({ other: s.from, seg: s });
  }
  const dist = new Map<string, number>([[sourceNodeId, 0]]);
  const queue: string[] = [sourceNodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { other } of adjacency.get(cur) ?? []) {
      if (!dist.has(other)) { dist.set(other, dist.get(cur)! + 1); queue.push(other); }
    }
  }
  for (const s of segments) {
    const df = dist.get(s.from) ?? Infinity;
    const dt = dist.get(s.to) ?? Infinity;
    if (df === Infinity && dt === Infinity) {
      warnings.push(`Segment '${s.id}' is not connected to the source — excluded from the audit.`);
      continue;
    }
    if (df === dt) {
      warnings.push(`Segment '${s.id}' sits on a loop — orientation is ambiguous; audit treats it as from→to as drawn.`);
    } else if (dt < df) {
      // swap so `from` is always the upstream (closer to source) node
      const t = s.from; s.from = s.to; s.to = t;
    }
  }
  const oriented = segments.filter((s) => (dist.get(s.from) ?? Infinity) !== Infinity);
  if (oriented.length === 0) throw new Error("No segment connects to the source — check the selection.");

  return { segments: oriented, terminals, sourceNodeId, terminalNodeIds, warnings };
}

function anchorOf(e: MepLike): Pt3 | null {
  const p = e.params;
  if (p.point) return { x: p.point[0], y: p.elevation, z: p.point[1] };
  return null;
}

function pointTouchesSafe(pt: Pt3, e: MepLike): boolean {
  try { return pointTouches(pt, e); } catch { return false; }
}

export interface AuditFromModelOptions extends AuditOptions, FlowBuildOptions {}

/**
 * One call: build from model elements and run the full network audit
 * (Revit System Inspector / Pressure Loss Report parity, model-native).
 */
export function auditFromModel(elements: MepLike[], options: AuditFromModelOptions = {}): NetworkAuditReport & { modelWarnings: string[] } {
  const build = buildNetworkFromElements(elements, { sourceElementId: options.sourceElementId });
  const report = auditNetwork(build.segments, build.terminals, build.sourceNodeId, options);
  return { ...report, modelWarnings: build.warnings };
}
