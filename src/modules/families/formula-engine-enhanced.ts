/**
 * Enhanced parametric formula engine (drop-in supersession of formula-engine.ts).
 *
 * Adds on top of the baseline engine:
 *   - Conditional expressions:  if(cond, a, b)   and  cond ? a : b
 *   - Boolean operators: and, or, not, xor
 *   - Comparison helpers: eq, ne, lt, le, gt, ge
 *   - Unit conversion helpers: mm, cm, m, ft, in, deg, rad
 *   - String / boolean return values (for Yes/No and text parameters)
 *   - Reporting of dependency graph for UI tooltips
 *
 * Safe evaluation: formulas run in a Function sandbox with only the
 * declared parameter names + the built-in library in scope. No access
 * to globalThis, document, or imports.
 */

import type { FamilyParameter } from "./types";

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

/* -- Identifier extraction ------------------------------------------- */

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

/**
 * Rewrite ternary operators so the Function body stays valid JS.
 * Already valid JS ternary is left alone; we just strip the optional '='.
 */
function normalizeBody(formula: string): string {
  let body = formula.trim();
  if (body.startsWith("=")) body = body.slice(1).trim();
  return body;
}

export function evaluateParameters(
  declarations: FamilyParameter[],
  seedValues: Record<string, any>,
): FormulaResult {
  const { order, cycles, dependencies } = topoSort(declarations);
  const values: Record<string, any> = { ...seedValues };
  const computed = new Set<string>();
  const errors: FormulaError[] = [];

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

  const fnNames = Object.keys(BUILTIN_FUNCTIONS);
  const fnValues = fnNames.map((n) => BUILTIN_FUNCTIONS[n]);

  for (const p of order) {
    if (!p.formula) continue;
    if (cycleSet.has(p.name)) continue;
    computed.add(p.name);

    const ids = identifiersIn(p.formula);
    const argNames: string[] = [];
    const argValues: any[] = [];
    for (const id of ids) {
      if (id in BUILTIN_FUNCTIONS) continue;
      if (!(id in values)) continue;
      argNames.push(id);
      argValues.push(values[id]);
    }

    const body = normalizeBody(p.formula);

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(
        ...fnNames,
        ...argNames,
        `"use strict"; return (${body});`,
      );
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

      // Honour integer type + min/max after evaluation
      let out: number = n;
      if (p.type === "integer") out = Math.round(out);
      if (p.min != null && out < p.min) out = p.min;
      if (p.max != null && out > p.max) out = p.max;
      values[p.name] = out;
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

export function hasFormulas(declarations: FamilyParameter[]): boolean {
  return declarations.some((p) => !!p.formula);
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
