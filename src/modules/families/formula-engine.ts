// openbim-families:formula-engine
// Parametric family formula engine.
//
// Replaces the one-pass, declaration-order evaluator that used to live
// inside registry.ts. Adds:
//   - topological sort of parameter declarations by formula dependency
//   - cycle detection (self-loops and multi-parameter cycles)
//   - a small library of built-in functions, plus free access to Math.*
//   - optional '=' prefix (Revit convention: "= height * 2")
//   - typed per-parameter error surface
//   - a computed set so the UI can render formula-driven rows read-only
//
// Nothing here touches the DOM, the store, or THREE. It is a pure data
// transform over (FamilyParameter[], values) -> (values, errors, computed).

import type { FamilyParameter } from "./types";

export interface FormulaError {
  parameter: string;
  message: string;
  formula: string;
}

export interface FormulaResult {
  /** Final parameter map after all formulas have been evaluated. */
  values: Record<string, any>;
  /** Parameters whose value came from a formula (read-only in the UI). */
  computed: Set<string>;
  /** Per-parameter error list; empty when the family resolves cleanly. */
  errors: FormulaError[];
  /** Parameter names in evaluation order (after topo sort). */
  order: string[];
}

/**
 * Built-in functions made available to every formula. Any identifier not
 * found here and not declared as a family parameter is treated as a free
 * variable and left to the JS engine (so Math.* still works).
 */
export const BUILTIN_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  sqrt: (x: number) => Math.sqrt(x),
  abs: (x: number) => Math.abs(x),
  min: (...a: number[]) => Math.min(...a),
  max: (...a: number[]) => Math.max(...a),
  round: (x: number, digits?: number) => {
    const d = Number.isFinite(digits) ? Number(digits) : 0;
    const f = Math.pow(10, d);
    return Math.round(x * f) / f;
  },
  floor: (x: number) => Math.floor(x),
  ceil: (x: number) => Math.ceil(x),
  pi: () => Math.PI,
};

/**
 * Extract identifier-like tokens from a formula. Strips the '=' prefix and
 * any single- or double-quoted string literals first.
 */
function identifiersIn(formula: string): string[] {
  let s = String(formula ?? "");
  if (s.startsWith("=")) s = s.slice(1);
  s = s.replace(/"[^"]*"|'[^']*'/g, " ");

  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.add(m[0]);
  return Array.from(out);
}

interface TopoResult {
  order: FamilyParameter[];
  cycles: string[];
}

/**
 * Kahn's algorithm over the formula dependency graph.
 *
 * A formula references another parameter if its formula string mentions
 * that parameter's name as a bare identifier. Built-ins and Math.* are
 * ignored because they are not declared parameters.
 *
 * Any parameter still with non-zero in-degree after the queue drains is
 * part of a cycle (including self-loops).
 */
function topoSort(declarations: FamilyParameter[]): TopoResult {
  const byName = new Map<string, FamilyParameter>();
  for (const p of declarations) byName.set(p.name, p);

  const deps = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const p of declarations) indeg.set(p.name, 0);

  for (const p of declarations) {
    const set = new Set<string>();
    if (p.formula) {
      for (const id of identifiersIn(p.formula)) {
        if (id === p.name) continue;               // self-loop -> handled below
        if (!byName.has(id)) continue;             // unknown id -> not a param
        set.add(id);
      }
      // A parameter whose formula mentions its own name is a cycle of size 1.
      if (identifiersIn(p.formula).indexOf(p.name) >= 0) {
        set.add(p.name);
      }
    }
    deps.set(p.name, set);
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

  // Append cyclic parameters after the healthy ones so callers still
  // get every declared parameter back in some deterministic order.
  for (const c of cycles) {
    const p = byName.get(c);
    if (p) order.push(p);
  }

  return { order, cycles };
}

/**
 * Evaluate every formula in a family.
 *
 * @param declarations  Family.parameters (order does not matter).
 * @param seedValues    Merged defaults + type overrides + instance overrides.
 */
export function evaluateParameters(
  declarations: FamilyParameter[],
  seedValues: Record<string, any>,
): FormulaResult {
  const { order, cycles } = topoSort(declarations);
  const values: Record<string, any> = { ...seedValues };
  const computed = new Set<string>();
  const errors: FormulaError[] = [];

  // Guarantee every declared parameter is present so formulas referencing
  // a default-valued param cannot see `undefined`.
  for (const p of declarations) {
    if (!(p.name in values)) values[p.name] = p.default;
  }

  const cycleSet = new Set(cycles);
  for (const c of cycles) {
    const p = declarations.find((x) => x.name === c);
    errors.push({
      parameter: c,
      message: "Cycle detected in formula references",
      formula: p?.formula ?? "",
    });
  }

  for (const p of order) {
    if (!p.formula) continue;
    if (cycleSet.has(p.name)) continue;
    computed.add(p.name);

    // Collect the free identifiers that are actual family parameters.
    const ids = identifiersIn(p.formula);
    const argNames: string[] = [];
    const argValues: any[] = [];
    for (const id of ids) {
      if (id in BUILTIN_FUNCTIONS) continue;
      if (!(id in values)) continue;
      argNames.push(id);
      argValues.push(values[id]);
    }

    const fnNames = Object.keys(BUILTIN_FUNCTIONS);
    const fnValues = fnNames.map((n) => BUILTIN_FUNCTIONS[n]);

    let body = p.formula.trim();
    if (body.startsWith("=")) body = body.slice(1);

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...fnNames, ...argNames, "return (" + body + ");");
      const raw = fn(...fnValues, ...argValues);

      if (raw === undefined || raw === null) {
        errors.push({
          parameter: p.name,
          message: "Formula returned no value",
          formula: p.formula,
        });
        continue;
      }
      if (typeof raw === "boolean" || typeof raw === "string") {
        values[p.name] = raw;
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
      values[p.name] = n;
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
  };
}

// openbim-fix:formula-engine -- single-expression evaluator for NumberRef
//
// Used by the parametric geometry layer for `{ expr: "thickness / 2" }`
// style NumberRefs. Reuses the identifier scanner and BUILTIN_FUNCTIONS
// already defined in this module so the family editor and the geometry
// resolver see the same math. Returns null on empty input, unknown
// identifier, or non-finite result; the caller decides the fallback.
export function evaluateFormula(
  expr: string,
  params: Record<string, any>,
): number | null {
  const source = String(expr ?? "").trim();
  if (!source) return null;

  // Collect identifiers that are actual family parameters.
  const ids = identifiersIn(source);
  const argNames: string[] = [];
  const argValues: any[] = [];
  for (const id of ids) {
    if (id in BUILTIN_FUNCTIONS) continue;
    if (!(id in params)) continue;
    argNames.push(id);
    argValues.push(params[id]);
  }

  const fnNames  = Object.keys(BUILTIN_FUNCTIONS);
  const fnValues = fnNames.map((n) => BUILTIN_FUNCTIONS[n]);

  let body = source;
  if (body.startsWith("=")) body = body.slice(1);

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...fnNames, ...argNames, "return (" + body + ");");
    const raw = fn(...fnValues, ...argValues);
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
/** Convenience: does this family declare any formulas at all? */
export function hasFormulas(declarations: FamilyParameter[]): boolean {
  return declarations.some((p) => !!p.formula);
}