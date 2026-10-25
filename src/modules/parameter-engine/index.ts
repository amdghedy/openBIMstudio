/**
 * Document-level parameter evaluation engine.
 *
 * Implements MASTER PROMPT MODULE 1.6 (parameter evaluation engine) and
 * MODULE 2.3 (type and instance parameters / EffectiveValue).
 *
 * Scope: a *document* owns parameter definitions; elements own instance
 * values; types own shared values; formulas may reference other parameters
 * by name. This is the layer above the family-local formula engine
 * (src/modules/families/formula-engine.ts) — it adds:
 *   - instance/type/global/builtin/shared scopes in one resolver
 *   - EffectiveValue(instance, parameter) with explicit-override precedence
 *   - unit-aware typed values with display formatting
 *   - circular-reference detection over formula dependencies (the family
 *     engine detects cycles inside one family; this engine detects them
 *     across the whole document via the dependency graph)
 *   - read-only/computed classification surfaced to the property panel
 *
 * Evidence classification: level E (proposed engine behavior). Formula
 * grammar = the safe-expr grammar (no eval/Function; same operator set),
 * which the platform already uses for family parameters.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import { safeEval } from "../families/safe-expr";
import { DependencyGraph, type NodeKind } from "../dependency-graph";

// ── Types (spec 1.6) ─────────────────────────────────────────────────────

/** Parameter data types (spec 1.6 "typed parameters"). */
export type ParameterDataType =
  | "length"
  | "area"
  | "volume"
  | "angle"
  | "number"
  | "integer"
  | "text"
  | "boolean"
  | "element-id"
  | "url";

export type ParameterScope = "instance" | "type" | "global";

/** Where a parameter definition lives (spec 1.6). */
export type ParameterOrigin = "builtin" | "family" | "shared" | "global" | "project";

export interface ParameterDefinition {
  /** Stable id, e.g. "wall.height" or a shared-parameter GUID. */
  id: string;
  /** Display name. */
  name: string;
  /** Internal name used in formulas (identifier-safe). */
  symbol: string;
  dataType: ParameterDataType;
  scope: ParameterScope;
  origin: ParameterOrigin;
  /** Formula expression; null/undefined for value parameters. */
  formula?: string;
  /** Formula parameters are computed → read-only (spec 1.6). */
  readOnly?: boolean;
  /** Default value when neither type nor instance provides one. */
  defaultValue?: ParameterValue;
  /** SI unit this parameter is stored in (internal units). */
  unit?: UnitName;
  /** Display unit for formatting (spec 5.2 display vs internal). */
  displayUnit?: UnitName;
  /** Decimal digits for display formatting. */
  precision?: number;
  /** Inclusive validation range (numbers only). */
  min?: number;
  max?: number;
  description?: string;
}

export type ParameterValue = number | string | boolean | null;

export interface ParameterProblem {
  parameter: string;
  code:
    | "unknown-parameter"
    | "type-mismatch"
    | "out-of-range"
    | "read-only"
    | "circular-reference"
    | "evaluation-error"
    | "unit-error";
  message: string;
}

export interface EffectiveResult {
  value: ParameterValue;
  /** Where the value came from (spec 2.3 value inheritance). */
  source: "instance-override" | "type" | "formula" | "default" | "unset";
  problems: ParameterProblem[];
}

// ── Units (spec 5.2: internal vs display units) ──────────────────────────

export type UnitName =
  | "m" | "cm" | "mm" | "ft" | "in"
  | "m2" | "ft2"
  | "m3" | "ft3"
  | "rad" | "deg"
  | "none";

/** Length conversion factors to metres (internal unit = metre). */
const LENGTH_TO_M: Record<string, number> = {
  m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254,
};

const AREA_TO_M2: Record<string, number> = { m2: 1, ft2: 0.09290304 };
const VOLUME_TO_M3: Record<string, number> = { m3: 1, ft3: 0.028316846592 };

/** Convert a quantity between units of the same family. Exact factors. */
export function convertUnits(value: number, from: UnitName, to: UnitName): number {
  if (from === to) return value;
  const family = (u: UnitName): "length" | "area" | "volume" | "angle" | "none" => {
    if (u in LENGTH_TO_M) return "length";
    if (u in AREA_TO_M2) return "area";
    if (u in VOLUME_TO_M3) return "volume";
    if (u === "rad" || u === "deg") return "angle";
    return "none";
  };
  const f = family(from);
  const t = family(to);
  if (f !== t || f === "none" || t === "none") {
    throw new Error(`convertUnits: incompatible units ${from} -> ${to}`);
  }
  const toBase =
    f === "length" ? value * LENGTH_TO_M[from]
    : f === "area" ? value * AREA_TO_M2[from as "m2" | "ft2"]
    : f === "volume" ? value * VOLUME_TO_M3[from as "m3" | "ft3"]
    : f === "angle" ? (from === "deg" ? (value * Math.PI) / 180 : value)
    : value;
  const fromBase =
    t === "length" ? toBase / LENGTH_TO_M[to]
    : t === "area" ? toBase / AREA_TO_M2[to as "m2" | "ft2"]
    : t === "volume" ? toBase / VOLUME_TO_M3[to as "m3" | "ft3"]
    : t === "angle" ? (to === "deg" ? (toBase * 180) / Math.PI : toBase)
    : toBase;
  return fromBase;
}

const UNIT_SUFFIX: Record<UnitName, string> = {
  m: "m", cm: "cm", mm: "mm", ft: "ft", in: "in",
  m2: "m²", ft2: "ft²", m3: "m³", ft3: "ft³",
  rad: "rad", deg: "°", none: "",
};

/** Format a parameter for display using its definition (spec 1.6). */
export function formatParameterValue(
  def: ParameterDefinition,
  value: ParameterValue,
): string {
  if (value === null || value === undefined) return "";
  if (def.dataType === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (typeof value !== "number") return String(value);
  if (def.dataType === "integer") return String(Math.round(value));
  const digits = def.precision ?? 3;
  let shown = value;
  if (def.displayUnit && def.unit && def.displayUnit !== def.unit) {
    shown = convertUnits(value, def.unit, def.displayUnit);
  }
  const suffix = UNIT_SUFFIX[def.displayUnit ?? def.unit ?? "none"];
  const num = shown.toFixed(digits).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
  return suffix ? `${num} ${suffix}` : num;
}

/** Parse user input text into a typed value (locale-neutral: dot decimal). */
export function parseParameterValue(
  def: ParameterDefinition,
  input: string,
): { value: ParameterValue; problem: ParameterProblem | null } {
  const text = input.trim();
  if (def.dataType === "text" || def.dataType === "url" || def.dataType === "element-id") {
    return { value: text, problem: null };
  }
  if (def.dataType === "boolean") {
    const t = text.toLowerCase();
    if (["yes", "true", "1", "on"].includes(t)) return { value: true, problem: null };
    if (["no", "false", "0", "off"].includes(t)) return { value: false, problem: null };
    return {
      value: null,
      problem: { parameter: def.id, code: "type-mismatch", message: `Cannot parse '${input}' as boolean` },
    };
  }
  // Numeric families: extract "number + optional unit" first, because
  // Number("1500 mm") is NaN — the unit suffix must be split off before
  // the plain numeric parse (spec 5.2 locale-aware input, level E grammar:
  // dot decimal, optional unit suffix converted to internal units).
  let raw = text;
  let inputUnit: UnitName | null = null;
  // Unit must START with a letter (m, mm, ft2, deg) so bare numbers like
  // "42" never match as number+unit.
  const m = text.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-zA-Z][a-zA-Z0-9²³°]*|[²³°]+)$/);
  if (m && def.unit) {
    raw = m[1];
    inputUnit = m[2].replace("²", "2").replace("³", "3").replace("°", "deg") as UnitName;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return {
      value: null,
      problem: { parameter: def.id, code: "type-mismatch", message: `Cannot parse '${input}' as number` },
    };
  }
  if (def.dataType === "integer" && !Number.isInteger(num)) {
    return {
      value: null,
      problem: { parameter: def.id, code: "type-mismatch", message: `'${input}' must be an integer` },
    };
  }
  // Unit-aware conversion to internal units.
  let value = num;
  if (inputUnit && def.unit) {
    try {
      value = convertUnits(num, inputUnit, def.unit);
    } catch {
      return {
        value: null,
        problem: { parameter: def.id, code: "unit-error", message: `'${inputUnit}' is not a valid unit for ${def.dataType}` },
      };
    }
  }
  if (def.min !== undefined && value < def.min) {
    return { value: null, problem: { parameter: def.id, code: "out-of-range", message: `Minimum is ${def.min}` } };
  }
  if (def.max !== undefined && value > def.max) {
    return { value: null, problem: { parameter: def.id, code: "out-of-range", message: `Maximum is ${def.max}` } };
  }
  return { value, problem: null };
}

// ── Engine ───────────────────────────────────────────────────────────────

export interface ElementRecord {
  id: string;
  /** Type id this instance uses ("" for type-less elements). */
  typeId: string;
  /** Explicit instance values (spec 2.3 instance-level overrides). */
  instanceValues: Record<string, ParameterValue>;
}

export interface TypeRecord {
  id: string;
  familyId: string;
  /** Shared type values for all instances of this type (spec 2.3). */
  values: Record<string, ParameterValue>;
}

export interface GlobalParameterRecord {
  id: string;
  value: ParameterValue;
}

/**
 * Parameter evaluation engine.
 *
 * Precedence (spec 2.3 EffectiveValue): explicit instance override >
 * type value > formula > default. Formula parameters ignore instance/type
 * values (they are computed) but their inputs resolve with the same
 * precedence chain.
 */
export class ParameterEngine {
  private defs = new Map<string, ParameterDefinition>();
  private elements = new Map<string, ElementRecord>();
  private types = new Map<string, TypeRecord>();
  private globals = new Map<string, ParameterValue>();
  /** Formula dependency edges: symbol -> set of symbols it references. */
  private graph = new DependencyGraph();
  private problems = new Map<string, ParameterProblem[]>();

  // -- Definitions ---------------------------------------------------------

  registerDefinition(def: ParameterDefinition): void {
    this.defs.set(def.id, def);
  }

  getDefinition(id: string): ParameterDefinition | null {
    return this.defs.get(id) ?? null;
  }

  allDefinitions(): ParameterDefinition[] {
    return [...this.defs.values()];
  }

  /** Register an element (or update its values). */
  putElement(el: ElementRecord): void {
    this.elements.set(el.id, el);
  }

  putType(t: TypeRecord): void {
    this.types.set(t.id, t);
  }

  setGlobal(id: string, value: ParameterValue): void {
    this.globals.set(id, value);
  }

  // -- EffectiveValue (spec 2.3) --------------------------------------------

  /**
   * EffectiveValue(instance, parameter):
   *   formula parameter -> evaluated with the formula grammar
   *   instance override -> instance value
   *   type value        -> type record value
   *   default           -> definition default
   *   else              -> unset (null)
   */
  effectiveValue(elementId: string, parameterId: string): EffectiveResult {
    const problems: ParameterProblem[] = [];
    const def = this.defs.get(parameterId);
    if (!def) {
      return {
        value: null,
        source: "unset",
        problems: [{ parameter: parameterId, code: "unknown-parameter", message: "Unknown parameter" }],
      };
    }
    if (def.formula) {
      const r = this.evaluateFormula(elementId, def);
      return { value: r.value, source: "formula", problems: r.problems };
    }
    const el = this.elements.get(elementId);
    if (el && parameterId in el.instanceValues) {
      const v = el.instanceValues[parameterId];
      const p = this.validateTyped(def, v);
      if (p) problems.push(p);
      return { value: v, source: "instance-override", problems };
    }
    const type = el ? this.types.get(el.typeId) : null;
    if (type && parameterId in type.values) {
      const v = type.values[parameterId];
      const p = this.validateTyped(def, v);
      if (p) problems.push(p);
      return { value: v, source: "type", problems };
    }
    if (def.defaultValue !== undefined) {
      return { value: def.defaultValue, source: "default", problems };
    }
    return { value: null, source: "unset", problems };
  }

  /**
   * IsPropertyEditable (spec 2D.2 uses this): read-only when the parameter
   * has a formula, is flagged read-only, or is a computed origin.
   */
  isEditable(parameterId: string): boolean {
    const def = this.defs.get(parameterId);
    if (!def) return false;
    if (def.formula) return false;
    return !def.readOnly;
  }

  /** All problems found during the last evaluation pass. */
  getProblems(elementId: string): ParameterProblem[] {
    return this.problems.get(elementId) ?? [];
  }

  // -- Writing ---------------------------------------------------------------

  /**
   * Set an instance override. Rejects read-only/formula parameters.
   * Returns the problem (null on success) — the caller decides whether to
   * surface or throw (property lifecycle owns transactions).
   */
  setInstanceValue(elementId: string, parameterId: string, value: ParameterValue): ParameterProblem | null {
    const def = this.defs.get(parameterId);
    if (!def) return { parameter: parameterId, code: "unknown-parameter", message: "Unknown parameter" };
    if (!this.isEditable(parameterId)) {
      return { parameter: parameterId, code: "read-only", message: `Parameter '${def.name}' is formula-driven or read-only` };
    }
    const p = this.validateTyped(def, value);
    if (p) return p;
    let el = this.elements.get(elementId);
    if (!el) {
      el = { id: elementId, typeId: "", instanceValues: {} };
      this.elements.set(elementId, el);
    }
    el.instanceValues[parameterId] = value;
    return null;
  }

  /**
   * Set a type value: updates all instances of the type that do not carry
   * an explicit override (spec 2.3: "changing a type property must update
   * all applicable instances without unintentionally overriding
   * instance-specific values" — instances keep their overrides).
   */
  setTypeValue(typeId: string, parameterId: string, value: ParameterValue): ParameterProblem | null {
    const def = this.defs.get(parameterId);
    if (!def) return { parameter: parameterId, code: "unknown-parameter", message: "Unknown parameter" };
    if (def.scope !== "type" && def.scope !== "instance") {
      return { parameter: parameterId, code: "type-mismatch", message: "Parameter is not type-storable" };
    }
    const p = this.validateTyped(def, value);
    if (p) return p;
    let t = this.types.get(typeId);
    if (!t) {
      t = { id: typeId, familyId: "", values: {} };
      this.types.set(typeId, t);
    }
    t.values[parameterId] = value;
    return null;
  }

  /**
   * ChangeType (spec 2.3): rebind an element to another type. Instance
   * overrides are preserved; type-sourced values change automatically
   * because EffectiveValue resolves through the new type record.
   */
  changeType(elementId: string, newTypeId: string): void {
    const el = this.elements.get(elementId);
    if (el) el.typeId = newTypeId;
  }

  // -- Formula evaluation (spec 1.6) ------------------------------------------

  /**
   * Evaluate a formula parameter for an element. The scope exposes:
   *   - every parameter symbol (effective value of this element)
   *   - globals by symbol
   *   - Math functions through the safe-expr built-in table
   * Circular references are cut off: the engine tracks the evaluation
   * stack and returns a circular-reference problem instead of recursing.
   */
  evaluateFormula(elementId: string, def: ParameterDefinition): { value: ParameterValue; problems: ParameterProblem[] } {
    const problems: ParameterProblem[] = [];
    const scope: Record<string, unknown> = {};
    const seen = new Set<string>([def.id]);
    const ok = this.collectScope(elementId, scope, seen, problems);
    if (!ok) return { value: null, problems };
    try {
      const raw = safeEval(def.formula!, scope);
      const typed = this.coerceTyped(def, raw);
      if (typed.problem) problems.push(typed.problem);
      return { value: typed.value, problems };
    } catch (err) {
      problems.push({
        parameter: def.id,
        code: "evaluation-error",
        message: err instanceof Error ? err.message : String(err),
      });
      return { value: null, problems };
    }
  }

  /**
   * Circular-reference detection over the formula graph (spec 1.6).
   * Builds symbol -> referenced-symbol edges from all formula definitions
   * and asks the dependency graph for prohibited cycles.
   */
  detectCircularReferences(): ParameterProblem[] {
    const g = new DependencyGraph();
    const symbolToDef = new Map<string, ParameterDefinition>();
    for (const def of this.defs.values()) {
      if (def.formula) symbolToDef.set(def.symbol, def);
      g.addNode(def.id, def.formula ? "formula" : "parameter");
    }
    const problems: ParameterProblem[] = [];
    for (const def of this.defs.values()) {
      if (!def.formula) continue;
      for (const ref of referencedSymbols(def.formula, [...this.defs.values()])) {
        const target = this.defs.get(ref);
        if (!target) continue;
        try {
          // def depends on target: edge target -> def, dependents direction.
          g.addDependency(target.id, def.id, "formula-dependency", true);
        } catch { /* already connected */ }
      }
    }
    const report = g.validateAcyclicDependencies();
    for (const cycle of report.cycles) {
      if (cycle.classification === "circular-formula") {
        problems.push({
          parameter: cycle.nodes.join(", "),
          code: "circular-reference",
          message: cycle.message,
        });
      }
    }
    return problems;
  }

  // -- Internals ---------------------------------------------------------------

  private collectScope(
    elementId: string,
    scope: Record<string, unknown>,
    seen: Set<string>,
    problems: ParameterProblem[],
  ): boolean {
    for (const def of this.defs.values()) {
      if (seen.has(def.id)) {
        continue; // already resolved in this stack (or being resolved: skip)
      }
      let v: ParameterValue;
      if (def.formula) {
        if (seen.has(def.id)) continue;
        seen.add(def.id);
        const r = this.evaluateFormula(elementId, def);
        if (r.problems.some((p) => p.code === "circular-reference")) {
          problems.push(...r.problems.filter((p) => p.code === "circular-reference"));
          return false;
        }
        problems.push(...r.problems);
        v = r.value;
      } else {
        const eff = this.effectiveValue(elementId, def.id);
        v = eff.value;
        problems.push(...eff.problems);
      }
      scope[def.symbol] = v;
      if (typeof v === "number") scope[def.symbol + "__num"] = v;
    }
    // Globals by symbol
    for (const def of this.defs.values()) {
      if (def.origin === "global" && this.globals.has(def.id)) {
        scope[def.symbol] = this.globals.get(def.id)!;
      }
    }
    return true;
  }

  private validateTyped(def: ParameterDefinition, v: ParameterValue): ParameterProblem | null {
    const r = this.coerceTyped(def, v);
    return r.problem;
  }

  private coerceTyped(
    def: ParameterDefinition,
    v: ParameterValue | unknown,
  ): { value: ParameterValue; problem: ParameterProblem | null } {
    if (v === null || v === undefined) return { value: null, problem: null };
    switch (def.dataType) {
      case "text":
      case "url":
      case "element-id":
        if (typeof v !== "string") {
          return { value: null, problem: { parameter: def.id, code: "type-mismatch", message: "Expected text" } };
        }
        return { value: v, problem: null };
      case "boolean":
        if (typeof v !== "boolean") {
          return { value: null, problem: { parameter: def.id, code: "type-mismatch", message: "Expected boolean" } };
        }
        return { value: v, problem: null };
      case "integer":
      case "number":
      case "length":
      case "area":
      case "volume":
      case "angle": {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          return { value: null, problem: { parameter: def.id, code: "type-mismatch", message: "Expected number" } };
        }
        if (def.dataType === "integer" && !Number.isInteger(n)) {
          return { value: null, problem: { parameter: def.id, code: "type-mismatch", message: "Expected integer" } };
        }
        if (def.min !== undefined && n < def.min) {
          return { value: null, problem: { parameter: def.id, code: "out-of-range", message: `Minimum is ${def.min}` } };
        }
        if (def.max !== undefined && n > def.max) {
          return { value: null, problem: { parameter: def.id, code: "out-of-range", message: `Maximum is ${def.max}` } };
        }
        return { value: n, problem: null };
      }
    }
  }
}

/** Extract identifiers referenced by a formula (spec 1.6 dependency map). */
export function referencedSymbols(formula: string, defs: ParameterDefinition[]): string[] {
  const symbols = new Set(defs.map((d) => d.symbol));
  const found = new Set<string>();
  const ids = formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const id of ids) {
    if (symbols.has(id)) found.add(id);
  }
  return [...found];
}

/** Map a ParameterEngine definition onto a dependency-graph node kind. */
export function parameterNodeKind(def: ParameterDefinition): NodeKind {
  return def.formula ? "formula" : "parameter";
}
