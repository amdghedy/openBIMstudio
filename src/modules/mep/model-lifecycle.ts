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
  return { ...c, worldOrigin: [...c.worldOrigin], worldDirection: [...c.worldDirection], def: { ...c.def } };
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
    this.connections = (snapshot.connections ?? []).map(c => ({
      ...c, route: c.route.map(p => [...p]), fittings: c.fittings.map(f => ({ ...f })),
    }));
    this.panels = (snapshot.panels ?? []).map(p => ({ ...p, circuits: p.circuits.map(c => ({ ...c, loadIds: [...c.loadIds] })) }));
    this.loads = (snapshot.loads ?? []).map(l => ({ ...l }));
    this.reconcileConnectorEngagement();
    this.revision++;
  }

  snapshot(): MepModelSnapshot {
    return {
      revision: this.revision,
      connectors: this.connectors.map(cloneConnector),
      connections: this.connections.map(c => ({ ...c, route: c.route.map(p => [...p]), fittings: c.fittings.map(f => ({ ...f })) })),
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
    return connection;
  }

  /**
   * Called after the native authoring tool changes an element's geometry or
   * connector definitions. Edges touching that element are invalidated if a
   * connector disappeared or became incompatible; valid edges are marked
   * affected so route/fitting regeneration can be queued by the host.
   */
  onElementChanged(elementId: string, nextConnectors: MepConnector[]): MepEditResult {
    const previousIds = new Set(this.connectors.filter(c => c.ownerElementId === elementId).map(c => c.def.name));
    const next = nextConnectors.filter(c => c.ownerElementId === elementId).map(cloneConnector);
    if (next.some(c => c.ownerElementId !== elementId)) throw new Error("nextConnectors must belong to the changed element");
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
      const changed = s ?? t;
      if (removedNames.has(connection.sourceElementId === elementId ? connection.sourceConnector : connection.targetConnector) ||
          !changed || !other || !evaluateConnectorCompatibility(changed, other).compatible) invalidIds.add(connection.id);
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
      const preview = previewMepConnection(start, end);
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

