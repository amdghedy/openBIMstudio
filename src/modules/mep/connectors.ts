/**
 * MEP connector intelligence (MASTER PROMPT MODULE 2B.7).
 *
 * Connector compatibility, approach-path fitting determination, route
 * preview, persistent connectivity records and network topology
 * validation. Governing rule from the spec: NEVER create an engineering
 * connection solely because two connectors are close — compatibility
 * (domain, shape, size, system classification, flow direction) must pass
 * first, and topology validation runs before any commit is reported as
 * successful.
 *
 * Building on the platform's existing MEP modules (connectivity.ts,
 * router.ts, pressure.ts) which handle routing and hydraulics; this file
 * adds the connector-level semantics they were missing.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { ConnectorDefinition } from "../object-hierarchy";
import { newUniqueId } from "../object-hierarchy";

export type ConnectorRole = "origin" | "destination";

/** Runtime connector instance: definition + owner + world transform. */
export interface MepConnector {
  ownerElementId: string;
  def: ConnectorDefinition;
  /** World-space origin. */
  worldOrigin: [number, number, number];
  /** World-space unit direction (flow axis, out of the element). */
  worldDirection: [number, number, number];
  engaged: boolean;
  connectedTo: string | null;
}

/** GetMEPConnectors: connectors of an element (caller supplies the list). */
export function getMepConnectors(
  all: MepConnector[],
  elementId: string,
): MepConnector[] {
  return all.filter((c) => c.ownerElementId === elementId);
}

export interface CompatibilityReport {
  compatible: boolean;
  reasons: string[];
  /** Size mismatch details when shapes match. */
  sizeDelta?: number;
}

/**
 * EvaluateConnectorCompatibility (spec 2B.7): domain, shape, size,
 * system classification and flow direction. Tolerance for round sizes is
 * one standard size step (documented level E: 25 mm); rectangular sizes
 * must match within 5 mm per dimension before transitions are considered.
 */
export const ROUND_SIZE_STEP = 0.025; // metres
export const RECT_SIZE_TOL = 0.005; // metres

export function evaluateConnectorCompatibility(a: MepConnector, b: MepConnector): CompatibilityReport {
  const reasons: string[] = [];
  if (a.def.domain !== b.def.domain) {
    reasons.push(`domain mismatch: ${a.def.domain} vs ${b.def.domain}`);
  }
  if (a.def.flowDirection === "in" && b.def.flowDirection === "in") {
    reasons.push("both connectors are inlets");
  }
  if (a.def.flowDirection === "out" && b.def.flowDirection === "out") {
    reasons.push("both connectors are outlets");
  }
  if (a.def.systemClassification !== b.def.systemClassification) {
    reasons.push(`system classification differs: ${a.def.systemClassification} vs ${b.def.systemClassification}`);
  }
  // Size mismatches are NOT hard rejections: a reducer/transition fitting
  // resolves them (spec 2B.7 step 4 — CalculateRequiredFittings). They are
  // reported through sizeDelta for the preview panel.
  let sizeDelta: number | undefined;
  if (a.def.shape === "round" && b.def.shape === "round") {
    sizeDelta = Math.abs((a.def.size as number) - (b.def.size as number));
  } else if (a.def.shape === "rectangular" && b.def.shape === "rectangular") {
    const [wa, ha] = a.def.size as [number, number];
    const [wb, hb] = b.def.size as [number, number];
    sizeDelta = Math.max(Math.abs(wa - wb), Math.abs(ha - hb));
  } else if (a.def.shape !== b.def.shape) {
    // Shape changes need a transition fitting; still connectable.
    sizeDelta = Infinity;
  }
  return { compatible: reasons.length === 0, reasons, sizeDelta };
}

/** QueryCompatibleConnectors: only COMPATIBLE candidates in range (spec
 * 2B.7 steps 1–2: candidate detection + compatibility validation are one
 * gate — an incompatible connector is never offered as a snap target). */
export function queryCompatibleConnectors(
  from: MepConnector,
  pool: MepConnector[],
  maxDistance: number,
): Array<{ connector: MepConnector; distance: number; compatibility: CompatibilityReport }> {
  const out: Array<{ connector: MepConnector; distance: number; compatibility: CompatibilityReport }> = [];
  for (const c of pool) {
    if (c.ownerElementId === from.ownerElementId) continue;
    if (c.engaged || c.connectedTo) continue;
    const d = Math.hypot(
      c.worldOrigin[0] - from.worldOrigin[0],
      c.worldOrigin[1] - from.worldOrigin[1],
      c.worldOrigin[2] - from.worldOrigin[2],
    );
    if (d > maxDistance) continue;
    const compat = evaluateConnectorCompatibility(from, c);
    if (!compat.compatible) continue; // never offer incompatible connectors
    out.push({ connector: c, distance: d, compatibility: compat });
  }
  // Deterministic order: distance, then element id (spec 2B.2 tie-breaking).
  return out.sort((x, y) =>
    x.distance - y.distance || x.connector.ownerElementId.localeCompare(y.connector.ownerElementId));
}

// ── Fittings (spec 2B.7 step 4) ─────────────────────────────────────────

export type FittingKind =
  | "elbow" | "tee" | "cross" | "union" | "reducer" | "transition"
  | "cap" | "plug" | "wye";

export interface RequiredFitting {
  kind: FittingKind;
  reason: string;
  /** Required angle for elbows (radians). */
  angle?: number;
  /** Size transition for reducers/transitions. */
  fromSize?: number | [number, number];
  toSize?: number | [number, number];
  shapeTransition?: [ConnectorDefinition["shape"], ConnectorDefinition["shape"]];
}

/** Angle threshold for straight continuation (radians). */
const STRAIGHT_TOL = 1e-3;

/**
 * CalculateRequiredFittings between two connectors given the proposed
 * route polyline (world points from the source toward the target).
 */
export function calculateRequiredFittings(
  route: Array<[number, number, number]>,
  start: MepConnector,
  end: MepConnector,
): RequiredFitting[] {
  const out: RequiredFitting[] = [];
  // Direction changes along the route → elbows at interior vertices.
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1], b = route[i], c = route[i + 1];
    const u = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const v = norm3([c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
    const dotv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const angle = Math.acos(Math.max(-1, Math.min(1, dotv)));
    if (angle > STRAIGHT_TOL) {
      out.push({
        kind: angle > Math.PI - STRAIGHT_TOL ? "union" : "elbow",
        reason: `direction change of ${(angle * 180 / Math.PI).toFixed(1)}° at route vertex ${i}`,
        angle,
      });
    }
  }
  // Size/shape transitions between the endpoints.
  if (start.def.shape !== end.def.shape) {
    out.push({
      kind: "transition",
      reason: `shape transition ${start.def.shape} → ${end.def.shape}`,
      shapeTransition: [start.def.shape, end.def.shape],
      fromSize: start.def.size,
      toSize: end.def.size,
    });
  } else if (start.def.shape === "round" && start.def.size !== end.def.size) {
    out.push({
      kind: "reducer",
      reason: `diameter transition ${(start.def.size as number).toFixed(3)} → ${(end.def.size as number).toFixed(3)} m`,
      fromSize: start.def.size,
      toSize: end.def.size,
    });
  } else if (start.def.shape === "rectangular") {
    const [wa, ha] = start.def.size as [number, number];
    const [wb, hb] = end.def.size as [number, number];
    if (Math.abs(wa - wb) > RECT_SIZE_TOL || Math.abs(ha - hb) > RECT_SIZE_TOL) {
      out.push({
        kind: "transition",
        reason: `size transition ${wa}×${ha} → ${wb}×${hb} m`,
        fromSize: start.def.size,
        toSize: end.def.size,
      });
    }
  }
  return out;
}

/**
 * FindMEPConnectionPath: connector-aligned stubs followed by an orthogonal
 * 3D core route. The former fixed midpoint could create diagonal segments
 * whenever both elevation and plan coordinates changed.
 */
export function findMepConnectionPath(
  start: MepConnector,
  end: MepConnector,
): Array<[number, number, number]> {
  const a = start.worldOrigin;
  const b = end.worldOrigin;
  const startDir = unitDirection(start.worldDirection);
  const endDir = unitDirection(end.worldDirection);
  const stub = Math.max(
    0.15,
    2 * connectorCharacteristicSize(start),
    2 * connectorCharacteristicSize(end),
  );
  // Connector directions point out of their owning elements. Leave the
  // source along its direction and reach the target from the opposite side.
  const from: [number, number, number] = startDir
    ? [a[0] + startDir[0] * stub, a[1] + startDir[1] * stub, a[2] + startDir[2] * stub]
    : [...a];
  const to: [number, number, number] = endDir
    ? [b[0] + endDir[0] * stub, b[1] + endDir[1] * stub, b[2] + endDir[2] * stub]
    : [...b];

  const orders: Array<[number, number, number]> = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  let best: Array<[number, number, number]> | null = null;
  let bestLength = Infinity;
  for (const order of orders) {
    const points: Array<[number, number, number]> = [[...from]];
    const cursor: [number, number, number] = [...from];
    for (const axis of order) {
      cursor[axis] = to[axis];
      points.push([...cursor]);
    }
    const candidate = dedupeRoute([ [...a], ...points, [...b] ]);
    const length = routeLength(candidate);
    if (length < bestLength - 1e-9) {
      best = candidate;
      bestLength = length;
    }
  }
  return best ?? [ [...a], [...b] ];
}

function unitDirection(v: [number, number, number]): [number, number, number] | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < 1e-8) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function connectorCharacteristicSize(c: MepConnector): number {
  const size = c.def.size;
  if (typeof size === "number") return Number.isFinite(size) && size > 0 ? size : 0;
  return Array.isArray(size) ? Math.max(...size.filter(Number.isFinite), 0) : 0;
}

function dedupeRoute(points: Array<[number, number, number]>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const point of points) {
    if (!out.length || Math.hypot(
      point[0] - out[out.length - 1][0],
      point[1] - out[out.length - 1][1],
      point[2] - out[out.length - 1][2],
    ) > 1e-8) out.push(point);
  }
  return out;
}

function routeLength(points: Array<[number, number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(
    points[i][0] - points[i - 1][0],
    points[i][1] - points[i - 1][1],
    points[i][2] - points[i - 1][2],
  );
  return total;
}

/** PreviewMEPConnection: route + fittings + validity for the view layer. */
export function previewMepConnection(
  start: MepConnector,
  end: MepConnector,
  maxDistance = 50,
): {
  valid: boolean;
  reasons: string[];
  route: Array<[number, number, number]>;
  fittings: RequiredFitting[];
  distance: number;
} {
  const compat = evaluateConnectorCompatibility(start, end);
  const distance = Math.hypot(
    end.worldOrigin[0] - start.worldOrigin[0],
    end.worldOrigin[1] - start.worldOrigin[1],
    end.worldOrigin[2] - start.worldOrigin[2],
  );
  const reasons = [...compat.reasons];
  if (distance > maxDistance) reasons.push(`distance ${distance.toFixed(2)} m exceeds the ${maxDistance} m preview limit`);
  if (start.engaged || start.connectedTo) reasons.push("start connector already engaged");
  if (end.engaged || end.connectedTo) reasons.push("target connector already engaged");
  const route = findMepConnectionPath(start, end);
  const fittings = compat.compatible ? calculateRequiredFittings(route, start, end) : [];
  return { valid: reasons.length === 0, reasons, route, fittings, distance };
}

/** CreateConnectorRelationship record shape (persisted by the caller). */
export interface ConnectorConnection {
  id: string;
  sourceElementId: string;
  sourceConnector: string;
  targetElementId: string;
  targetConnector: string;
  fittings: RequiredFitting[];
  route: Array<[number, number, number]>;
  createdAt: number;
}

/** CreateConnectorRelationship: engage both connectors atomically. */
export function createConnectorRelationship(
  start: MepConnector,
  end: MepConnector,
  route: Array<[number, number, number]>,
  fittings: RequiredFitting[],
): ConnectorConnection {
  if (start.engaged || start.connectedTo || end.engaged || end.connectedTo) {
    throw new Error("CreateConnectorRelationship: connector already engaged");
  }
  const compatibility = evaluateConnectorCompatibility(start, end);
  if (!compatibility.compatible) {
    throw new Error(`CreateConnectorRelationship: incompatible connectors: ${compatibility.reasons.join("; ")}`);
  }
  if (route.length < 2 || route.some((p) => p.length !== 3 || !p.every(Number.isFinite))) {
    throw new Error("CreateConnectorRelationship: route must contain at least two finite 3D points");
  }
  const routeStart = route[0];
  const routeEnd = route[route.length - 1];
  const endpointTolerance = 1e-4;
  const startError = Math.hypot(routeStart[0] - start.worldOrigin[0], routeStart[1] - start.worldOrigin[1], routeStart[2] - start.worldOrigin[2]);
  const endError = Math.hypot(routeEnd[0] - end.worldOrigin[0], routeEnd[1] - end.worldOrigin[1], routeEnd[2] - end.worldOrigin[2]);
  if (startError > endpointTolerance || endError > endpointTolerance) {
    throw new Error("CreateConnectorRelationship: route endpoints must coincide with connector origins");
  }
  if (!Array.isArray(fittings)) {
    throw new Error("CreateConnectorRelationship: fittings must be an array");
  }
  // Mutate only after all validation succeeds so a failed operation is atomic.
  start.engaged = true;
  start.connectedTo = end.ownerElementId;
  end.engaged = true;
  end.connectedTo = start.ownerElementId;
  return {
    id: `conn-${newUniqueId().slice(0, 8)}`,
    sourceElementId: start.ownerElementId,
    sourceConnector: start.def.name,
    targetElementId: end.ownerElementId,
    targetConnector: end.def.name,
    fittings,
    route,
    createdAt: Date.now(),
  };
}

// ── Topology validation (spec 2B.7) ─────────────────────────────────────


export interface TopologyIssue {
  code:
    | "disconnected-equipment"
    | "flow-direction-conflict"
    | "closed-loop"
    | "size-jump-without-fitting"
    | "missing-fitting"
    | "duplicate-connector-definition"
    | "duplicate-connection-id"
    | "dangling-connection"
    | "self-connection"
    | "connector-multiple-connections"
    | "connector-compatibility"
    | "invalid-connection-route"
    | "connector-engagement-mismatch";
  message: string;
  elementIds: string[];
}

function connectorKey(elementId: string, connectorName: string): string {
  return JSON.stringify([elementId, connectorName]);
}

function routeMatchesConnectorOrigins(connection: ConnectorConnection, start: MepConnector, end: MepConnector): boolean {
  if (!Array.isArray(connection.route) || connection.route.length < 2) return false;
  if (!connection.route.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))) return false;
  if (!Array.isArray(connection.fittings)) return false;
  const first = connection.route[0];
  const last = connection.route[connection.route.length - 1];
  const tolerance = 1e-4;
  const startError = Math.hypot(first[0] - start.worldOrigin[0], first[1] - start.worldOrigin[1], first[2] - start.worldOrigin[2]);
  const endError = Math.hypot(last[0] - end.worldOrigin[0], last[1] - end.worldOrigin[1], last[2] - end.worldOrigin[2]);
  return startError <= tolerance && endError <= tolerance;
}

/**
 * Validate the persisted connector graph, not just the in-memory engaged flags.
 * A connector is a single-connection port in this data model: a second edge
 * using the same owner/name pair is an integrity error even when both edges
 * point to different elements.
 */
export function validateMepNetworkTopology(
  connectors: MepConnector[],
  connections: ConnectorConnection[],
): TopologyIssue[] {
  const issues: TopologyIssue[] = [];
  const byKey = new Map<string, MepConnector[]>();
  const byElement = new Map<string, MepConnector[]>();
  for (const connector of connectors) {
    const key = connectorKey(connector.ownerElementId, connector.def.name);
    const matches = byKey.get(key) ?? [];
    matches.push(connector);
    byKey.set(key, matches);
    const owned = byElement.get(connector.ownerElementId) ?? [];
    owned.push(connector);
    byElement.set(connector.ownerElementId, owned);
  }

  for (const matches of byKey.values()) {
    if (matches.length > 1) {
      const first = matches[0];
      issues.push({
        code: "duplicate-connector-definition",
        message: "element '" + first.ownerElementId + "' defines connector '" + first.def.name + "' " + matches.length + " times",
        elementIds: [first.ownerElementId],
      });
    }
  }

  const uniqueConnector = (elementId: string, name: string): MepConnector | undefined => {
    const matches = byKey.get(connectorKey(elementId, name));
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const uses = new Map<string, Array<{ peerElementId: string }>>();
  const seenConnectionIds = new Set<string>();
  const adjacency = new Map<string, Array<{ to: string; edgeId: string }>>();
  const addUse = (key: string, peerElementId: string) => {
    const list = uses.get(key) ?? [];
    list.push({ peerElementId });
    uses.set(key, list);
  };

  for (const connection of connections) {
    if (!connection || typeof connection !== "object") continue;
    const id = typeof connection.id === "string" ? connection.id : "";
    if (!id || seenConnectionIds.has(id)) {
      issues.push({
        code: "duplicate-connection-id",
        message: id ? "connection id '" + id + "' is used more than once" : "connection has no valid id",
        elementIds: [connection.sourceElementId, connection.targetElementId].filter((x): x is string => typeof x === "string"),
      });
    } else {
      seenConnectionIds.add(id);
    }

    const sourceElementId = connection.sourceElementId;
    const targetElementId = connection.targetElementId;
    const sourceName = connection.sourceConnector;
    const targetName = connection.targetConnector;
    const sourceKey = connectorKey(sourceElementId, sourceName);
    const targetKey = connectorKey(targetElementId, targetName);
    const source = uniqueConnector(sourceElementId, sourceName);
    const target = uniqueConnector(targetElementId, targetName);

    if (sourceElementId === targetElementId || sourceKey === targetKey) {
      issues.push({ code: "self-connection", message: "connection '" + (id || "(no id)") + "' links an element to itself", elementIds: [sourceElementId] });
    }
    if (!source || !target) {
      const missing: string[] = [];
      if (!source) missing.push(String(sourceElementId) + ":" + String(sourceName));
      if (!target) missing.push(String(targetElementId) + ":" + String(targetName));
      issues.push({
        code: "dangling-connection",
        message: "connection '" + (id || "(no id)") + "' references missing or ambiguous connector(s): " + missing.join(", "),
        elementIds: [sourceElementId, targetElementId].filter((x): x is string => typeof x === "string"),
      });
    }

    if (source && typeof targetElementId === "string") addUse(sourceKey, targetElementId);
    if (target && typeof sourceElementId === "string") addUse(targetKey, sourceElementId);

    if (source && target) {
      const compatibility = evaluateConnectorCompatibility(source, target);
      if (!compatibility.compatible) {
        issues.push({
          code: "connector-compatibility",
          message: "connection '" + (id || "(no id)") + "' has incompatible endpoints: " + compatibility.reasons.join("; "),
          elementIds: [sourceElementId, targetElementId],
        });
      }
      if (!routeMatchesConnectorOrigins(connection, source, target)) {
        issues.push({
          code: "invalid-connection-route",
          message: "connection '" + (id || "(no id)") + "' route is malformed or does not terminate at its connector origins",
          elementIds: [sourceElementId, targetElementId],
        });
      }
      const fromSize = source.def.size;
      const toSize = target.def.size;
      const sameSize = Array.isArray(fromSize) && Array.isArray(toSize)
        ? fromSize[0] === toSize[0] && fromSize[1] === toSize[1]
        : !Array.isArray(fromSize) && !Array.isArray(toSize) && fromSize === toSize;
      if (!sameSize && (!Array.isArray(connection.fittings) || connection.fittings.length === 0)) {
        issues.push({
          code: "size-jump-without-fitting",
          message: "connection " + id + " changes size without a reducer/transition fitting",
          elementIds: [sourceElementId, targetElementId],
        });
      }
      const sourceEdges = adjacency.get(sourceElementId) ?? [];
      sourceEdges.push({ to: targetElementId, edgeId: id });
      adjacency.set(sourceElementId, sourceEdges);
      const targetEdges = adjacency.get(targetElementId) ?? [];
      targetEdges.push({ to: sourceElementId, edgeId: id });
      adjacency.set(targetElementId, targetEdges);
    }
  }

  for (const [key, list] of uses) {
    if (list.length > 1) {
      const identity = JSON.parse(key) as [string, string];
      issues.push({
        code: "connector-multiple-connections",
        message: "connector '" + identity[0] + ":" + identity[1] + "' is used by " + list.length + " connections; this model supports one edge per connector",
        elementIds: [identity[0], ...list.map((use) => use.peerElementId).filter((x): x is string => typeof x === "string")],
      });
    }
  }

  // Engagement is a derived cache of the edge list. Verify it agrees where
  // there is exactly one unambiguous edge; skip overbooked/duplicate ports.
  for (const connector of connectors) {
    const key = connectorKey(connector.ownerElementId, connector.def.name);
    if ((byKey.get(key)?.length ?? 0) !== 1) continue;
    const portUses = uses.get(key) ?? [];
    if (portUses.length > 1) continue;
    const expectedPeer = portUses[0]?.peerElementId ?? null;
    const expectedEngaged = portUses.length === 1;
    if (connector.engaged !== expectedEngaged || connector.connectedTo !== expectedPeer) {
      issues.push({
        code: "connector-engagement-mismatch",
        message: "connector '" + connector.ownerElementId + ":" + connector.def.name + "' engagement does not match its connection records",
        elementIds: [connector.ownerElementId, ...(expectedPeer ? [expectedPeer] : [])],
      });
    }
  }

  for (const [elementId, owned] of byElement) {
    const connected = owned.some((connector) => (uses.get(connectorKey(connector.ownerElementId, connector.def.name))?.length ?? 0) > 0);
    if (owned.length && !connected) {
      issues.push({ code: "disconnected-equipment", message: "element '" + elementId + "' has connectors but none connected", elementIds: [elementId] });
    }
  }

  // Traverse by edge identity so parallel edges are not mistaken for one parent edge.
  const visited = new Set<string>();
  let cycles = 0;
  const dfs = (node: string, parentEdgeId: string | null): void => {
    visited.add(node);
    for (const edge of adjacency.get(node) ?? []) {
      if (edge.edgeId === parentEdgeId) continue;
      if (visited.has(edge.to)) { cycles++; continue; }
      dfs(edge.to, edge.edgeId);
    }
  };
  for (const node of adjacency.keys()) {
    if (!visited.has(node)) dfs(node, null);
  }
  if (cycles > 0) {
    issues.push({
      code: "closed-loop",
      message: "network contains " + Math.ceil(cycles / 2) + " closed loop(s); review the topology rule for this system",
      elementIds: [...adjacency.keys()],
    });
  }
  return issues;
}

/** RecalculateAffectedMEPProperties: downstream connection re-evaluation. */
export function recalculateAffectedMepProperties(
  connections: ConnectorConnection[],
  changedElementId: string,
): ConnectorConnection[] {
  const affected = connections.filter(
    (c) => c.sourceElementId === changedElementId || c.targetElementId === changedElementId,
  );
  // Touch createdAt to force downstream caches to re-read (level E contract:
  // the hydraulic engine reads these records fresh on each solve).
  for (const c of affected) c.createdAt = Date.now();
  return affected;
}

/** DisconnectMEPConnectors: release both sides of a connection. */
export function disconnectMepConnectors(
  connectors: MepConnector[],
  connection: ConnectorConnection,
): { released: string[] } {
  const released: string[] = [];
  for (const c of connectors) {
    if (
      (c.ownerElementId === connection.sourceElementId && c.def.name === connection.sourceConnector) ||
      (c.ownerElementId === connection.targetElementId && c.def.name === connection.targetConnector)
    ) {
      c.engaged = false;
      c.connectedTo = null;
      released.push(`${c.ownerElementId}:${c.def.name}`);
    }
  }
  return { released };
}

function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
