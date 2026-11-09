/**
 * Native electrical circuits and panel schedules.
 *
 * Pure engineering-data module: it does not infer a safe design from geometry.
 * All results are calculation/checking aids; the governing installation code wins.
 */

import { selectConductor, voltageDrop } from "./electrical-calc";

export type ElectricalPhase = 1 | 3;
export type CircuitStatus = "ok" | "warning" | "error";

export interface ElectricalLoad {
  id: string;
  name: string;
  /** Connected apparent power in VA. */
  apparentPowerVA: number;
  /** Nominal line voltage in V. */
  voltageV: number;
  phase: ElectricalPhase;
  /** Number of breaker poles required by the load, normally 1 or 3. */
  poles: 1 | 2 | 3;
  /** Power factor, 0 < PF <= 1. */
  powerFactor?: number;
  /** Demand factor in [0, 1]. Defaults to 1. */
  demandFactor?: number;
  /** Optional panel ID assignment. */
  panelId?: string;
  /** Optional circuit number assignment. */
  circuitNumber?: number;
}

export interface ElectricalCircuit {
  id: string;
  panelId: string;
  circuitNumber: number;
  loadIds: string[];
  breakerRatingA: number;
  poles: 1 | 2 | 3;
  voltageV: number;
  phase: ElectricalPhase;
  /** Optional design current after diversity/demand. */
  designCurrentA?: number;
  conductorAmpacityA?: number;
  /** One-way circuit length (m) — enables per-circuit wire sizing and voltage drop. */
  wireLengthM?: number;
  /** Circuit power factor for voltage drop (default 1 — resistive). */
  powerFactor?: number;
}

export interface ElectricalPanel {
  id: string;
  name: string;
  voltageV: number;
  phase: ElectricalPhase;
  /** Main/bus rating in amperes. */
  busRatingA: number;
  /** Optional main breaker rating; checked against bus and demand current. */
  mainBreakerRatingA?: number;
  /** Number of usable circuit positions. */
  circuitSpaces: number;
  circuits: ElectricalCircuit[];
}

export interface ElectricalDiagnostic {
  code: string;
  severity: CircuitStatus;
  message: string;
  panelId?: string;
  circuitId?: string;
  loadId?: string;
}

export interface PanelScheduleRow {
  circuitNumber: number;
  circuitId: string;
  loadNames: string[];
  loadIds: string[];
  poles: number;
  voltageV: number;
  phase: ElectricalPhase;
  connectedVA: number;
  demandVA: number;
  designCurrentA: number;
  breakerRatingA: number;
  conductorAmpacityA: number | null;
  /** Auto-selected conductor size (mm²) — null when no table entry fits. */
  wireSizeMm2: number | null;
  /** Voltage-drop percent over wireLengthM — null when no length given. */
  voltageDropPercent: number | null;
  status: CircuitStatus;
  diagnostics: string[];
}

export interface PanelSchedule {
  panelId: string;
  panelName: string;
  voltageV: number;
  phase: ElectricalPhase;
  busRatingA: number;
  totalConnectedVA: number;
  totalDemandVA: number;
  estimatedDemandCurrentA: number;
  usedSpaces: number;
  availableSpaces: number;
  rows: PanelScheduleRow[];
  diagnostics: ElectricalDiagnostic[];
}

/** Calculate nominal current from apparent power and nominal voltage. */
export function currentFromVA(apparentPowerVA: number, voltageV: number, phase: ElectricalPhase): number {
  if (!Number.isFinite(apparentPowerVA) || apparentPowerVA < 0) throw new Error("apparentPowerVA must be finite and non-negative");
  if (!Number.isFinite(voltageV) || voltageV <= 0) throw new Error("voltageV must be finite and positive");
  return apparentPowerVA / (phase === 3 ? Math.sqrt(3) * voltageV : voltageV);
}

export function effectiveDemandVA(load: ElectricalLoad): number {
  const factor = load.demandFactor ?? 1;
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw new Error(`Load '${load.id}' demandFactor must be between 0 and 1`);
  }
  if (!Number.isFinite(load.apparentPowerVA) || load.apparentPowerVA < 0) {
    throw new Error(`Load '${load.id}' apparentPowerVA must be finite and non-negative`);
  }
  return load.apparentPowerVA * factor;
}

function add(
  diagnostics: ElectricalDiagnostic[],
  code: string,
  severity: CircuitStatus,
  message: string,
  panelId?: string,
  circuitId?: string,
  loadId?: string,
): void {
  diagnostics.push({ code, severity, message, panelId, circuitId, loadId });
}

/**
 * Validate circuit assignments, panel compatibility, circuit protection,
 * conductor ampacity and panel capacity. Does not replace local electrical
 * code calculations, fault-current/interrupting-rating checks or coordination.
 */
export function validateElectricalDistribution(
  panels: readonly ElectricalPanel[],
  loads: readonly ElectricalLoad[],
): ElectricalDiagnostic[] {
  const diagnostics: ElectricalDiagnostic[] = [];
  const panelById = new Map<string, ElectricalPanel>();
  const loadById = new Map<string, ElectricalLoad>();
  for (const p of panels) {
    if (panelById.has(p.id)) add(diagnostics, "PANEL_ID_DUPLICATE", "error", `Panel ID '${p.id}' is duplicated.`, p.id);
    panelById.set(p.id, p);
  }
  for (const l of loads) {
    if (loadById.has(l.id)) add(diagnostics, "LOAD_ID_DUPLICATE", "error", `Load ID '${l.id}' is duplicated.`, l.panelId, undefined, l.id);
    loadById.set(l.id, l);
    if (!Number.isFinite(l.voltageV) || l.voltageV <= 0) add(diagnostics, "LOAD_VOLTAGE_INVALID", "error", "Load voltage must be finite and positive.", l.panelId, undefined, l.id);
    if (l.powerFactor !== undefined && (!Number.isFinite(l.powerFactor) || l.powerFactor <= 0 || l.powerFactor > 1)) {
      add(diagnostics, "POWER_FACTOR_INVALID", "error", "Power factor must be greater than 0 and no greater than 1.", l.panelId, undefined, l.id);
    }
    try { effectiveDemandVA(l); } catch (e) {
      add(diagnostics, "LOAD_DEMAND_INVALID", "error", e instanceof Error ? e.message : String(e), l.panelId, undefined, l.id);
    }
    if (l.panelId && !panelById.has(l.panelId)) {
      // Reported here and not silently treated as an unassigned load.
      add(diagnostics, "ASSIGNED_PANEL_MISSING", "error", `Load '${l.name}' references missing panel '${l.panelId}'.`, l.panelId, undefined, l.id);
    }
  }

  for (const panel of panels) {
    if (!Number.isFinite(panel.voltageV) || panel.voltageV <= 0) {
      add(diagnostics, "PANEL_VOLTAGE_INVALID", "error", "Panel voltage must be finite and positive.", panel.id);
    }
    if (!Number.isFinite(panel.busRatingA) || panel.busRatingA <= 0) {
      add(diagnostics, "PANEL_BUS_RATING_INVALID", "error", "Panel bus rating must be finite and positive.", panel.id);
    }
    if (!Number.isInteger(panel.circuitSpaces) || panel.circuitSpaces < 0) {
      add(diagnostics, "PANEL_SPACES_INVALID", "error", "Panel circuit spaces must be a non-negative integer.", panel.id);
    }
    if (panel.circuits.length > panel.circuitSpaces) {
      add(diagnostics, "PANEL_SPACE_OVERBOOKED", "error", `Panel has ${panel.circuits.length} circuits but only ${panel.circuitSpaces} circuit spaces.`, panel.id);
    }
    if (panel.mainBreakerRatingA !== undefined && panel.mainBreakerRatingA > panel.busRatingA) {
      add(diagnostics, "MAIN_BREAKER_EXCEEDS_BUS", "error", "Main breaker rating exceeds panel bus rating.", panel.id);
    }

    const seenNumbers = new Set<number>();
    const assignedLoads = new Set<string>();
    let totalDemandVA = 0;
    for (const circuit of panel.circuits) {
      if (seenNumbers.has(circuit.circuitNumber)) {
        add(diagnostics, "CIRCUIT_NUMBER_DUPLICATE", "error", `Circuit number ${circuit.circuitNumber} is duplicated on panel '${panel.name}'.`, panel.id, circuit.id);
      }
      seenNumbers.add(circuit.circuitNumber);
      if (!Number.isInteger(circuit.circuitNumber) || circuit.circuitNumber < 1) {
        add(diagnostics, "CIRCUIT_NUMBER_INVALID", "error", "Circuit number must be a positive integer.", panel.id, circuit.id);
      }
      if (!Number.isFinite(circuit.voltageV) || circuit.voltageV <= 0) {
        add(diagnostics, "CIRCUIT_VOLTAGE_INVALID", "error", "Circuit voltage must be finite and positive.", panel.id, circuit.id);
      }
      if (!Number.isFinite(circuit.breakerRatingA) || circuit.breakerRatingA <= 0) {
        add(diagnostics, "BREAKER_RATING_INVALID", "error", "Circuit breaker rating must be finite and positive.", panel.id, circuit.id);
      }
      if (circuit.panelId !== panel.id) {
        add(diagnostics, "CIRCUIT_PANEL_MISMATCH", "error", "Circuit panelId does not match its containing panel.", panel.id, circuit.id);
      }
      if (circuit.voltageV !== panel.voltageV || circuit.phase !== panel.phase) {
        add(diagnostics, "CIRCUIT_PANEL_SUPPLY_MISMATCH", "error", "Circuit nominal voltage/phase does not match the panel supply.", panel.id, circuit.id);
      }

      let connectedVA = 0;
      let demandVA = 0;
      for (const loadId of circuit.loadIds) {
        if (assignedLoads.has(loadId)) {
          add(diagnostics, "LOAD_ASSIGNED_MULTIPLE_TIMES", "error", `Load '${loadId}' is assigned to more than one circuit on panel '${panel.name}'.`, panel.id, circuit.id, loadId);
          continue;
        }
        assignedLoads.add(loadId);
        const load = loadById.get(loadId);
        if (!load) {
          add(diagnostics, "CIRCUIT_LOAD_MISSING", "error", `Circuit references missing load '${loadId}'.`, panel.id, circuit.id, loadId);
          continue;
        }
        if (load.panelId && load.panelId !== panel.id) {
          add(diagnostics, "LOAD_PANEL_ASSIGNMENT_MISMATCH", "error", `Load '${load.name}' is assigned to panel '${load.panelId}' but appears in '${panel.name}'.`, panel.id, circuit.id, load.id);
        }
        if (load.voltageV !== circuit.voltageV || load.phase !== circuit.phase) {
          add(diagnostics, "LOAD_CIRCUIT_SUPPLY_MISMATCH", "error", `Load '${load.name}' voltage/phase is incompatible with this circuit.`, panel.id, circuit.id, load.id);
        }
        if (load.poles !== circuit.poles) {
          add(diagnostics, "LOAD_CIRCUIT_POLE_MISMATCH", "error", `Load '${load.name}' requires ${load.poles} pole(s), circuit has ${circuit.poles}.`, panel.id, circuit.id, load.id);
        }
        connectedVA += Number.isFinite(load.apparentPowerVA) && load.apparentPowerVA >= 0 ? load.apparentPowerVA : 0;
        try { demandVA += effectiveDemandVA(load); } catch { /* already diagnosed above */ }
      }
      totalDemandVA += demandVA;
      const circuitSupplyValid = Number.isFinite(circuit.voltageV) && circuit.voltageV > 0;
      const designCurrentA = circuit.designCurrentA ?? (circuitSupplyValid ? currentFromVA(demandVA, circuit.voltageV, circuit.phase) : 0);
      if (!Number.isFinite(designCurrentA) || designCurrentA < 0) {
        add(diagnostics, "CIRCUIT_DESIGN_CURRENT_INVALID", "error", "Circuit design current must be finite and non-negative.", panel.id, circuit.id);
      } else if (designCurrentA > circuit.breakerRatingA + 1e-6) {
        add(diagnostics, "BREAKER_UNDERRATED", "error", `Design current ${designCurrentA.toFixed(2)} A exceeds breaker ${circuit.breakerRatingA} A.`, panel.id, circuit.id);
      }
      if (circuit.conductorAmpacityA !== undefined && circuit.conductorAmpacityA < designCurrentA - 1e-6) {
        add(diagnostics, "CONDUCTOR_AMPACITY_INSUFFICIENT", "error", `Conductor ampacity ${circuit.conductorAmpacityA} A is below design current ${designCurrentA.toFixed(2)} A.`, panel.id, circuit.id);
      }
      if (circuit.conductorAmpacityA !== undefined && circuit.conductorAmpacityA > circuit.breakerRatingA + 1e-6) {
        add(diagnostics, "PROTECTION_CONDUCTOR_REVIEW", "warning", "Conductor ampacity exceeds the breaker rating; verify conductor protection and applicable code requirements.", panel.id, circuit.id);
      }
      // Catch obviously inconsistent declared demand current vs load-derived current.
      const derived = circuitSupplyValid ? currentFromVA(demandVA, circuit.voltageV, circuit.phase) : 0;
      if (circuit.designCurrentA !== undefined && Math.abs(derived - circuit.designCurrentA) > Math.max(1, derived * 0.05)) {
        add(diagnostics, "DESIGN_CURRENT_DIVERGENCE", "warning", `Declared design current differs from load-derived current (${derived.toFixed(2)} A).`, panel.id, circuit.id);
      }
      void connectedVA;
    }

    const panelCurrent = Number.isFinite(panel.voltageV) && panel.voltageV > 0
      ? currentFromVA(totalDemandVA, panel.voltageV, panel.phase)
      : 0;
    if (panelCurrent > panel.busRatingA + 1e-6) {
      add(diagnostics, "PANEL_BUS_OVERLOAD", "error", `Estimated demand current ${panelCurrent.toFixed(2)} A exceeds bus rating ${panel.busRatingA} A.`, panel.id);
    }
    if (panel.mainBreakerRatingA !== undefined && panelCurrent > panel.mainBreakerRatingA + 1e-6) {
      add(diagnostics, "PANEL_MAIN_BREAKER_OVERLOAD", "error", `Estimated demand current ${panelCurrent.toFixed(2)} A exceeds main breaker ${panel.mainBreakerRatingA} A.`, panel.id);
    }
  }

  return diagnostics;
}

export interface CircuitWireResult {
  /** Selected conductor size in mm² (null when nothing in the table fits). */
  wireSizeMm2: number | null;
  /** Reference ampacity of the selected size (null with the size). */
  ampacityA: number | null;
  /** Voltage drop percent over the circuit length (null when no length). */
  dropPercent: number | null;
  /** Diagnostics generated by the wire sizing / drop check. */
  diagnostics: ElectricalDiagnostic[];
}

/**
 * Per-circuit wire sizing and voltage-drop check (IEC 60364-4-43 / 5-52
 * practice): the smallest standard conductor whose reference ampacity
 * covers the design current, then the drop over `wireLengthM` when the
 * length is known. 3% drop is advisory, 5% is an error.
 */
export function wireCircuit(
  circuit: ElectricalCircuit,
  designCurrentA: number,
  panelId: string,
): CircuitWireResult {
  const diagnostics: ElectricalDiagnostic[] = [];
  const wire = designCurrentA > 0 ? selectConductor(designCurrentA) : null;
  if (designCurrentA > 0 && !wire) {
    diagnostics.push({
      code: "WIRE_SIZE_UNAVAILABLE", severity: "error", panelId,
      circuitId: circuit.id,
      message: `Design current ${designCurrentA.toFixed(1)} A exceeds the largest reference conductor — split the circuit or upsize the supply.`,
    });
  }
  let dropPercent: number | null = null;
  if (circuit.wireLengthM != null && circuit.wireLengthM > 0 && wire && designCurrentA > 0) {
    const vd = voltageDrop({
      phase: circuit.phase,
      voltageV: circuit.voltageV,
      currentA: designCurrentA,
      lengthM: circuit.wireLengthM,
      conductorMm2: wire.mm2,
      powerFactor: circuit.powerFactor,
    });
    dropPercent = Math.round(vd.dropPercent * 100) / 100;
    if (dropPercent > 5) {
      diagnostics.push({
        code: "VOLTAGE_DROP_EXCEEDED", severity: "error", panelId,
        circuitId: circuit.id,
        message: `Voltage drop ${dropPercent.toFixed(2)}% over ${circuit.wireLengthM} m exceeds 5% — upsize the conductor or shorten the run.`,
      });
    } else if (dropPercent > 3) {
      diagnostics.push({
        code: "VOLTAGE_DROP_HIGH", severity: "warning", panelId,
        circuitId: circuit.id,
        message: `Voltage drop ${dropPercent.toFixed(2)}% over ${circuit.wireLengthM} m exceeds the 3% advisory limit.`,
      });
    }
  }
  return {
    wireSizeMm2: wire ? wire.mm2 : null,
    ampacityA: wire ? wire.ampacityA : null,
    dropPercent,
    diagnostics,
  };
}

/** Generate deterministic panel schedule rows and a panel-level load summary. */
export function buildPanelSchedule(panel: ElectricalPanel, loads: readonly ElectricalLoad[]): PanelSchedule {
  const byId = new Map(loads.map((load) => [load.id, load]));
  const diagnostics = validateElectricalDistribution([panel], loads);
  const severity = (list: readonly ElectricalDiagnostic[]): CircuitStatus =>
    list.some((d) => d.severity === "error") ? "error" : list.some((d) => d.severity === "warning") ? "warning" : "ok";
  const built = panel.circuits.map((circuit) => {
    const circuitDiagnostics = diagnostics.filter((d) => d.circuitId === circuit.id);
    const rowLoads = circuit.loadIds.map((id) => byId.get(id)).filter((x): x is ElectricalLoad => !!x);
    const connectedVA = rowLoads.reduce((sum, load) => sum + (Number.isFinite(load.apparentPowerVA) && load.apparentPowerVA >= 0 ? load.apparentPowerVA : 0), 0);
    const demandVA = rowLoads.reduce((sum, load) => {
      try { return sum + effectiveDemandVA(load); } catch { return sum; }
    }, 0);
    const designCurrentA = circuit.designCurrentA ?? currentFromVA(demandVA, circuit.voltageV, circuit.phase);
    // Wire sizing + voltage drop ride with the row: their findings carry the
    // same weight as the distribution diagnostics for the row status.
    const wire = wireCircuit(circuit, designCurrentA, panel.id);
    const rowDiagnostics = [...circuitDiagnostics, ...wire.diagnostics];
    const row: PanelScheduleRow = {
      circuitNumber: circuit.circuitNumber,
      circuitId: circuit.id,
      loadNames: rowLoads.map((load) => load.name),
      loadIds: circuit.loadIds.slice(),
      poles: circuit.poles,
      voltageV: circuit.voltageV,
      phase: circuit.phase,
      connectedVA,
      demandVA,
      designCurrentA,
      breakerRatingA: circuit.breakerRatingA,
      conductorAmpacityA: circuit.conductorAmpacityA ?? null,
      wireSizeMm2: wire.wireSizeMm2,
      voltageDropPercent: wire.dropPercent,
      status: severity(rowDiagnostics),
      diagnostics: rowDiagnostics.map((d) => d.code),
    };
    return { row, wireDiagnostics: wire.diagnostics };
  });
  const rows: PanelScheduleRow[] = built
    .map((b) => b.row)
    .sort((a, b) => a.circuitNumber - b.circuitNumber || a.circuitId.localeCompare(b.circuitId));
  const totalConnectedVA = rows.reduce((sum, row) => sum + row.connectedVA, 0);
  const totalDemandVA = rows.reduce((sum, row) => sum + row.demandVA, 0);
  const allDiagnostics = [...diagnostics, ...built.flatMap((b) => b.wireDiagnostics)];
  const estimatedDemandCurrentA = Number.isFinite(panel.voltageV) && panel.voltageV > 0
    ? currentFromVA(totalDemandVA, panel.voltageV, panel.phase)
    : 0;
  return {
    panelId: panel.id,
    panelName: panel.name,
    voltageV: panel.voltageV,
    phase: panel.phase,
    busRatingA: panel.busRatingA,
    totalConnectedVA,
    totalDemandVA,
    estimatedDemandCurrentA,
    usedSpaces: panel.circuits.length,
    availableSpaces: Math.max(0, panel.circuitSpaces - panel.circuits.length),
    rows,
    diagnostics: allDiagnostics,
  };
}
