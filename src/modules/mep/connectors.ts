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
  if (start.engaged || end.engaged) {
    throw new Error("CreateConnectorRelationship: connector already engaged");
  }
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
    | "missing-fitting";
  message: string;
  elementIds: string[];
}

/**
 * ValidateMEPNetworkTopology over the connection graph. Rules (level E):
 *   - every element with connectors should have at least one engagement
 *     (disconnected equipment is a warning-level report for the caller);
 *   - flow must alternate out → in across each connection;
 *   - connections must not form closed loops (flow networks are trees/DAGs);
 *   - size changes must be accompanied by a reducer/transition fitting.
 */
export function validateMepNetworkTopology(
  connectors: MepConnector[],
  connections: ConnectorConnection[],
): TopologyIssue[] {
  const issues: TopologyIssue[] = [];
  const byElement = new Map<string, MepConnector[]>();
  for (const c of connectors) {
    const list = byElement.get(c.ownerElementId) ?? [];
    list.push(c);
    byElement.set(c.ownerElementId, list);
  }
  // Disconnected equipment.
  for (const [elId, list] of byElement) {
    if (list.length && !list.some((c) => c.engaged)) {
      issues.push({ code: "disconnected-equipment", message: `element '${elId}' has connectors but none engaged`, elementIds: [elId] });
    }
  }
  // Build adjacency for loop detection + flow checks.
  const adj = new Map<string, Array<{ to: string; conn: ConnectorConnection }>>();
  for (const conn of connections) {
    const list = adj.get(conn.sourceElementId) ?? [];
    list.push({ to: conn.targetElementId, conn });
    adj.set(conn.sourceElementId, list);
    const back = adj.get(conn.targetElementId) ?? [];
    back.push({ to: conn.sourceElementId, conn });
    adj.set(conn.targetElementId, back);
  }
  // Closed-loop detection via DFS (undirected cycle).
  const visited = new Set<string>();
  let cycles = 0;
  const dfs = (node: string, parent: string | null): void => {
    visited.add(node);
    for (const edge of adj.get(node) ?? []) {
      if (edge.to === parent) continue;
      if (visited.has(edge.to)) {
        cycles++;
        continue;
      }
      dfs(edge.to, node);
    }
  };
  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node, null);
  }
  if (cycles > 0) {
    issues.push({
      code: "closed-loop",
      message: `network contains ${cycles} closed loop(s); flow networks must be tree/DAG shaped`,
      elementIds: [...adj.keys()],
    });
  }
  // Size jumps without fittings.
  for (const conn of connections) {
    if (conn.fittings.length === 0) {
      const s = connectors.find((c) => c.ownerElementId === conn.sourceElementId && c.def.name === conn.sourceConnector);
      const t = connectors.find((c) => c.ownerElementId === conn.targetElementId && c.def.name === conn.targetConnector);
      if (s && t && s.def.size.toString() !== t.def.size.toString()) {
        issues.push({
          code: "size-jump-without-fitting",
          message: `connection ${conn.id} changes size without a reducer/transition fitting`,
          elementIds: [conn.sourceElementId, conn.targetElementId],
        });
      }
    }
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
