/**
 * IFC MEP connectivity reconstruction — derive connected networks from an
 * imported IFC file instead of grouping by category.
 *
 * Source of truth: IfcRelConnectsPorts joins two IfcDistributionPorts, and
 * IfcRelNests nests each port under its owning distribution element
 * (IFC2x3 and IFC4 both express port ownership this way). The semantic
 * model (modules/ifc-semantics/semantic-model.ts) records both as typed
 * relationships ("connects-ports" / "nests"); this module turns them into
 * element-level clusters with a union-find.
 *
 * Honest limits, stated up front:
 *   - Only files that actually carry ports + RelConnectsPorts reconstruct.
 *     Many exporters omit ports entirely; those elements land in
 *     `unconnected` with hasPorts=false and a summary diagnostic — the
 *     module never invents connectivity from geometry here (that is the
 *     authored-model path in connectivity.ts, and imported fragments have
 *     no authored params to run it on).
 *   - System classification is NOT read from the file: IFC carries no
 *     system assignment on these entities in the general case. A cluster
 *     gets a `suggestedSystem` only as the same per-domain DEFAULT the
 *     authored tree uses for undeclared members (duct → supply-air,
 *     pipe → domestic-cold, cable tray → cable-tray), labelled
 *     `default-for-domain`. A mixed-domain cluster suggests nothing.
 *   - Port geometry (placement, direction, size) is not validated here;
 *     a declared port connection is trusted as the modeller's intent.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

import { buildSemanticModel, type SemanticModel } from "../ifc-semantics/semantic-model";
import { unquote } from "../ifc-semantics/step-reader";
import type { MepSystem } from "./types";

export type IfcMepDomain = "air" | "water" | "electrical" | "mixed" | "unknown";

const AIR_CLASSES = new Set([
  "IFCDUCTSEGMENT", "IFCDUCTFITTING", "IFCAIRTERMINAL", "IFCAIRTERMINALBOX", "IFCDAMPER",
]);
const WATER_CLASSES = new Set([
  "IFCPIPESEGMENT", "IFCPIPEFITTING", "IFCVALVE", "IFCPUMP", "IFCSANITARYTERMINAL",
]);
const ELECTRICAL_CLASSES = new Set([
  "IFCCABLECARRIERSEGMENT", "IFCCABLESEGMENT", "IFCCABLECARRIERFITTING",
  "IFCCONDUITSEGMENT", "IFCCONDUITFITTING", "IFCJUNCTIONBOX",
]);
/** Generic flow classes: MEP elements whose domain cannot be told from the class. */
const GENERIC_MEP_CLASSES = new Set([
  "IFCFLOWSEGMENT", "IFCFLOWFITTING", "IFCFLOWTERMINAL", "IFCFLOWCONTROLLER",
  "IFCFLOWMOVINGDEVICE", "IFCFLOWSTORAGEDEVICE", "IFCDISTRIBUTIONELEMENT",
]);

export const MEP_ELEMENT_CLASSES = new Set([
  ...AIR_CLASSES, ...WATER_CLASSES, ...ELECTRICAL_CLASSES, ...GENERIC_MEP_CLASSES,
]);

const DEFAULT_SYSTEM_BY_DOMAIN: Record<string, MepSystem> = {
  air: "supply-air",
  water: "domestic-cold",
  electrical: "cable-tray",
};

export interface IfcMepMember {
  expressId: number;
  cls: string;
  globalId: string | null;
  name: string | null;
  domain: IfcMepDomain;
  /** True when the element owns at least one IfcDistributionPort. */
  hasPorts: boolean;
}

export interface IfcMepCluster {
  id: string;
  members: IfcMepMember[];
  domain: IfcMepDomain;
  /**
   * Per-domain DEFAULT only (see module header) — never read from the file.
   * Null for mixed/unknown-domain clusters.
   */
  suggestedSystem: MepSystem | null;
  suggestedSystemBasis: string | null;
  diagnostics: string[];
}

export interface IfcMepReconstruction {
  clusters: IfcMepCluster[];
  /** MEP elements that take part in no reconstructed connection. */
  unconnected: IfcMepMember[];
  diagnostics: string[];
  counts: {
    mepElements: number;
    ports: number;
    portConnections: number;
    reconstructedEdges: number;
  };
}

function domainOf(cls: string): IfcMepDomain {
  if (AIR_CLASSES.has(cls)) return "air";
  if (WATER_CLASSES.has(cls)) return "water";
  if (ELECTRICAL_CLASSES.has(cls)) return "electrical";
  return "unknown";
}

export function reconstructIfcMepNetworks(model: SemanticModel): IfcMepReconstruction {
  const diagnostics: string[] = [];
  const entities = model.entities;

  // ── Port ownership (IfcRelNests: relating element → related ports) ──
  const portOwner = new Map<number, number>();
  for (const rel of model.relationships) {
    if (rel.kind !== "nests") continue;
    if (rel.relating == null || !entities.has(rel.relating)) {
      diagnostics.push(`IfcRelNests #${rel.id} references a missing owning element.`);
      continue;
    }
    for (const portId of rel.related) {
      const port = entities.get(portId);
      if (!port || port.name !== "IFCDISTRIBUTIONPORT") continue;
      const prev = portOwner.get(portId);
      if (prev != null && prev !== rel.relating) {
        diagnostics.push(`Port #${portId} is nested under two owners (#${prev} and #${rel.relating}) — first owner kept.`);
        continue;
      }
      portOwner.set(portId, rel.relating);
    }
  }

  // ── MEP element index ──
  const members = new Map<number, IfcMepMember>();
  for (const [id, e] of entities) {
    if (!MEP_ELEMENT_CLASSES.has(e.name)) continue;
    members.set(id, {
      expressId: id,
      cls: e.name,
      globalId: model.globalIds.get(id) ?? null,
      name: unquote(e.args[2]) ?? null,
      domain: domainOf(e.name),
      hasPorts: false,
    });
  }
  for (const ownerId of portOwner.values()) {
    const m = members.get(ownerId);
    if (m) m.hasPorts = true;
  }
  const portCount = [...entities.values()].filter((e) => e.name === "IFCDISTRIBUTIONPORT").length;

  // ── Union-find over port edges (IfcRelConnectsPorts) ──
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const id of members.keys()) parent.set(id, id);

  let portConnections = 0;
  let reconstructedEdges = 0;
  for (const rel of model.relationships) {
    if (rel.kind !== "connects-ports") continue;
    const portA = rel.relating;
    if (portA == null) {
      diagnostics.push(`IfcRelConnectsPorts #${rel.id} has no relating port.`);
      continue;
    }
    for (const portB of rel.related) {
      portConnections++;
      const aEnt = entities.get(portA);
      const bEnt = entities.get(portB);
      if (!aEnt || aEnt.name !== "IFCDISTRIBUTIONPORT") {
        diagnostics.push(`IfcRelConnectsPorts #${rel.id} references missing or non-port relating #${portA}.`);
        continue;
      }
      if (!bEnt || bEnt.name !== "IFCDISTRIBUTIONPORT") {
        diagnostics.push(`IfcRelConnectsPorts #${rel.id} references missing or non-port related #${portB}.`);
        continue;
      }
      const ownerA = portOwner.get(portA);
      const ownerB = portOwner.get(portB);
      if (ownerA == null || ownerB == null) {
        const missing = [ownerA == null ? `#${portA}` : null, ownerB == null ? `#${portB}` : null].filter(Boolean).join(", ");
        diagnostics.push(`IfcRelConnectsPorts #${rel.id} joins port(s) with no owning element (${missing}) — edge ignored.`);
        continue;
      }
      if (!members.has(ownerA) || !members.has(ownerB)) {
        diagnostics.push(`IfcRelConnectsPorts #${rel.id} joins ports owned by non-MEP elements (#${ownerA}, #${ownerB}) — edge ignored.`);
        continue;
      }
      if (ownerA === ownerB) {
        diagnostics.push(`IfcRelConnectsPorts #${rel.id} connects element #${ownerA} to itself — edge ignored.`);
        continue;
      }
      union(ownerA, ownerB);
      reconstructedEdges++;
    }
  }

  // ── Clusters ──
  const groups = new Map<number, number[]>();
  for (const id of members.keys()) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  }
  const roots = [...groups.keys()].sort((a, b) => a - b);
  const clusters: IfcMepCluster[] = [];
  const unconnected: IfcMepMember[] = [];
  let n = 0;
  for (const root of roots) {
    const ids = (groups.get(root) ?? []).sort((a, b) => a - b);
    const ms = ids.map((id) => members.get(id)!);
    // A cluster of one element with no edges is unconnected, not a system.
    if (ids.length === 1) {
      unconnected.push(...ms);
      continue;
    }
    n++;
    const domains = new Set(ms.map((mm) => mm.domain).filter((d) => d !== "unknown"));
    let domain: IfcMepDomain;
    const cdiags: string[] = [];
    if (domains.size === 0) domain = "unknown";
    else if (domains.size === 1) domain = [...domains][0] as IfcMepDomain;
    else {
      domain = "mixed";
      cdiags.push(
        `Cluster mixes domains (${[...domains].join(", ")}) — no system suggested; check the port connections.`,
      );
    }
    const suggestedSystem = domain === "air" || domain === "water" || domain === "electrical"
      ? DEFAULT_SYSTEM_BY_DOMAIN[domain]
      : null;
    clusters.push({
      id: `ifc-mep-${n}`,
      members: ms,
      domain,
      suggestedSystem,
      suggestedSystemBasis: suggestedSystem
        ? "default-for-domain: same per-domain default the authored system tree uses for undeclared members; not read from the file"
        : null,
      diagnostics: cdiags,
    });
  }

  const withoutPorts = unconnected.filter((mm) => !mm.hasPorts).length;
  if (withoutPorts > 0) {
    diagnostics.push(
      `${withoutPorts} MEP element(s) carry no IfcDistributionPort — connectivity cannot be reconstructed for them; ` +
      `export ports (IfcDistributionPort + IfcRelConnectsPorts) to make them reconstructable.`,
    );
  }

  return {
    clusters,
    unconnected: unconnected.sort((a, b) => a.expressId - b.expressId),
    diagnostics,
    counts: {
      mepElements: members.size,
      ports: portCount,
      portConnections,
      reconstructedEdges,
    },
  };
}

/** Convenience: parse STEP text and reconstruct in one call. */
export function reconstructFromStepText(text: string): IfcMepReconstruction {
  return reconstructIfcMepNetworks(buildSemanticModel(text));
}
