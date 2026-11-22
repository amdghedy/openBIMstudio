// openbim-families:formula-engine
// Parametric family formula engine.
//
// This is the enhanced engine (formerly formula-engine-enhanced.ts),
// integrated onto the live path. It supersedes the hand-rolled
// recursive-descent evaluator that used to live in this file: evaluation
// now goes through the sanctioned interpreted evaluator in safe-expr.ts
// (the only sanctioned expression evaluator in the tree — see
// tests/dependency-safety.test.cjs). There is no eval / Function /
// member access anywhere in this path; formulas come from family files
// that may be imported from anywhere.
//
// What the enhanced engine adds over the old one:
//   - Scientific-notation numbers (1e-7) — the old tokenizer only read
//     [0-9.] and failed every such formula.
//   - String / boolean return values (for Yes/No and text parameters).
//     Numeric parameters still store logic results as 1/0, exactly as
//     the old engine did; only Yes/No parameters keep real booleans.
//   - Degree trig (sind / cosd / tand), xor, and to_mm / to_cm / to_ft /
//     to_in / to_deg converters.
//   - Precise per-parameter error messages (unknown name, unknown
//     function, syntax position) instead of the old blanket
//     "Formula returned no value".
//   - A dependency graph in the result (FormulaResult.dependencies) plus
//     dependentsOf(), for UI tooltips / invalidation.
//   - Topological sort, cycle detection, integer + min/max clamping, and
//     the computed set are unchanged from the old engine.
//
// Compatibility notes (verified against the live corpus — see
// tests/formula-engine.test.cjs; 24 distinct TS-source formulas and all
// 56 seed families evaluate identically to the old engine):
//   - `^` is accepted as a power alias for `**` (added to safe-expr.ts,
//     where it previously threw "Unsupported character").
//   - Word operators (and / or / not / eq / ne / lt / le / gt / ge) keep
//     working as infix/prefix operators, rewritten to symbolic form
//     outside string literals; the function-call forms (and(a, b),
//     eq(a, b), not(x)) are untouched and still resolve as builtins.
//   - `Math.*` was never actually usable in the old engine either (its
//     tokenizer could not lex the `.`), so nothing is lost there; every
//     Math function is available as a bare builtin (sin, sqrt, ...).
//   - evaluateFormula() keeps the old null-on-error contract used by
//     parametric-geometry's resolveNumber().

import { evaluateExpression, validateFormulaExpression } from "./safe-expr";
import { FormulaParameterSchema, validateWithSchema } from "../../core/safeLoad";
import {
  analyseFormulaDimensions,
  buildDimensionEnv,
  checkTargetDimension,
  DimensionError,
  fromSIValue,
  toSIValue,
  type DimensionEnv,
  type DimValue,
} from "./formula-dimensions";
import type { FamilyParameter } from "./types";

export { DimensionError } from "./formula-dimensions";
export { toDeclaredUnits } from "./formula-dimensions";

export interface FormulaError {
  parameter: string;
  message: string;
  formula: string;
}

export interface FormulaResult {
  values: Record<string, any>;
  computed: Set<string>;
  errors: FormulaError[];
  order: string[];
  /** name - list of parameter names it depends on */
  dependencies: Record<string, string[]>;
}

/* -- Built-in library ------------------------------------------------ */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const BUILTIN_FUNCTIONS: Record<string, (...args: any[]) => any> = {
  // Trig (radians)
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  asin: (x: number) => Math.asin(x),
  acos: (x: number) => Math.acos(x),
  atan: (x: number) => Math.atan(x),
  atan2: (y: number, x: number) => Math.atan2(y, x),

  // Trig (degrees - BIM-style convenience)
  sind: (x: number) => Math.sin(x * DEG2RAD),
  cosd: (x: number) => Math.cos(x * DEG2RAD),
  tand: (x: number) => Math.tan(x * DEG2RAD),

  // Arithmetic
  sqrt: (x: number) => Math.sqrt(x),
  abs: (x: number) => Math.abs(x),
  min: (...a: number[]) => Math.min(...a),
  max: (...a: number[]) => Math.max(...a),
  round: (x: number, digits?: number) => {
    const d = Number.isFinite(digits as number) ? Number(digits) : 0;
    const f = Math.pow(10, d);
    return Math.round(x * f) / f;
  },
  floor: (x: number) => Math.floor(x),
  ceil: (x: number) => Math.ceil(x),
  pow: (x: number, y: number) => Math.pow(x, y),
  log: (x: number) => Math.log(x),
  log10: (x: number) => Math.log10(x),
  exp: (x: number) => Math.exp(x),
  pi: () => Math.PI,
  e: () => Math.E,

  // Conditionals
  if: (cond: any, a: any, b: any) => (truthy(cond) ? a : b),
  and: (...args: any[]) => args.every(truthy),
  or: (...args: any[]) => args.some(truthy),
  not: (x: any) => !truthy(x),
  xor: (a: any, b: any) => truthy(a) !== truthy(b),

  // Comparisons (return 1/0 so they compose in arithmetic formulas)
  eq: (a: any, b: any) => (a === b ? 1 : 0),
  ne: (a: any, b: any) => (a !== b ? 1 : 0),
  lt: (a: number, b: number) => (a < b ? 1 : 0),
  le: (a: number, b: number) => (a <= b ? 1 : 0),
  gt: (a: number, b: number) => (a > b ? 1 : 0),
  ge: (a: number, b: number) => (a >= b ? 1 : 0),

  // Unit conversion - internal metres / radians
  mm: (x: number) => x / 1000,
  cm: (x: number) => x / 100,
  m: (x: number) => x,
  ft: (x: number) => x * 0.3048,
  in: (x: number) => x * 0.0254,
  deg: (x: number) => x * DEG2RAD,
  rad: (x: number) => x,

  // Unit conversion - internal
  to_mm: (x: number) => x * 1000,
  to_cm: (x: number) => x * 100,
  to_ft: (x: number) => x / 0.3048,
  to_in: (x: number) => x / 0.0254,
  to_deg: (x: number) => x * RAD2DEG,
};

function truthy(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && Number.isFinite(v);
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s !== "" && s !== "0" && s !== "false" && s !== "no";
  }
  return !!v;
}

const NUMERIC_PARAM_TYPES = new Set([
  "length",
  "angle",
  "number",
  "integer",
  "area",
  "volume",
]);

function isNumericParamType(t: string | undefined): boolean {
  return !!t && NUMERIC_PARAM_TYPES.has(t);
}

/* -- Identifier extraction ------------------------------------------- */

function identifiersIn(formula: string): string[] {
  let s = String(formula ?? "");
  if (s.startsWith("=")) s = s.slice(1);
  s = s.replace(/"[^"]*"|'[^']*'/g, " ");
  // Strip numeric literals first, so the exponent marker in scientific
  // notation (1e-7) is not mistaken for a parameter named "e" (or "e5").
  s = s.replace(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, " ");

  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.add(m[0]);
  return Array.from(out);
}

/* -- Topological sort ------------------------------------------------ */

interface TopoResult {
  order: FamilyParameter[];
  cycles: string[];
  dependencies: Record<string, string[]>;
}

function topoSort(declarations: FamilyParameter[]): TopoResult {
  const byName = new Map<string, FamilyParameter>();
  for (const p of declarations) byName.set(p.name, p);

  const deps = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  const dependencies: Record<string, string[]> = {};
  for (const p of declarations) indeg.set(p.name, 0);

  for (const p of declarations) {
    const set = new Set<string>();
    if (p.formula) {
      for (const id of identifiersIn(p.formula)) {
        if (!byName.has(id)) continue;
        set.add(id);
      }
    }
    deps.set(p.name, set);
    dependencies[p.name] = Array.from(set);
    for (const _d of set) {
      indeg.set(p.name, (indeg.get(p.name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, d] of indeg) if (d === 0) queue.push(name);

  const order: FamilyParameter[] = [];
  while (queue.length) {
    const name = queue.shift() as string;
    const p = byName.get(name);
    if (p) order.push(p);
    for (const [other, depsOf] of deps) {
      if (!depsOf.has(name)) continue;
      const next = (indeg.get(other) ?? 0) - 1;
      indeg.set(other, next);
      if (next === 0) queue.push(other);
    }
  }

  const cycles: string[] = [];
  for (const [name, d] of indeg) if (d > 0) cycles.push(name);
  for (const c of cycles) {
    const p = byName.get(c);
    if (p) order.push(p);
  }

  return { order, cycles, dependencies };
}

/* -- Safe formula evaluation ----------------------------------------- */

// Word operators the old hand-rolled parser accepted as infix/prefix
// operators. safe-expr only knows them as builtin function names, so a
// formula such as `a > 1 and b > 1` would fail there. Rewrite them to
// symbolic form before evaluation, outside string literals only.
// A word followed by `(` stays untouched: `and(a, b)` / `not(x)` are
// builtin calls, which both engines resolve identically.
const WORD_OPS: Record<string, string> = {
  and: "&&",
  or: "||",
  not: "!",
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

function rewriteWordOperators(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      // Copy a string literal verbatim (a word inside it is text, not an operator).
      const q = c;
      let j = i + 1;
      while (j < body.length && body[j] !== q) {
        if (body[j] === "\\") j++;
        j++;
      }
      out += body.slice(i, Math.min(j + 1, body.length));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
      const word = body.slice(i, j);
      const mapped = WORD_OPS[word];
      if (mapped) {
        let k = j;
        while (k < body.length && /\s/.test(body[k])) k++;
        if (body[k] !== "(") {
          out += mapped;
          i = j;
          continue;
        }
      }
      out += word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip the optional '=' prefix (BIM convention) and rewrite word
 * operators to symbolic form so the safe-expr evaluator accepts them.
 */
function normalizeBody(formula: string): string {
  let body = formula.trim();
  if (body.startsWith("=")) body = body.slice(1).trim();
  return rewriteWordOperators(body);
}

export function evaluateParameters(
  declarations: FamilyParameter[],
  seedValues: Record<string, any>,
): FormulaResult {
  // PE-20: declarations are validated BEFORE the topological sort and any
  // evaluation. A declaration with an unlexable name, an unknown type /
  // scope, or a non-string / overlong formula is recorded as a
  // per-parameter error and excluded — it keeps its default/seed value
  // and is never evaluated, instead of crashing the sort or the evaluator
  // (or silently evaluating under a meaningless name).
  const errors: FormulaError[] = [];
  const validDeclarations: FamilyParameter[] = [];
  for (const p of declarations) {
    const check = validateWithSchema(FormulaParameterSchema, p);
    if (!check.ok) {
      const raw = p as FamilyParameter | null | undefined;
      const name = typeof raw?.name === "string" ? raw.name : "<unknown>";
      const formulaText = typeof raw?.formula === "string" ? raw.formula : "";
      errors.push({
        parameter: name,
        message: `Invalid parameter declaration: ${(check.issues ?? []).join("; ")}`,
        formula: formulaText,
      });
      continue;
    }
    validDeclarations.push(check.value as FamilyParameter);
  }

  const { order, cycles, dependencies } = topoSort(validDeclarations);
  // PE-01: dimensional analysis. Declared values are stored in the
  // parameter's declared unit and converted to SI (metres / m^2 / m^3 /
  // radians) before any arithmetic, so `mm + m` converts and evaluates
  // correctly instead of adding raw numbers as if they shared a unit.
  // Seed-only values (no declaration) pass through unconverted: their
  // dimension is unknown, not silently dimensionless.
  const dimEnv = buildDimensionEnv(validDeclarations, seedValues);
  const values: Record<string, any> = {};
  for (const p of validDeclarations) {
    const info = dimEnv.declared.get(p.name);
    if (p.name in seedValues) values[p.name] = toSIValue(seedValues[p.name], info);
    else values[p.name] = toSIValue(p.default, info);
  }
  for (const [k, v] of Object.entries(seedValues)) {
    if (!(k in values)) values[k] = v;
  }
  const computed = new Set<string>();
  // Names an expression may reference: declared parameters, seed values
  // (a formula may legitimately read a seed-only value), builtins, and
  // the boolean literals. Anything else is an unknown name, reported
  // before evaluation rather than thrown mid-pass.
  const allowedNames = new Set<string>([
    ...validDeclarations.map((d) => d.name),
    ...Object.keys(seedValues),
    ...Object.keys(BUILTIN_FUNCTIONS),
    "true",
    "false",
  ]);

  const cycleSet = new Set(cycles);
  for (const c of cycles) {
    const p = validDeclarations.find((x) => x.name === c);
    errors.push({
      parameter: c,
      message: "Cycle detected in formula references",
      formula: p?.formula ?? "",
    });
  }

  for (const p of order) {
    if (!p.formula) continue;
    if (cycleSet.has(p.name)) continue;

    const body = normalizeBody(p.formula);

    // PE-20: validate the expression (shape + identifier membership)
    // before evaluating it. An unknown name is the same error the
    // evaluator would throw; reporting it here keeps the failure
    // per-parameter and typed instead of aborting the whole pass.
    const exprCheck = validateFormulaExpression(body, allowedNames);
    if (!exprCheck.ok) {
      errors.push({
        parameter: p.name,
        message: (exprCheck.issues ?? []).join("; "),
        formula: p.formula,
      });
      continue;
    }

    // PE-01: dimensional analysis, before any numeric evaluation. An
    // ill-typed formula (length + area, round(length), a length where a
    // dimensionless value is required, a result whose dimension does not
    // match a dimensional target) is recorded as a named DimensionError
    // and keeps its default — it is never evaluated to a silent wrong
    // number. The check is static: a formula that passes it evaluates
    // through the unchanged numeric path, so valid formulas keep their
    // values exactly. A target whose own declared unit cannot be
    // converted for its type is rejected the same way.
    const ownUnitError = dimEnv.declared.get(p.name)?.unitError;
    if (ownUnitError) {
      errors.push({
        parameter: p.name,
        message: `DimensionError [unit-confusion]: ${ownUnitError}`,
        formula: p.formula,
      });
      continue;
    }
    const dimCheck = analyseFormulaDimensions(body, dimEnv);
    if (!dimCheck.ok) {
      errors.push({
        parameter: p.name,
        message:
          dimCheck.code === "syntax"
            ? (dimCheck.message ?? "Invalid formula")
            : `DimensionError [${dimCheck.code ?? "dimension-mismatch"}]: ${dimCheck.message ?? "Invalid formula"}`,
        formula: p.formula,
      });
      continue;
    }
    // `ok` is true here (the failure branch continues), so `dimension` is set.
    const targetError = checkTargetDimension(p, dimCheck.dimension as DimValue);
    if (targetError) {
      errors.push({
        parameter: p.name,
        message: `DimensionError [${targetError.code}]: ${targetError.message}`,
        formula: p.formula,
      });
      continue;
    }

    try {
      // Interpreted, never executed as script: formulas can come from imported family files.
      const raw = evaluateExpression(body, values, BUILTIN_FUNCTIONS);

      if (raw === undefined || raw === null) {
        errors.push({
          parameter: p.name,
          message: "Formula returned no value",
          formula: p.formula,
        });
        continue;
      }

      if (typeof raw === "boolean" || typeof raw === "string") {
        // The old engine stored logic results as 1/0 numbers; keep that
        // for numeric parameters so downstream arithmetic and saved
        // values are unchanged. Yes/No parameters keep real booleans
        // (the old engine stored 1/0 even there).
        values[p.name] =
          typeof raw === "boolean" && isNumericParamType(p.type)
            ? raw ? 1 : 0
            : raw;
        // PE-01: only a formula that actually produced a value counts
        // as computed; a rejected formula keeps its default and is not
        // in the computed set.
        computed.add(p.name);
        continue;
      }

      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push({
          parameter: p.name,
          message: "Formula returned a non-finite number",
          formula: p.formula,
        });
        continue;
      }

      // Honour integer type + min/max after evaluation. min/max are
      // authored in the parameter's declared unit (like the default and
      // the type values resolveParametricValues clamps before formulas),
      // while `out` is SI — so clamp in declared-unit space and convert
      // back. For SI-unit parameters this is the identity.
      let out: number = n;
      if (p.type === "integer") out = Math.round(out);
      if (p.min != null || p.max != null) {
        const info = dimEnv.declared.get(p.name);
        const inDeclared = fromSIValue(out, info) as number;
        let clamped = inDeclared;
        if (p.min != null && clamped < p.min) clamped = p.min;
        if (p.max != null && clamped > p.max) clamped = p.max;
        out = clamped === inDeclared ? out : (toSIValue(clamped, info) as number);
      }
      values[p.name] = out;
      computed.add(p.name);
    } catch (err) {
      errors.push({
        parameter: p.name,
        message: err instanceof Error ? err.message : String(err),
        formula: p.formula,
      });
    }
  }

  return {
    values,
    computed,
    errors,
    order: order.map((p) => p.name),
    dependencies,
  };
}

/**
 * One-off formula evaluation with the old engine's contract: any parse /
 * evaluation failure, empty expression, or non-finite result yields null
 * instead of throwing, so callers such as parametric-geometry's
 * resolveNumber() can fall back (warn + 0). Booleans are returned as 1/0,
 * matching the old engine.
 */
export function evaluateFormula(
  expr: string,
  params: Record<string, any>,
  declarations?: FamilyParameter[],
): any {
  const source = String(expr ?? "").trim();
  if (!source) return null;
  // PE-20: validate the expression (shape + identifier membership) before
  // evaluating it. Same null-on-error contract as before: an invalid
  // expression yields null, never a throw.
  const body = normalizeBody(source);
  const allowedNames = new Set<string>([
    ...Object.keys(params ?? {}),
    ...Object.keys(BUILTIN_FUNCTIONS),
    "true",
    "false",
  ]);
  if (!validateFormulaExpression(body, allowedNames).ok) return null;
  // PE-01: when the caller supplies declarations, the same dimensional
  // gate as evaluateParameters applies — an ill-typed formula yields
  // null instead of a silent wrong number. Without declarations the
  // one-off path stays untyped (it cannot know a name's dimension);
  // callers that have declarations should pass them. Geometry NumberRef
  // expressions via parametric-geometry's resolveNumber() use the
  // untyped path today — see the PE-01 limitations in the PR description.
  if (declarations !== undefined) {
    const env = buildDimensionEnv(declarations, params ?? {});
    if (!analyseFormulaDimensions(body, env).ok) return null;
  }
  try {
    const result = evaluateExpression(body, params, BUILTIN_FUNCTIONS);
    if (result === undefined || result === null) return null;
    if (typeof result === "boolean") return result ? 1 : 0;
    if (typeof result === "number" && !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

export function hasFormulas(declarations: FamilyParameter[]): boolean {
  return declarations.some((p) => !!p.formula);
}

/**
 * PE-01: statically check one formula against parameter declarations
 * without evaluating it. Returns the inferred result dimension on
 * success, or the named DimensionError that would reject the formula in
 * evaluateParameters (a syntax problem is returned as a plain Error with
 * the parser's message). `seedValues` names the seed-only values the
 * formula may read; their dimension is unknown, not dimensionless.
 * Flat result shape, like DimensionCheckResult (see there for why).
 */
export interface FormulaDimensionCheck {
  ok: boolean;
  dimension?: DimValue;
  error?: Error;
}

export function checkFormulaDimensions(
  formula: string,
  declarations: FamilyParameter[],
  seedValues: Record<string, any> = {},
): FormulaDimensionCheck {
  const env: DimensionEnv = buildDimensionEnv(declarations, seedValues);
  const body = normalizeBody(String(formula ?? ""));
  const check = analyseFormulaDimensions(body, env);
  if (!check.ok) {
    const error =
      check.code === "syntax"
        ? new Error(check.message ?? "Invalid formula")
        : new DimensionError(
            check.code ?? "dimension-mismatch",
            check.message ?? "Invalid formula",
          );
    return { ok: false, error };
  }
  return { ok: true, dimension: check.dimension };
}

/** Return parameters that depend on `name` (directly or transitively). */
export function dependentsOf(
  declarations: FamilyParameter[],
  name: string,
): string[] {
  const { dependencies } = topoSort(declarations);
  const result = new Set<string>();
  const visit = (n: string) => {
    for (const [param, deps] of Object.entries(dependencies)) {
      if (deps.includes(n) && !result.has(param)) {
        result.add(param);
        visit(param);
      }
    }
  };
  visit(name);
  return Array.from(result);
}
