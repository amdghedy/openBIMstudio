/**
 * MEP System Browser tree — named systems derived from real model connectivity.
 *
 * The old System Browser grouped elements by IFC category regex and showed
 * counts: every duct was "Supply Air" whether or not it touched anything,
 * two disconnected runs looked like one system, and unconnected elements
 * were invisible. This module builds the tree the way a system browser
 * should: it pairs the geometry-derived connectivity of connectivity.ts
 * with a union-find so every connected cluster becomes ONE named system,
 * equipment elements head the member list, isolated elements are reported
 * as unconnected, and system classification resolves in a fixed order:
 *
 *   1. Declared `properties.system` values on members. Exactly one distinct
 *      declared system → the cluster takes it. TWO OR MORE distinct
 *      declared systems in one connected cluster is a MODELLING ERROR:
 *      the cluster is reported as a system conflict (system null,
 *      label "System Conflict N", conflicts + diagnostics naming the
 *      offending members) and is NOT silently resolved by majority vote.
 *      A connected run cannot carry two systems; the modeller must
 *      re-classify or disconnect before the system can be audited.
 *   2. Dominant linear member type — duct → supply-air, pipe → domestic-cold,
 *      cable-tray → cable-tray, conduit → conduit (the same defaults
 *      flow-assignment uses; tie → earliest). This is a DEFAULT HEURISTIC
 *      for undeclared members only, not a resolution of declared systems.
 *   3. Dominant fitting `parentType` through the same mapping (clusters made
 *      only of fittings).
 *   4. Otherwise null — the cluster renders as "Unclassified N".
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Connectivity pairs come from the grid index in connectivity.ts
 * (connectedPairs — exactly the old O(n²) scan, pruned); the tree build
 * itself is union-find over those pairs.
 */

import { connectedPairs, isMepElement, LINEAR_MEP, type MepLike } from "./connectivity";
import type { MepSystem } from "./types";

/** Human labels for every typed system (browser + tests share this). */
export const MEP_SYSTEM_LABELS: Record<MepSystem, string> = {
  "supply-air": "Supply Air",
  "return-air": "Return Air",
  "exhaust-air": "Exhaust Air",
  "outside-air": "Outside Air",
  "chilled-water": "Chilled Water",
  "hot-water": "Hot Water",
  "domestic-cold": "Domestic Cold Water",
  "domestic-hot": "Domestic Hot Water",
  "sanitary": "Sanitary",
  "condensate": "Condensate",
  "gas": "Gas",
  "medical-vacuum": "Medical Vacuum",
  "medical-oxygen": "Medical Oxygen",
  "sprinkler": "Sprinkler",
  "cable-tray": "Cable Tray",
  "conduit": "Conduit",
};

const KNOWN_SYSTEMS: ReadonlySet<string> = new Set(Object.keys(MEP_SYSTEM_LABELS));

/** Default system per linear element type (mirrors flow-assignment defaults). */
const DEFAULT_SYSTEM_BY_TYPE: Record<string, MepSystem> = {
  duct: "supply-air",
  pipe: "domestic-cold",
  "cable-tray": "cable-tray",
  conduit: "conduit",
};

export interface MepSystemCluster {
  /** Stable id: `${system ?? "unclassified"}-${sequence}`; conflicts use `system-conflict-${sequence}`. */
  id: string;
  /** Resolved system; null when nothing in the cluster classifies it, or when the cluster is a system conflict. */
  system: MepSystem | null;
  /** Human label with per-system sequence, e.g. "Supply Air 1". Conflicts render as "System Conflict N". */
  label: string;
  /** Member element ids — equipment heads first, then linear, then fittings. */
  memberIds: string[];
  /** True when this cluster is a single isolated element. */
  unconnected: boolean;
  /**
   * Distinct DECLARED systems found in this connected cluster. Non-empty
   * (≥2 entries) exactly when the cluster is a system conflict: two or
   * more declared systems were physically connected and the cluster was
   * rejected rather than resolved by majority vote.
   */
  conflicts: MepSystem[];
  /** Human-readable diagnostics for this cluster (empty when healthy). */
  diagnostics: string[];
  /**
   * Stable instance id for this system (e.g. "mep-sys-3"), present only
   * when the tree was computed with a MepSystemRegistry. It survives
   * refreshes and model edits: the registry reuses the id stamped on
   * member properties, so a system keeps its name ("Supply Air 1") instead
   * of renumbering per refresh. Null for conflicts (rejected clusters get
   * no persistent identity) and when no registry was supplied.
   */
  persistentId: string | null;
}

export interface MepSystemTree {
  clusters: MepSystemCluster[];
  /** Clusters with exactly one member. */
  unconnectedCount: number;
  /** Clusters rejected as mixed-system conflicts. */
  conflictCount: number;
  /** Number of MEP elements considered (non-MEP input is ignored). */
  totalMep: number;
}

type MemberKind = "equipment" | "linear" | "fitting";

function memberKind(e: MepLike): MemberKind {
  if (e.type === "equipment") return "equipment";
  if (LINEAR_MEP.has(e.type)) return "linear";
  return "fitting";
}

const KIND_ORDER: Record<MemberKind, number> = { equipment: 0, linear: 1, fitting: 2 };

/** Valid properties.system values on a member, in input order. */
function declaredSystems(e: MepLike): MepSystem[] {
  const raw = e.properties?.system;
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  const out: MepSystem[] = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (KNOWN_SYSTEMS.has(s)) out.push(s as MepSystem);
  }
  return out;
}

/**
 * Majority vote over values with counts, tie broken by the earliest
 * position at which each candidate value first appears. Pure + stable.
 */
function majorityByFirstAppearance(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  const firstAt = new Map<string, number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (!firstAt.has(v)) firstAt.set(v, i);
  }
  let best: string | null = null;
  let bestCount = 0;
  let bestFirst = Infinity;
  for (const [v, c] of counts) {
    const f = firstAt.get(v) ?? Infinity;
    if (c > bestCount || (c === bestCount && f < bestFirst)) {
      best = v;
      bestCount = c;
      bestFirst = f;
    }
  }
  return best;
}

function systemForLinearType(type: string): MepSystem | null {
  return DEFAULT_SYSTEM_BY_TYPE[type] ?? null;
}

// ── Persisted named systems ───────────────────────────────────────────────
//
// Problem: cluster names were derived per refresh ("Supply Air 1, 2, …"),
// so adding one duct renumbered every system in the browser. The fix is a
// small stateful registry plus stamps on the elements themselves:
//
//   - computeMepSystemTree(elements, { registry }) reuses the
//     `properties.mepSystemId` / `properties.mepSystemName` stamped on any
//     member (the id is the identity, the name is the display label).
//   - stampSystemNames(elements, tree) writes the assignment back onto
//     member properties. Properties serialize with the element at project
//     save (src/modules/projects/projects.ts: `current.elements =
//     getElements()`), so names survive reload — the same mechanism
//     `properties.system` already relies on. Stamping happens on render;
//     it rides along with the next save and never marks the project dirty
//     by itself.
//   - A compute+stamp pair is the unit of work: the registry mints fresh
//     names for unstamped clusters and remembers its counters, so a second
//     compute without an intervening stamp would mint a new name. Callers
//     must stamp after every compute (system-browser.ts does).
//   - Joining two formerly separate named systems keeps the earliest
//     member's name and reports the merge as a diagnostic; the retired
//     name is overwritten on the next stamp. Re-classifying a member to a
//     different system invalidates its old stamp (a "Supply Air 1" stamp
//     never follows a cluster that now resolves to return-air).
//   - Conflict clusters get no persistent identity.

export interface MepSystemAssignment {
  id: string;
  name: string;
  /** Set when the cluster merged two formerly separate named systems. */
  mergeNote: string | null;
}

export interface MepSystemTreeOptions {
  registry?: MepSystemRegistry;
}

const STAMPED_ID_RE = /^mep-sys-(\d+)$/;

function stampedAssignment(e: MepLike): { id: string; name: string } | null {
  const id = e.properties?.mepSystemId;
  const name = e.properties?.mepSystemName;
  if (typeof id !== "string" || !STAMPED_ID_RE.test(id)) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  return { id, name: name.trim() };
}

/** System key a stamped display name belongs to, or null when it matches none. */
function systemKeyForName(name: string): string | null {
  for (const [sys, label] of Object.entries(MEP_SYSTEM_LABELS)) {
    const m = name.match(new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " (\\d+)$"));
    if (m) return sys;
  }
  if (/^Unclassified (\d+)$/.test(name)) return "unclassified";
  return null;
}

export class MepSystemRegistry {
  private nextGlobal = 1;
  private nextByKey = new Map<string, number>();

  /** Raise counters past every stamped id/name in the input (never lowers). */
  seedFrom(elements: MepLike[]): void {
    for (const e of elements) {
      const stamp = stampedAssignment(e);
      if (!stamp) continue;
      const g = STAMPED_ID_RE.exec(stamp.id);
      if (g) this.nextGlobal = Math.max(this.nextGlobal, Number(g[1]) + 1);
      const key = systemKeyForName(stamp.name);
      if (key) {
        const n = Number(stamp.name.split(" ").pop());
        if (Number.isFinite(n)) this.nextByKey.set(key, Math.max(this.nextByKey.get(key) ?? 1, n + 1));
      }
    }
  }

  assignFor(members: MepLike[], system: MepSystem | null, conflicts: MepSystem[]): MepSystemAssignment | null {
    if (conflicts.length > 0) return null;
    const key = system ?? "unclassified";
    // Reuse a stamp only when it still names THIS system.
    const stamped: Array<{ id: string; name: string }> = [];
    for (const m of members) {
      const s = stampedAssignment(m);
      if (s && systemKeyForName(s.name) === key && !stamped.some((x) => x.id === s.id)) stamped.push(s);
    }
    if (stamped.length === 1) return { id: stamped[0].id, name: stamped[0].name, mergeNote: null };
    if (stamped.length > 1) {
      const retired = stamped.slice(1).map((s) => s.name).join(", ");
      return {
        id: stamped[0].id,
        name: stamped[0].name,
        mergeNote: `Merged formerly separate systems (${retired}) into '${stamped[0].name}' — keeping '${stamped[0].name}'.`,
      };
    }
    const n = this.nextByKey.get(key) ?? 1;
    this.nextByKey.set(key, n + 1);
    const name = system ? `${MEP_SYSTEM_LABELS[system]} ${n}` : `Unclassified ${n}`;
    return { id: `mep-sys-${this.nextGlobal++}`, name, mergeNote: null };
  }
}

/**
 * Write a computed tree's persistent assignments back onto member element
 * properties (`properties.mepSystemId` / `properties.mepSystemName`).
 * Mutates the live element objects in place; returns how many elements
 * were stamped. Conflict clusters stamp nothing.
 */
export function stampSystemNames(elements: MepLike[], tree: MepSystemTree): number {
  const byId = new Map(elements.map((e) => [e.id, e]));
  let stamped = 0;
  for (const c of tree.clusters) {
    if (!c.persistentId) continue;
    for (const id of c.memberIds) {
      const el = byId.get(id);
      if (!el) continue;
      el.properties = { ...(el.properties ?? {}), mepSystemId: c.persistentId, mepSystemName: c.label };
      stamped++;
    }
  }
  return stamped;
}

export function computeMepSystemTree(elements: MepLike[], options: MepSystemTreeOptions = {}): MepSystemTree {
  const mep = elements.filter(isMepElement);
  const registry = options.registry ?? null;
  if (registry) registry.seedFrom(mep);

  // Union-find over indices; grid-indexed connectivity (connectedPairs is
  // exactly the O(n²) scan, pruned — see connectivity.ts).
  const parent = mep.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const indexOf = new Map(mep.map((e, i) => [e.id, i]));
  for (const [a, b] of connectedPairs(mep)) union(indexOf.get(a.id)!, indexOf.get(b.id)!);

  // Gather clusters in first-appearance order of their smallest member index.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < mep.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const roots = [...groups.keys()].sort((a, b) => a - b);

  // Per-system sequence numbering follows cluster first-appearance order.
  const sequence = new Map<string, number>();
  const clusters: MepSystemCluster[] = [];

  for (const root of roots) {
    const idxs = groups.get(root) ?? [];
    const members = idxs.map((i) => mep[i]);

    // Member ordering: equipment heads first, then linear, then fittings,
    // stable by input order within each group.
    const ordered = idxs
      .map((i) => ({ i, k: KIND_ORDER[memberKind(mep[i])] }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map(({ i }) => mep[i].id);

    // 1. Declared properties.system: exactly one distinct declared system
    // wins; two or more distinct declared systems in ONE connected cluster
    // is a modelling error and is REJECTED (never majority-voted).
    const declaredByMember = members.map((m) => declaredSystems(m));
    const distinctDeclared: MepSystem[] = [];
    const membersBySystem = new Map<MepSystem, string[]>();
    for (let mi = 0; mi < members.length; mi++) {
      for (const s of declaredByMember[mi]) {
        if (!membersBySystem.has(s)) {
          membersBySystem.set(s, []);
          distinctDeclared.push(s);
        }
        membersBySystem.get(s)!.push(members[mi].id);
      }
    }
    const diagnostics: string[] = [];
    let conflicts: MepSystem[] = [];
    let system: MepSystem | null = null;
    if (distinctDeclared.length >= 2) {
      conflicts = distinctDeclared;
      const parts = distinctDeclared.map(
        (s) => `${MEP_SYSTEM_LABELS[s]} (${(membersBySystem.get(s) ?? []).join(", ")})`,
      );
      diagnostics.push(
        `Mixed declared systems in one connected cluster — ${parts.join(" vs ")}. ` +
        `A connected run cannot carry two systems; re-classify the members or disconnect them.`,
      );
    } else if (distinctDeclared.length === 1) {
      system = distinctDeclared[0];
    }

    // 2. Dominant linear member type (default heuristic, undeclared only).
    if (!system && conflicts.length === 0) {
      const linearValues = members.map((m) => (LINEAR_MEP.has(m.type) ? m.type : null));
      const dom = majorityByFirstAppearance(linearValues);
      system = dom ? systemForLinearType(dom) : null;
    }

    // 3. Fitting parentType through the same mapping.
    if (!system && conflicts.length === 0) {
      const parentValues = members.map((m) => {
        const pt = m.params?.parentType;
        return typeof pt === "string" ? pt : null;
      });
      const dom = majorityByFirstAppearance(parentValues);
      system = dom ? systemForLinearType(dom) : null;
    }

    // 4. null → Unclassified (or System Conflict when rejected above).

    const key = conflicts.length > 0 ? "system-conflict" : (system ?? "unclassified");
    const n = (sequence.get(key) ?? 0) + 1;
    sequence.set(key, n);
    const derivedLabel = conflicts.length > 0
      ? `System Conflict ${n}`
      : system ? `${MEP_SYSTEM_LABELS[system]} ${n}` : `Unclassified ${n}`;

    // Persistent identity: reuse a stamp, or mint one. The persistent name
    // is the label when a registry is in play (no per-refresh renumbering).
    let persistentId: string | null = null;
    let label = derivedLabel;
    if (registry) {
      const assignment = registry.assignFor(members, system, conflicts);
      if (assignment) {
        persistentId = assignment.id;
        label = assignment.name;
        if (assignment.mergeNote) diagnostics.push(assignment.mergeNote);
      }
    }

    clusters.push({
      id: persistentId ?? `${key}-${n}`,
      system,
      label,
      memberIds: ordered,
      unconnected: ordered.length === 1,
      conflicts,
      diagnostics,
      persistentId,
    });
  }

  return {
    clusters,
    unconnectedCount: clusters.filter((c) => c.unconnected).length,
    conflictCount: clusters.filter((c) => c.conflicts.length > 0).length,
    totalMep: mep.length,
  };
}
