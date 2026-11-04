/**
 * Native MEP model-lifecycle coordinator.
 *
 * Keeps connector relationships and electrical assignments in one in-memory
 * model service, revalidates dependants after geometry edits, and exposes
 * deterministic diagnostics/schedules to authoring UI. Persistence must be
 * provided by the host project's save/history adapter.
 */
import {
  createConnectorRelationship,
  disconnectMepConnectors,
  evaluateConnectorCompatibility,
  previewMepConnection,
  recalculateAffectedMepProperties,
  validateMepNetworkTopology,
} from "./connectors";
import type { ConnectorConnection, MepConnector, TopologyIssue } from "./connectors";
import { buildPanelSchedule, validateElectricalDistribution } from "./electrical";
import type { ElectricalLoad, ElectricalPanel, ElectricalDiagnostic, PanelSchedule } from "./electrical";

export interface MepModelSnapshot {
  revision: number;
  connectors: MepConnector[];
  connections: ConnectorConnection[];
  panels: ElectricalPanel[];
  loads: ElectricalLoad[];
}

export interface MepEditResult {
  revision: number;
  affectedConnectionIds: string[];
  topologyIssues: TopologyIssue[];
  electricalIssues: ElectricalDiagnostic[];
}

function cloneConnector(c: MepConnector): MepConnector {
  return {
    ...c,
    worldOrigin: [...c.worldOrigin] as [number, number, number],
    worldDirection: [...c.worldDirection] as [number, number, number],
    def: {
      ...c.def,
      origin: [...c.def.origin] as [number, number, number],
      direction: [...c.def.direction] as [number, number, number],
      size: Array.isArray(c.def.size) ? [...c.def.size] as [number, number] : c.def.size,
    },
  };
}

function cloneFitting(fitting: ConnectorConnection["fittings"][number]): ConnectorConnection["fittings"][number] {
  const cloneSize = (size: typeof fitting.fromSize) =>
    Array.isArray(size) ? [...size] as [number, number] : size;
  return {
    ...fitting,
    fromSize: cloneSize(fitting.fromSize),
    toSize: cloneSize(fitting.toSize),
    shapeTransition: fitting.shapeTransition ? [...fitting.shapeTransition] as [typeof fitting.shapeTransition[0], typeof fitting.shapeTransition[1]] : undefined,
  };
}

function cloneConnection(connection: ConnectorConnection): ConnectorConnection {
  return {
    ...connection,
    route: connection.route.map(point => [...point] as [number, number, number]),
    fittings: connection.fittings.map(cloneFitting),
  };
}

function isFiniteVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

/** Validate a complete replacement list before changing any live lifecycle state. */
function validateReplacementConnectors(elementId: string, connectors: MepConnector[]): void {
  if (!Array.isArray(connectors)) throw new Error("nextConnectors must be an array");
  const names = new Set<string>();
  const domains = new Set(["duct", "pipe", "electrical", "conduit", "cabletray", "structural", "other"]);
  const shapes = new Set(["round", "rectangular", "oval", "point"]);
  const flows = new Set(["in", "out", "inout"]);
  for (const connector of connectors) {
    if (!connector || typeof connector !== "object") throw new Error("nextConnectors contains an invalid connector");
    if (connector.ownerElementId !== elementId) {
      throw new Error("nextConnectors must belong to the changed element: " + elementId);
    }
    const def = connector.def;
    if (!def || typeof def !== "object" || typeof def.name !== "string" || !def.name.trim()) {
      throw new Error("MEP connector name is required");
    }
    if (names.has(def.name)) throw new Error("Duplicate MEP connector name on element " + elementId + ": " + def.name);
    names.add(def.name);
    if (!domains.has(def.domain) || !shapes.has(def.shape) || !flows.has(def.flowDirection)) {
      throw new Error("MEP connector has an unsupported domain, shape or flow direction: " + def.name);
    }
    if (typeof def.systemClassification !== "string" || !def.systemClassification.trim()) {
      throw new Error("MEP connector system classification is required: " + def.name);
    }
    if (!isFiniteVector3(def.origin) || !isFiniteVector3(def.direction) ||
        !isFiniteVector3(connector.worldOrigin) || !isFiniteVector3(connector.worldDirection)) {
      throw new Error("MEP connector coordinates and directions must be finite 3D vectors: " + def.name);
    }
    const directionLength = Math.hypot(...connector.worldDirection);
    const definitionDirectionLength = Math.hypot(...def.direction);
    if (directionLength < 1e-9 || definitionDirectionLength < 1e-9) {
      throw new Error("MEP connector direction must be non-zero: " + def.name);
    }
    const size = def.size;
    if (Array.isArray(size)) {
      if (size.length !== 2 || !size.every(value => Number.isFinite(value) && value > 0)) {
        throw new Error("MEP connector size must contain two positive finite dimensions: " + def.name);
      }
      if (def.shape === "round") throw new Error("Round MEP connectors require a scalar size: " + def.name);
    } else if (!Number.isFinite(size) || size <= 0 || def.shape === "rectangular") {
      throw new Error("MEP connector size is invalid for its shape: " + def.name);
    }
  }
}

/** Coordinates MEP state transitions for native model edits. */
export class MepModelLifecycle {
  private revision = 0;
  private connectors: MepConnector[] = [];
  private connections: ConnectorConnection[] = [];
  private panels: ElectricalPanel[] = [];
  private loads: ElectricalLoad[] = [];

  getRevision(): number { return this.revision; }

  /** Replace the current MEP snapshot from the project's authored model. */
  hydrate(snapshot: Partial<Omit<MepModelSnapshot, "revision">>): void {
    this.connectors = (snapshot.connectors ?? []).map(cloneConnector);
    this.connections = (snapshot.connections ?? []).map(cloneConnection);
    this.panels = (snapshot.panels ?? []).map(p => ({ ...p, circuits: p.circuits.map(c => ({ ...c, loadIds: [...c.loadIds] })) }));
    this.loads = (snapshot.loads ?? []).map(l => ({ ...l }));
    this.reconcileConnectorEngagement();
    this.revision++;
  }

  snapshot(): MepModelSnapshot {
    return {
      revision: this.revision,
      connectors: this.connectors.map(cloneConnector),
      connections: this.connections.map(cloneConnection),
      panels: this.panels.map(p => ({ ...p, circuits: p.circuits.map(c => ({ ...c, loadIds: [...c.loadIds] })) })),
      loads: this.loads.map(l => ({ ...l })),
    };
  }

  listConnections(): ConnectorConnection[] { return this.snapshot().connections; }

  connect(sourceElementId: string, sourceConnector: string, targetElementId: string, targetConnector: string): ConnectorConnection {
    const start = this.requireConnector(sourceElementId, sourceConnector);
    const end = this.requireConnector(targetElementId, targetConnector);
    const preview = previewMepConnection(start, end);
    if (!preview.valid) throw new Error("MEP connection rejected: " + preview.reasons.join("; "));
    const connection = createConnectorRelationship(start, end, preview.route, preview.fittings);
    this.connections.push(connection);
    this.revision++;
    return cloneConnection(connection);
  }

  /**
   * Called after the native authoring tool changes an element's geometry or
   * connector definitions. Edges touching that element are invalidated if a
   * connector disappeared or became incompatible; valid edges are marked
   * affected so route/fitting regeneration can be queued by the host.
   */
  onElementChanged(elementId: string, nextConnectors: MepConnector[]): MepEditResult {
    if (typeof elementId !== "string" || !elementId.trim()) throw new Error("elementId is required");
    // Validate the unfiltered input first. Filtering here would silently turn a
    // foreign/malformed connector list into an empty replacement, dropping
    // valid connections on the real element.
    validateReplacementConnectors(elementId, nextConnectors);
    const next = nextConnectors.map(cloneConnector);
    const previousIds = new Set(this.connectors.filter(c => c.ownerElementId === elementId).map(c => c.def.name));
    const affected = this.connections.filter(c => c.sourceElementId === elementId || c.targetElementId === elementId);
    const affectedIds = affected.map(c => c.id);
    const removedNames = new Set([...previousIds].filter(name => !next.some(c => c.def.name === name)));
    const invalidIds = new Set<string>();
    for (const connection of affected) {
      const s = next.find(c => c.def.name === connection.sourceConnector);
      const t = next.find(c => c.def.name === connection.targetConnector);
      const otherElementId = connection.sourceElementId === elementId ? connection.targetElementId : connection.sourceElementId;
      const otherName = connection.sourceElementId === elementId ? connection.targetConnector : connection.sourceConnector;
      const other = this.connectors.find(c => c.ownerElementId === otherElementId && c.def.name === otherName);
      const changed = connection.sourceElementId === elementId ? s : t;
      const changedName = connection.sourceElementId === elementId ? connection.sourceConnector : connection.targetConnector;
      if (removedNames.has(changedName) || !changed || !other || !evaluateConnectorCompatibility(changed, other).compatible) invalidIds.add(connection.id);
    }
    for (const connection of affected) {
      if (invalidIds.has(connection.id)) disconnectMepConnectors(this.connectors, connection);
    }
    this.connectors = this.connectors.filter(c => c.ownerElementId !== elementId).concat(next);
    this.connections = this.connections.filter(c => !invalidIds.has(c.id));
    // Regenerate the connector-aligned route and fittings after geometry edits.
    const regenerated: ConnectorConnection[] = [];
    for (const connection of this.connections) {
      if (connection.sourceElementId !== elementId && connection.targetElementId !== elementId) {
        regenerated.push(connection);
        continue;
      }
      const start = this.connectors.find(c => c.ownerElementId === connection.sourceElementId && c.def.name === connection.sourceConnector);
      const end = this.connectors.find(c => c.ownerElementId === connection.targetElementId && c.def.name === connection.targetConnector);
      if (!start || !end) continue;
      // Existing edges are engaged by definition; temporarily release only
      // these two ports so preview can validate/regenerate their own edge.
      const startState = { engaged: start.engaged, connectedTo: start.connectedTo };
      const endState = { engaged: end.engaged, connectedTo: end.connectedTo };
      start.engaged = false; start.connectedTo = null;
      end.engaged = false; end.connectedTo = null;
      const preview = previewMepConnection(start, end);
      start.engaged = startState.engaged; start.connectedTo = startState.connectedTo;
      end.engaged = endState.engaged; end.connectedTo = endState.connectedTo;
      if (!preview.valid) {
        disconnectMepConnectors(this.connectors, connection);
        continue;
      }
      regenerated.push({ ...connection, route: preview.route.map(p => [...p]), fittings: preview.fittings.map(f => ({ ...f })) });
    }
    this.connections = regenerated;
    this.reconcileConnectorEngagement();
    const affectedRemaining = recalculateAffectedMepProperties(this.connections, elementId);
    this.revision++;
    return {
      revision: this.revision,
      affectedConnectionIds: affectedRemaining.map(c => c.id),
      topologyIssues: validateMepNetworkTopology(this.connectors, this.connections),
      electricalIssues: validateElectricalDistribution(this.panels, this.loads),
    };
  }

  setElectricalDistribution(panels: ElectricalPanel[], loads: ElectricalLoad[]): ElectricalDiagnostic[] {
    const issues = validateElectricalDistribution(panels, loads);
    this.panels = panels.map(p => ({ ...p, circuits: p.circuits.map(c => ({ ...c, loadIds: [...c.loadIds] })) }));
    this.loads = loads.map(l => ({ ...l }));
    this.revision++;
    return issues;
  }

  getPanelSchedule(panelId: string): PanelSchedule {
    const panel = this.panels.find(p => p.id === panelId);
    if (!panel) throw new Error("Unknown electrical panel: " + panelId);
    return buildPanelSchedule(panel, this.loads);
  }

  validate(): MepEditResult {
    return {
      revision: this.revision,
      affectedConnectionIds: [],
      topologyIssues: validateMepNetworkTopology(this.connectors, this.connections),
      electricalIssues: validateElectricalDistribution(this.panels, this.loads),
    };
  }

  private requireConnector(elementId: string, name: string): MepConnector {
    const connector = this.connectors.find(c => c.ownerElementId === elementId && c.def.name === name);
    if (!connector) throw new Error("Unknown MEP connector: " + elementId + ":" + name);
    return connector;
  }

  private reconcileConnectorEngagement(): void {
    for (const c of this.connectors) { c.engaged = false; c.connectedTo = null; }
    for (const connection of this.connections) {
      const a = this.connectors.find(c => c.ownerElementId === connection.sourceElementId && c.def.name === connection.sourceConnector);
      const b = this.connectors.find(c => c.ownerElementId === connection.targetElementId && c.def.name === connection.targetConnector);
      if (a && b) {
        a.engaged = true; a.connectedTo = b.ownerElementId;
        b.engaged = true; b.connectedTo = a.ownerElementId;
      }
    }
  }
}

