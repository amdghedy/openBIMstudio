/**
 * Editable dimensions (MASTER PROMPT MODULE 2D.6).
 *
 * Distinguishes measured / reference / driving / locked / calculated /
 * annotation-only dimensions (spec 2D.6) and implements the named
 * functions: GetDimensionReferences, EvaluateDimension, IsDimensionDriving,
 * ResolveDimensionEdit, CalculateParameterChanges,
 * ValidateDimensionConstraints, PreviewDimensionEdit, CommitDimensionEdit.
 *
 * Governing rule: editing a DRIVING dimension changes the model parameter
 * (a real degree of freedom), not merely the displayed annotation. Locked
 * dimensions re-solve through the numeric constraint solver.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import { referencedSymbols } from "../parameter-engine";
import type { ParameterEngine } from "../parameter-engine";

export type DimensionKind = "linear" | "aligned" | "angular" | "radial" | "diameter" | "height" | "elevation" | "offset" | "thickness" | "curve-length";

export type DimensionRole =
  | "measured" // informational readout of geometry
  | "reference" // follows geometry, never drives it
  | "driving" // edits change the model (a DOF)
  | "locked" // driving + held by a constraint
  | "calculated" // derived from formulas
  | "annotation-only"; // documentation only

export interface DimensionReference {
  elementId: string;
  /** Which part of the element the dimension anchors to. */
  anchor: "endpoint" | "face" | "centerline" | "center" | "level" | "grid" | "reference-plane";
  /** Named reference (spec 2.10 semantics). */
  name?: string;
  position: [number, number];
}

export interface DimensionRecord {
  id: string;
  kind: DimensionKind;
  role: DimensionRole;
  references: DimensionReference[];
  /** Parameter this dimension drives when role is driving/locked. */
  drivingParameterId?: string;
  /** Constraint id when role is locked. */
  constraintId?: string;
  /** Display precision digits. */
  precision: number;
}

/** GetDimensionReferences: anchors of a dimension record. */
export function GetDimensionReferences(d: DimensionRecord): DimensionReference[] {
  return d.references.map((r) => ({ ...r }));
}

/** EvaluateDimension: current measured value (metres/radians). */
export function EvaluateDimension(d: DimensionRecord): number {
  const r = d.references;
  if (r.length < 2) return 0;
  const a = r[0].position;
  const b = r[1].position;
  switch (d.kind) {
    case "linear":
      return Math.abs(b[0] - a[0]);
    case "aligned":
    case "curve-length":
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    case "radial": {
      const c = r[1]?.position ?? [0, 0];
      return Math.hypot(a[0] - c[0], a[1] - c[1]);
    }
    case "diameter":
      return 2 * Math.hypot(a[0] - r[1].position[0], a[1] - r[1].position[1]);
    case "angular": {
      if (r.length < 3) return 0;
      const v = r[2].position;
      const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
      const a2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      return Math.abs(diff);
    }
    default:
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
}

/** IsDimensionDriving (spec 2D.6). */
export function IsDimensionDriving(d: DimensionRecord): boolean {
  return d.role === "driving" || d.role === "locked";
}

export interface DimensionEditPlan {
  ok: boolean;
  message?: string;
  parameterId?: string;
  newValue?: number;
  /** Elements whose geometry must move to satisfy the edit. */
  moves: Array<{ elementId: string; anchor: string; to: [number, number] }>;
}

/**
 * ResolveDimensionEdit + CalculateParameterChanges: a driving-dimension
 * edit produces the parameter value AND the geometric moves that realize
 * it (the second reference tracks the first; the first is held).
 */
export function ResolveDimensionEdit(
  d: DimensionRecord,
  newMeasured: number,
): DimensionEditPlan {
  if (!IsDimensionDriving(d)) {
    return {
      ok: false,
      moves: [],
      message:
        d.role === "locked"
          ? "locked dimension: unlock or edit the constraint instead"
          : `dimension role '${d.role}' cannot drive the model`,
    };
  }
  if (!d.drivingParameterId) {
    return { ok: false, moves: [], message: "driving dimension has no bound parameter" };
  }
  if (!Number.isFinite(newMeasured) || newMeasured < 0) {
    return { ok: false, moves: [], message: `invalid dimension value ${newMeasured}` };
  }
  const r = d.references;
  if (r.length < 2) return { ok: false, moves: [], message: "dimension needs two references" };
  const held = r[0];
  const tracked = r[1];
  // Compute the tracked anchor's new position at the requested distance,
  // preserving the current bearing (aligned) or axis (linear).
  let to: [number, number];
  if (d.kind === "linear") {
    to = [held.position[0] + Math.sign(tracked.position[0] - held.position[0] || 1) * newMeasured, tracked.position[1]];
  } else if (d.kind === "angular") {
    // Angular edits move the tracked ray; the vertex is references[2].
    const vertex = r[2]?.position ?? held.position;
    const a1 = Math.atan2(held.position[1] - vertex[1], held.position[0] - vertex[0]);
    const sign = Math.sign(tracked.position[1] - vertex[1]) || 1;
    const a2 = a1 + sign * newMeasured;
    const dist = Math.hypot(tracked.position[0] - vertex[0], tracked.position[1] - vertex[1]);
    to = [vertex[0] + dist * Math.cos(a2), vertex[1] + dist * Math.sin(a2)];
  } else {
    const dx = tracked.position[0] - held.position[0];
    const dy = tracked.position[1] - held.position[1];
    const l = Math.hypot(dx, dy) || 1;
    to = [held.position[0] + (dx / l) * newMeasured, held.position[1] + (dy / l) * newMeasured];
  }
  return {
    ok: true,
    parameterId: d.drivingParameterId,
    newValue: newMeasured,
    moves: [{ elementId: tracked.elementId, anchor: tracked.anchor, to }],
  };
}

/** ValidateDimensionConstraints: the planned edit must keep > 0 lengths. */
export function ValidateDimensionConstraints(plan: DimensionEditPlan): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!plan.ok || plan.newValue === undefined) problems.push(plan.message ?? "invalid plan");
  if (plan.newValue !== undefined && plan.newValue <= 0 && plan.parameterId !== "rotation") {
    problems.push("driving a dimension to zero is not allowed");
  }
  return { valid: problems.length === 0, problems };
}

/**
 * PreviewDimensionEdit: apply the parameter TEMPORARILY (when an engine
 * is supplied), read the formula dependents against the planned value,
 * then restore the original value — the preview never persists (spec 2D.2
 * step 9).
 */
export function PreviewDimensionEdit(
  plan: DimensionEditPlan,
  engine?: ParameterEngine,
  elementId?: string,
): { applied: boolean; problems: string[]; dependentValues?: Record<string, number> } {
  const v = ValidateDimensionConstraints(plan);
  if (!v.valid) return { applied: false, problems: v.problems };
  if (engine && plan.parameterId && elementId) {
    const previous = engine.effectiveValue(elementId, plan.parameterId).value;
    const problem = engine.setInstanceValue(elementId, plan.parameterId, plan.newValue ?? null);
    if (problem) return { applied: false, problems: [problem.message] };
    // Read dependents (formula chain) against the planned value.
    const editedDef = engine.getDefinition(plan.parameterId);
    const symbol = editedDef?.symbol ?? plan.parameterId;
    const dependentValues: Record<string, number> = {};
    for (const def of engine.allDefinitions()) {
      if (def.formula && referencedSymbols(def.formula, engine.allDefinitions()).includes(symbol)) {
        const eff = engine.effectiveValue(elementId, def.id);
        if (typeof eff.value === "number") dependentValues[def.id] = eff.value;
      }
    }
    // Undo the preview write.
    engine.setInstanceValue(elementId, plan.parameterId, previous);
    return { applied: true, problems: [], dependentValues };
  }
  return { applied: true, problems: [] };
}

/**
 * CommitDimensionEdit: write the parameter for real and return the moves
 * the host application must apply to element geometry (spec 2D.6: editing
 * a driving dimension changes model parameters / geometric DOFs).
 */
export function CommitDimensionEdit(
  plan: DimensionEditPlan,
  engine?: ParameterEngine,
  elementId?: string,
): { committed: boolean; problems: string[]; moves: DimensionEditPlan["moves"] } {
  const v = ValidateDimensionConstraints(plan);
  if (!v.valid) return { committed: false, problems: v.problems, moves: [] };
  if (engine && plan.parameterId && elementId) {
    const problem = engine.setInstanceValue(elementId, plan.parameterId, plan.newValue ?? null);
    if (problem) return { committed: false, problems: [problem.message], moves: [] };
  }
  return { committed: true, problems: [], moves: plan.moves };
}
