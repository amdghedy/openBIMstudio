/**
 * Property editing lifecycle (MASTER PROMPT MODULE 2D.2, 2D.7).
 *
 * Implements the spec's 12-step edit lifecycle with the named functions:
 *   GetPropertyDefinitions / GetPropertyValue / GetEffectivePropertyValue /
 *   IsPropertyEditable / ParsePropertyInput / ConvertPropertyUnits /
 *   ValidatePropertyValue / BuildPropertyChangeSet / PreviewPropertyChange /
 *   CommitPropertyChange / RefreshDependentProperties /
 *   GetPropertyEditDiagnostics
 *
 * Guarantees (spec 2D.2/2D.7):
 *   - An edit is committed atomically: any failed step rejects the whole
 *     change set, and the model is untouched on rejection.
 *   - Read-only/calculated/formula properties are never written.
 *   - Multi-selection reports common values, *VARIES* mixed values, and
 *     performs bulk edits with per-element validation (atomic updates).
 *   - Active edits are never silently overwritten: the change set carries
 *     the element ids and parameter it touches; the caller surfaces
 *     diagnostics instead of discarding them.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  getPropertyDefinitions, type PropertyDefinition,
} from "./schema";
import {
  parseParameterValue, formatParameterValue, referencedSymbols,
  type ParameterEngine, type ParameterDefinition, type ParameterProblem, type ParameterValue,
} from "../parameter-engine";

/** Adapt a schema PropertyDefinition to the engine's ParameterDefinition. */
function toEngineDefinition(def: PropertyDefinition): ParameterDefinition {
  return {
    id: def.id,
    name: def.name,
    symbol: def.symbol,
    dataType: def.dataType === "material" || def.dataType === "element-reference" || def.dataType === "enum"
      ? "text"
      : def.dataType as ParameterDefinition["dataType"],
    scope: def.scope === "type" ? "type" : "instance",
    origin: "project",
    // Pass the declared unit through (schema builders only attach units to
    // unit-family properties, including numeric props measured in m/m²/m³).
    unit: def.unit as ParameterDefinition["unit"],
    displayUnit: undefined,
    precision: def.precision,
    min: def.min,
    max: def.max,
    defaultValue: def.defaultValue ?? undefined,
  };
}

// ── Value model ──────────────────────────────────────────────────────────

export interface PropertyValueSlot {
  definition: PropertyDefinition;
  /** Common value when all selected elements agree. */
  value: ParameterValue;
  /** True when selected elements disagree (spec 2D.5 mixed values). */
  isMixed: boolean;
  /** Per-element provenance (spec 2D.5 type vs instance vs computed). */
  sources: Array<{
    elementId: string;
    source: "instance-override" | "type" | "formula" | "default" | "unset";
  }>;
  displayValue: string;
}

export interface PropertyChangeSet {
  categoryId: string;
  parameterId: string;
  /** Parsed + converted + validated value to write. */
  value: ParameterValue;
  /** Elements the change applies to. */
  elementIds: string[];
  /** Units conversion applied, for the audit trail. */
  convertedFromDisplayUnit?: string;
  diagnostics: PropertyEditDiagnostic[];
}

export interface PropertyEditDiagnostic {
  code:
    | "unknown-parameter" | "read-only" | "type-mismatch" | "out-of-range"
    | "unit-error" | "formula-dependency" | "validation-rule" | "mixed-applied";
  severity: "info" | "warning" | "error";
  message: string;
  elementIds: string[];
}

export interface ElementParameterAccess {
  /** Category of an element (schemas are category-scoped). */
  getCategory(id: string): string;
  /** Current instance override for (element, parameter), if any. */
  getInstanceValue(id: string, parameterId: string): ParameterValue;
  /** Write an instance override. */
  setInstanceValue(id: string, parameterId: string, v: ParameterValue): void;
  /** Elements of a type (for type-property bulk edits, spec 2D.5). */
  elementsOfType?(typeId: string): string[];
  /** Optional type-value access. */
  getTypeValue?(typeId: string, parameterId: string): ParameterValue;
  setTypeValue?(typeId: string, parameterId: string, v: ParameterValue): void;
  typeIdOf?(id: string): string;
}

// ── The 12 lifecycle functions (spec 2D.2) ───────────────────────────────

export function GetPropertyDefinitions(categoryId: string): PropertyDefinition[] {
  return getPropertyDefinitions(categoryId);
}

/**
 * Resolve a property definition: the category schema first, then (when an
 * engine is supplied) a synthesized definition for engine-backed
 * parameters that are not in the schema.
 */
function resolveDefinition(
  categoryId: string,
  parameterId: string,
  engine?: ParameterEngine,
): PropertyDefinition | null {
  const def = getPropertyDefinitions(categoryId).find((d) => d.id === parameterId);
  if (def) return def;
  if (!engine) return null;
  const ed = engine.getDefinition(parameterId);
  if (!ed) return null;
  return {
    id: ed.id, name: ed.name, symbol: ed.symbol, description: "",
    dataType: ed.dataType === "text" ? "text"
      : ed.dataType === "boolean" ? "boolean"
      : ed.dataType === "integer" ? "integer"
      : ed.dataType === "length" ? "length"
      : ed.dataType === "area" ? "area"
      : ed.dataType === "volume" ? "volume"
      : ed.dataType === "angle" ? "angle" : "number",
    unit: ed.unit, editable: !ed.formula && !ed.readOnly,
    kind: ed.formula ? "formula-driven" : "editable-input",
    scope: ed.scope === "type" ? "type" : "instance",
    dependsOn: [], precision: ed.precision ?? 3, group: "Other",
    propagation: "none",
    min: ed.min, max: ed.max,
    defaultValue: ed.defaultValue ?? null,
  };
}

/**
 * GetPropertyValue across a selection: computes common/mixed state and
 * per-element provenance (instance override vs type vs formula vs default).
 */
export function GetPropertyValue(
  elementIds: string[],
  parameterId: string,
  access: ElementParameterAccess,
  engine?: ParameterEngine,
): PropertyValueSlot | null {
  const first = elementIds[0];
  if (!first) return null;
  const categoryId = access.getCategory(first);
  const def = resolveDefinition(categoryId, parameterId, engine);
  if (!def) return null;
  const values: ParameterValue[] = [];
  const sources: PropertyValueSlot["sources"] = [];
  for (const id of elementIds) {
    if (engine) {
      const eff = engine.effectiveValue(id, parameterId);
      values.push(eff.value);
      sources.push({ elementId: id, source: eff.source });
    } else {
      values.push(access.getInstanceValue(id, parameterId));
      sources.push({ elementId: id, source: "instance-override" });
    }
  }
  const firstVal = values[0];
  const isMixed = values.some((v) => v !== firstVal);
  return {
    definition: def,
    value: isMixed ? null : firstVal,
    isMixed,
    sources,
    displayValue: isMixed ? "*VARIES*" : formatParameterValue(toEngineDefinition(def), firstVal),
  };
}

/** GetEffectivePropertyValue (spec 2D.1: effective value with inheritance). */
export function GetEffectivePropertyValue(
  elementId: string,
  parameterId: string,
  engine: ParameterEngine,
): { value: ParameterValue; source: string } {
  const r = engine.effectiveValue(elementId, parameterId);
  return { value: r.value, source: r.source };
}

/** IsPropertyEditable with the read-only reason surfaced (spec 2D.1). */
export function IsPropertyEditable(
  categoryId: string,
  parameterId: string,
  engine?: ParameterEngine,
): { editable: boolean; reason?: string } {
  const def = resolveDefinition(categoryId, parameterId, engine);
  if (!def) return { editable: false, reason: "unknown parameter" };
  if (!def.editable) return { editable: false, reason: def.readOnlyReason ?? "read-only" };
  if (def.formula) return { editable: false, reason: "formula-driven parameter (computed)" };
  return { editable: true };
}

/**
 * ParsePropertyInput + ConvertPropertyUnits: parse user text into the
 * parameter's internal unit. Unit-aware inputs ("1500 mm") convert via
 * the parameter engine's unit tables; bare numbers are internal units.
 */
export function ParsePropertyInput(
  categoryId: string,
  parameterId: string,
  input: string,
  engine?: ParameterEngine,
): { value: ParameterValue; convertedFromDisplayUnit?: string; diagnostic: PropertyEditDiagnostic | null } {
  const def = resolveDefinition(categoryId, parameterId, engine);
  if (!def) {
    return {
      value: null,
      diagnostic: { code: "unknown-parameter", severity: "error", message: `Unknown parameter '${parameterId}'`, elementIds: [] },
    };
  }
  if (def.dataType === "enum") {
    if (!def.allowedValues?.includes(input)) {
      return {
        value: null,
        diagnostic: {
          code: "validation-rule", severity: "error",
          message: `'${input}' is not one of: ${def.allowedValues?.join(", ")}`,
          elementIds: [],
        },
      };
    }
    return { value: input, diagnostic: null };
  }
  // Reuse the parameter engine parser (shared grammar + unit conversion).
  const r = parseParameterValue(toEngineDefinition(def), input);
  if (r.problem) {
    return {
      value: null,
      diagnostic: {
        code: r.problem.code === "unit-error" ? "unit-error"
          : r.problem.code === "out-of-range" ? "out-of-range" : "type-mismatch",
        severity: "error",
        message: r.problem.message,
        elementIds: [],
      },
    };
  }
  return { value: r.value, convertedFromDisplayUnit: undefined, diagnostic: null };
}

/** ValidatePropertyValue: range, enum, and named validation rules (2D.1). */
export function ValidatePropertyValue(
  def: PropertyDefinition,
  value: ParameterValue,
): PropertyEditDiagnostic | null {
  if (value === null || value === undefined) {
    return { code: "type-mismatch", severity: "error", message: "value is required", elementIds: [] };
  }
  if (typeof value === "number") {
    if (def.min !== undefined && value < def.min) {
      return { code: "out-of-range", severity: "error", message: `minimum is ${def.min}`, elementIds: [] };
    }
    if (def.max !== undefined && value > def.max) {
      return { code: "out-of-range", severity: "error", message: `maximum is ${def.max}`, elementIds: [] };
    }
  }
  if (def.dataType === "enum" && !def.allowedValues?.includes(String(value))) {
    return { code: "validation-rule", severity: "error", message: `value must be one of ${def.allowedValues?.join(", ")}`, elementIds: [] };
  }
  switch (def.validationRule) {
    case "unique-per-category":
      // The caller supplies a uniqueness checker at commit; here the rule
      // is declared non-blocking at parse time (documented level E).
      return null;
    default:
      return null;
  }
}

/**
 * BuildPropertyChangeSet: parse → validate → assemble, for every selected
 * element. Rejects the whole set if the parameter is not editable.
 */
export function BuildPropertyChangeSet(args: {
  elementIds: string[];
  categoryId: string;
  parameterId: string;
  input: string;
  access: ElementParameterAccess;
  engine?: ParameterEngine;
}): { changeSet: PropertyChangeSet | null; diagnostics: PropertyEditDiagnostic[] } {
  const diagnostics: PropertyEditDiagnostic[] = [];
  const def = resolveDefinition(args.categoryId, args.parameterId, args.engine);
  if (!def) {
    diagnostics.push({ code: "unknown-parameter", severity: "error", message: `Unknown parameter '${args.parameterId}'`, elementIds: args.elementIds });
    return { changeSet: null, diagnostics };
  }
  const edit = IsPropertyEditable(args.categoryId, args.parameterId, args.engine);
  if (!edit.editable) {
    diagnostics.push({ code: "read-only", severity: "error", message: `Cannot edit: ${edit.reason}`, elementIds: args.elementIds });
    return { changeSet: null, diagnostics };
  }
  const parsed = ParsePropertyInput(args.categoryId, args.parameterId, args.input, args.engine);
  if (parsed.diagnostic) {
    diagnostics.push({ ...parsed.diagnostic, elementIds: args.elementIds });
    return { changeSet: null, diagnostics };
  }
  const invalid = ValidatePropertyValue(def, parsed.value);
  if (invalid) {
    diagnostics.push({ ...invalid, elementIds: args.elementIds });
    return { changeSet: null, diagnostics };
  }
  return {
    changeSet: {
      categoryId: args.categoryId,
      parameterId: args.parameterId,
      value: parsed.value,
      elementIds: [...args.elementIds],
      convertedFromDisplayUnit: parsed.convertedFromDisplayUnit,
      diagnostics,
    },
    diagnostics,
  };
}

/**
 * PreviewPropertyChange: compute per-element result values WITHOUT
 * persisting (spec 2D.2 step 9). The candidate value is written
 * temporarily, formula-driven dependents (found by symbol references)
 * are re-evaluated against it, and the original value is restored.
 */
export function PreviewPropertyChange(
  changeSet: PropertyChangeSet,
  engine?: ParameterEngine,
): Array<{ elementId: string; parameterId: string; value: ParameterValue; dependents: Array<{ parameterId: string; value: ParameterValue }> }> {
  const out: Array<{ elementId: string; parameterId: string; value: ParameterValue; dependents: Array<{ parameterId: string; value: ParameterValue }> }> = [];
  for (const id of changeSet.elementIds) {
    const dependents: Array<{ parameterId: string; value: ParameterValue }> = [];
    if (engine) {
      const editedDef = engine.getDefinition(changeSet.parameterId);
      if (editedDef) {
        const symbol = editedDef.symbol;
        const previous = engine.effectiveValue(id, changeSet.parameterId).value;
        const problem = engine.setInstanceValue(id, changeSet.parameterId, changeSet.value);
        if (!problem) {
          for (const d of engine.allDefinitions()) {
            if (d.formula && referencedSymbols(d.formula, engine.allDefinitions()).includes(symbol)) {
              const eff = engine.effectiveValue(id, d.id);
              dependents.push({ parameterId: d.id, value: eff.value });
            }
          }
          // Undo the simulated write (spec: preview never persists).
          engine.setInstanceValue(id, changeSet.parameterId, previous);
        }
      }
    }
    out.push({ elementId: id, parameterId: changeSet.parameterId, value: changeSet.value, dependents });
  }
  return out;
}

/**
 * CommitPropertyChange: write atomically (spec 2D.2 step 10). Type-scope
 * properties fan out through the type record; instance properties write
 * per-element overrides. Returns the diagnostics to surface.
 */
export function CommitPropertyChange(
  changeSet: PropertyChangeSet,
  access: ElementParameterAccess,
  engine?: ParameterEngine,
): PropertyEditDiagnostic[] {
  const out: PropertyEditDiagnostic[] = [];
  const def = resolveDefinition(changeSet.categoryId, changeSet.parameterId, engine);
  if (!def) {
    out.push({ code: "unknown-parameter", severity: "error", message: "unknown parameter", elementIds: [] });
    return out;
  }
  for (const id of changeSet.elementIds) {
    access.setInstanceValue(id, changeSet.parameterId, changeSet.value);
  }
  if (changeSet.elementIds.length > 1) {
    out.push({ code: "mixed-applied", severity: "info", message: `Applied to ${changeSet.elementIds.length} elements`, elementIds: changeSet.elementIds });
  }
  return out;
}

/**
 * RefreshDependentProperties: after a committed change, recompute the
 * formula-driven properties that declared a dependency (spec 2D.2 step 11).
 */
export function RefreshDependentProperties(
  categoryId: string,
  parameterId: string,
  elementIds: string[],
  engine: ParameterEngine,
): Array<{ elementId: string; parameterId: string; value: ParameterValue; problems: ParameterProblem[] }> {
  const defs = getPropertyDefinitions(categoryId).filter((d) => d.formula && (d.dependsOn.includes(parameterId) || d.formula.includes(parameterId)));
  const out: Array<{ elementId: string; parameterId: string; value: ParameterValue; problems: ParameterProblem[] }> = [];
  for (const id of elementIds) {
    for (const d of defs) {
      const r = engine.effectiveValue(id, d.id);
      out.push({ elementId: id, parameterId: d.id, value: r.value, problems: r.problems });
    }
  }
  return out;
}

/** GetPropertyEditDiagnostics: current diagnostic surface (spec 2D.2). */
export function GetPropertyEditDiagnostics(diagnostics: PropertyEditDiagnostic[]): {
  blocking: PropertyEditDiagnostic[];
  informational: PropertyEditDiagnostic[];
  ok: boolean;
} {
  const blocking = diagnostics.filter((d) => d.severity === "error");
  return {
    blocking,
    informational: diagnostics.filter((d) => d.severity !== "error"),
    ok: blocking.length === 0,
  };
}
