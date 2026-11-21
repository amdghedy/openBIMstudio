/**
 * Stored connector semantics for plain MEP runs (Revit parity rank 5).
 *
 * Before this module, connectivity for authored duct/pipe/cable-tray/
 * conduit runs was purely geometry-derived: `connectivity.ts` re-derived
 * every pair from end positions on every recompute, and the lifecycle
 * (`model-lifecycle.ts`) held per-run "start"/"end" connectors with ZERO
 * edges between them — nothing ever called `lifecycle.connect()` for
 * authored runs, so no port-to-port edge was ever stored or persisted.
 *
 * This module closes that gap in three steps:
 *
 *   1. DERIVE — `deriveRunConnectors` turns a linear run's geometry into
 *      its two stored ports (start/end), with domain, shape, size and
 *      system classification from the element itself. This is the same
 *      derivation `authoring.ts` used to register connectors in the
 *      lifecycle, extracted here so it is pure and unit-testable.
 *      One deliberate correction: run ports are `flowDirection: "inout"`.
 *      The old inline derivation marked start "in" and end "out" by DRAW
 *      order, but draw order is not flow direction — a run drawn
 *      right-to-left joins its "start" to the next run's "start", and the
 *      compatibility gate would have rejected that legitimate join as
 *      "both connectors are inlets". A linear run is a bidirectional
 *      segment; flow direction is decided by the system, not the draw.
 *
 *   2. ADOPT — `adoptStoredConnections` scans geometry-touching pairs and
 *      stores a port-to-port edge for each one whose contact is explained
 *      by a coincident connector pair. Adoption is idempotent (already-
 *      edged pairs are skipped) and never invents an edge: a run end
 *      landing on another run's body, or two runs crossing, has no port
 *      at the contact, so no edge is stored — the contact is reported as
 *      an unadopted contact instead of silently counting as connected.
 *      Fittings and equipment get NO derived ports here: fittings are
 *      junctions whose connectivity stays positional, and equipment is a
 *      terminal. Their contacts remain geometry-derived by design (see
 *      `system-tree.ts`); deriving fitting ports from arm angles would
 *      risk disconnecting working elbow joints and is out of scope.
 *
 *   3. TRUST — `computeMepSystemTree(elements, { connections })` treats
 *      stored edges as authoritative for linear↔linear pairs: when a
 *      connection list is supplied, two runs connect ONLY through a stored
 *      edge. Geometry still joins pairs that involve a fitting or
 *      equipment (unmanaged elements). When no connection list is
 *      supplied the tree behaves exactly as before (pure geometry), so
 *      legacy callers and existing tests are unaffected.
 *
 * Persistence: edges live in `MepModelLifecycle` (`connections`), which
 * the project save already snapshots into `mepLifecycle`
 * (`projects.ts: current.mepLifecycle = lifecycle.snapshot()`) and the
 * load rehydrates. A stored edge therefore survives save/reload, and —
 * because the tree reads stored edges — connectivity survives a model
 * edit without re-derivation: moving a run does not re-derive its
 * connections; the lifecycle revalidates them on edit and drops only the
 * ones whose ports disappeared or became incompatible.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

import {
  connectedPairs,
  isMepElement,
  LINEAR_MEP,
  CONNECT_TOL_Y,
  type MepLike,
} from "./connectivity";
import {
  evaluateConnectorCompatibility,
  type ConnectorConnection,
  type MepConnector,
} from "./connectors";

/** Plan tolerance (m) for two run ports to count as coincident. Mirrors the
 * linear touch tolerance in connectivity.ts (pointTouches uses 0.05 m plan
 * for a free end against a run body). */
export const PORT_TOL_PLAN = 0.05;
/** Vertical tolerance (m) for two run ports to count as coincident. */
export const PORT_TOL_Y = CONNECT_TOL_Y;

/** A stored edge expressed as the connector pair it joins. */
export interface StoredConnectionQuad {
  sourceElementId: string;
  sourceConnector: string;
  targetElementId: string;
  targetConnector: string;
}

export type UnadoptedReason =
  /** A compatible port pair exists at the contact — the edge is adoptable
   * but has not been stored yet (adoption has not run). */
  | "not-yet-stored"
  /** Ports coincide at the contact but fail compatibility (domain, system
   * classification or flow direction). */
  | "incompatible-ports"
  /** No port pair coincides at the contact: a run end on another run's
   * body, or two runs crossing. No junction fitting, no edge. */
  | "no-port-pair";

export interface UnadoptedContact {
  elementAId: string;
  elementBId: string;
  reason: UnadoptedReason;
  detail: string;
}

export interface AdoptionResult {
  /** New edges to store (one quad per newly adopted pair). */
  quads: StoredConnectionQuad[];
  /** Geometry-touching linear↔linear pairs that got no edge, with the
   * reason each one was left unadopted. */
  unadopted: UnadoptedContact[];
}

function domainFor(type: string): MepConnector["def"]["domain"] {
  if (type === "duct") return "duct";
  if (type === "pipe") return "pipe";
  if (type === "cable-tray") return "cabletray";
  return "conduit";
}

/**
 * The two stored ports of a linear MEP run, derived from its geometry —
 * the same derivation authoring.ts registers in the lifecycle on every
 * rebuild, extracted here so it is pure and testable.
 *
 * Returns null when the element is not a linear run, or when its geometry
 * is degenerate (missing/invalid endpoints, zero length): a degenerate run
 * has no ports, and callers must skip the lifecycle call entirely for it
 * (registering an empty port list would drop its existing edges).
 */
export function deriveRunConnectors(e: MepLike): MepConnector[] | null {
  if (!LINEAR_MEP.has(e.type)) return null;
  const p = e.params;
  const start = p.start, end = p.end;
  if (!start || !end ||
      !Number.isFinite(start[0]) || !Number.isFinite(start[1]) ||
      !Number.isFinite(end[0]) || !Number.isFinite(end[1])) return null;
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (!(length >= 1e-6)) return null;
  const domain = domainFor(e.type);
  const shape = e.type === "pipe" || e.type === "conduit" ? "round" : "rectangular";
  const size: number | [number, number] = shape === "round"
    ? Math.max(0.001, p.thickness || p.width || 0.05)
    : [Math.max(0.001, p.width || p.thickness || 0.1), Math.max(0.001, p.height || p.thickness || 0.1)];
  const classification = String(
    e.properties?.systemClassification ??
    e.properties?.systemType ??
    domain + "-default",
  );
  const y0 = p.elevation || 0, y1 = p.endElevation ?? y0;
  // Run ports are bidirectional ("inout"): draw order is not flow
  // direction, so start↔start and end↔end joins are legitimate.
  const make = (
    name: string, x: number, y: number, z: number,
    dir: [number, number, number],
  ): MepConnector => ({
    ownerElementId: e.id,
    def: {
      name,
      origin: [0, 0, 0],
      direction: dir,
      domain: domain as MepConnector["def"]["domain"],
      shape: shape as MepConnector["def"]["shape"],
      size,
      flowDirection: "inout",
      systemClassification: classification,
    },
    worldOrigin: [x, y, z],
    worldDirection: dir,
    engaged: false,
    connectedTo: null,
  });
  return [
    make("start", start[0], y0, start[1], [-dx / length, (y0 - y1) / Math.max(length, 1e-6), -dz / length]),
    make("end", end[0], y1, end[1], [dx / length, (y1 - y0) / Math.max(length, 1e-6), dz / length]),
  ];
}

/** Unordered element-pair key, for "already edged" checks. */
function pairKey(a: string, b: string): string {
  return a < b ? a + "|" + b : b + "|" + a;
}

function portDistance3(a: MepConnector, b: MepConnector): { plan: number; vertical: number } {
  const plan = Math.hypot(
    a.worldOrigin[0] - b.worldOrigin[0],
    a.worldOrigin[2] - b.worldOrigin[2],
  );
  return { plan, vertical: Math.abs(a.worldOrigin[1] - b.worldOrigin[1]) };
}

interface PortPairScan {
  /** Best coincident port pair, if any (closest, ties by connector name). */
  best: { a: MepConnector; b: MepConnector; plan: number } | null;
  /** Compatibility of the best pair, when one exists. */
  compatibility: ReturnType<typeof evaluateConnectorCompatibility> | null;
}

function scanPortPairs(aPorts: MepConnector[], bPorts: MepConnector[]): PortPairScan {
  let best: PortPairScan["best"] = null;
  for (const a of aPorts) {
    for (const b of bPorts) {
      const d = portDistance3(a, b);
      if (d.plan > PORT_TOL_PLAN || d.vertical > PORT_TOL_Y) continue;
      const candidate = { a, b, plan: d.plan };
      if (!best || candidate.plan < best.plan - 1e-9 ||
          (Math.abs(candidate.plan - best.plan) <= 1e-9 &&
            (a.def.name + "|" + b.def.name) < (best.a.def.name + "|" + best.b.def.name))) {
        best = candidate;
      }
    }
  }
  return {
    best,
    compatibility: best ? evaluateConnectorCompatibility(best.a, best.b) : null,
  };
}

type PairClass =
  | { kind: "adoptable"; quad: StoredConnectionQuad }
  | { kind: "incompatible-ports"; detail: string }
  | { kind: "no-port-pair"; detail: string };

/**
 * Classify every geometry-touching linear↔linear pair that has no stored
 * edge yet. Pairs already covered by a stored edge are skipped (adoption
 * is idempotent). Pairs involving a fitting or equipment are not
 * candidates — their connectivity stays geometry-derived by design.
 */
function classifyPairs(
  elements: MepLike[],
  existing: ConnectorConnection[],
): Array<{ a: MepLike; b: MepLike; result: PairClass }> {
  const mep = elements.filter(isMepElement);
  const portsById = new Map<string, MepConnector[]>();
  for (const e of mep) {
    const ports = deriveRunConnectors(e);
    if (ports) portsById.set(e.id, ports);
  }
  const edged = new Set<string>();
  for (const c of existing) {
    if (typeof c?.sourceElementId === "string" && typeof c?.targetElementId === "string") {
      edged.add(pairKey(c.sourceElementId, c.targetElementId));
    }
  }
  const out: Array<{ a: MepLike; b: MepLike; result: PairClass }> = [];
  for (const [a, b] of connectedPairs(mep)) {
    if (!LINEAR_MEP.has(a.type) || !LINEAR_MEP.has(b.type)) continue;
    if (edged.has(pairKey(a.id, b.id))) continue;
    const aPorts = portsById.get(a.id) ?? [];
    const bPorts = portsById.get(b.id) ?? [];
    const scan = scanPortPairs(aPorts, bPorts);
    if (!scan.best) {
      out.push({
        a, b,
        result: {
          kind: "no-port-pair",
          detail: `Run '${a.id}' touches run '${b.id}' geometrically but no port pair coincides at the contact (end on body, or crossing runs) — add a junction fitting (tee/cross) to connect them; no stored edge was created.`,
        },
      });
      continue;
    }
    if (!scan.compatibility?.compatible) {
      out.push({
        a, b,
        result: {
          kind: "incompatible-ports",
          detail: `Ports '${a.id}:${scan.best.a.def.name}' and '${b.id}:${scan.best.b.def.name}' coincide but are incompatible: ${(scan.compatibility?.reasons ?? []).join("; ")} — no stored edge was created.`,
        },
      });
      continue;
    }
    out.push({
      a, b,
      result: {
        kind: "adoptable",
        quad: {
          sourceElementId: a.id,
          sourceConnector: scan.best.a.def.name,
          targetElementId: b.id,
          targetConnector: scan.best.b.def.name,
        },
      },
    });
  }
  return out;
}

/**
 * Adopt stored edges for geometry-touching runs: the quad list from the
 * pair classification (the unadopted contacts are the diagnostics for the
 * pairs that got no edge). Callers store the quads — see
 * `syncStoredConnections` for the lifecycle-backed version.
 */
export function adoptStoredConnections(
  elements: MepLike[],
  existing: ConnectorConnection[],
): AdoptionResult {
  const quads: StoredConnectionQuad[] = [];
  const unadopted: UnadoptedContact[] = [];
  for (const { a, b, result } of classifyPairs(elements, existing)) {
    if (result.kind === "adoptable") quads.push(result.quad);
    else unadopted.push({ elementAId: a.id, elementBId: b.id, reason: result.kind, detail: result.detail });
  }
  return { quads, unadopted };
}

/**
 * The unadopted contacts for a model that already has stored edges:
 * every geometry-touching linear↔linear pair with no stored edge between
 * its two elements, classified by whether a compatible port pair exists
 * at the contact. Used by the system tree so the browser can report
 * contacts that are geometrically touching but NOT connected.
 */
export function findUnadoptedContacts(
  elements: MepLike[],
  existing: ConnectorConnection[],
): UnadoptedContact[] {
  const out: UnadoptedContact[] = [];
  for (const { a, b, result } of classifyPairs(elements, existing)) {
    if (result.kind === "adoptable") {
      out.push({
        elementAId: a.id,
        elementBId: b.id,
        reason: "not-yet-stored",
        detail: `Ports '${a.id}:${result.quad.sourceConnector}' and '${b.id}:${result.quad.targetConnector}' coincide and are compatible, but no stored edge exists yet — run adoption to store it.`,
      });
    } else {
      out.push({ elementAId: a.id, elementBId: b.id, reason: result.kind, detail: result.detail });
    }
  }
  return out;
}

// ── Lifecycle-backed sync ─────────────────────────────────────────────────

/** Minimal store interface: the real `MepModelLifecycle` satisfies it. */
export interface StoredConnectionStore {
  listConnections(): ConnectorConnection[];
  connect(
    sourceElementId: string,
    sourceConnector: string,
    targetElementId: string,
    targetConnector: string,
  ): ConnectorConnection;
}

export interface StoredSyncResult {
  /** Quads that were stored as edges by this call. */
  adopted: StoredConnectionQuad[];
  /** Geometry-touching pairs that got no edge, with reasons. */
  unadopted: UnadoptedContact[];
  /** Quads whose store rejected the edge (e.g. a port already engaged by
   * a different edge). The pre-existing edge is left untouched; the
   * failure is reported, never thrown — this runs on rebuild/render. */
  failed: Array<{ quad: StoredConnectionQuad; error: string }>;
}

/**
 * Adopt-and-store in one idempotent step: find adoptable pairs, store each
 * through the lifecycle, and report what was stored, what was left
 * unadopted, and what the store rejected. Safe to call on every rebuild
 * and before every system-tree render — already-edged pairs are skipped,
 * and a rejected edge never aborts the sync.
 */
export function syncStoredConnections(
  elements: MepLike[],
  store: StoredConnectionStore,
): StoredSyncResult {
  const existing = store.listConnections();
  const { quads, unadopted } = adoptStoredConnections(elements, existing);
  const adopted: StoredConnectionQuad[] = [];
  const failed: StoredSyncResult["failed"] = [];
  for (const quad of quads) {
    try {
      store.connect(quad.sourceElementId, quad.sourceConnector, quad.targetElementId, quad.targetConnector);
      adopted.push(quad);
    } catch (e) {
      failed.push({ quad, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { adopted, unadopted, failed };
}
