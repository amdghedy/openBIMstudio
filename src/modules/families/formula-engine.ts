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
//   - a fully safe AST evaluator (no eval/Function)

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
}

export const BUILTIN_FUNCTIONS: Record<string, (...args: any[]) => any> = {
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  asin: (x: number) => Math.asin(x),
  acos: (x: number) => Math.acos(x),
  atan: (x: number) => Math.atan(x),
  atan2: (y: number, x: number) => Math.atan2(y, x),
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
  pow: (x: number, y: number) => Math.pow(x, y),
  log: (x: number) => Math.log(x),
  log10: (x: number) => Math.log10(x),
  exp: (x: number) => Math.exp(x),
  pi: () => Math.PI,
  e: () => Math.E,
  if: (cond: any, a: any, b: any) => (truthy(cond) ? a : b),
  and: (...args: any[]) => args.every(truthy),
  or: (...args: any[]) => args.some(truthy),
  not: (x: any) => !truthy(x),
  eq: (a: any, b: any) => (a === b ? 1 : 0),
  ne: (a: any, b: any) => (a !== b ? 1 : 0),
  lt: (a: number, b: number) => (a < b ? 1 : 0),
  le: (a: number, b: number) => (a <= b ? 1 : 0),
  gt: (a: number, b: number) => (a > b ? 1 : 0),
  ge: (a: number, b: number) => (a >= b ? 1 : 0),
  mm: (x: number) => x / 1000,
  cm: (x: number) => x / 100,
  m: (x: number) => x,
  ft: (x: number) => x * 0.3048,
  in: (x: number) => x * 0.0254,
  deg: (x: number) => x * (Math.PI / 180),
  rad: (x: number) => x,
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
        if (id === p.name) continue;
        if (!byName.has(id)) continue;
        set.add(id);
      }
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
  for (const c of cycles) {
    const p = byName.get(c);
    if (p) order.push(p);
  }

  return { order, cycles };
}

export function evaluateParameters(
  declarations: FamilyParameter[],
  seedValues: Record<string, any>,
): FormulaResult {
  const { order, cycles } = topoSort(declarations);
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

  for (const p of order) {
    if (!p.formula) continue;
    if (cycleSet.has(p.name)) continue;
    computed.add(p.name);

    let body = p.formula.trim();
    if (body.startsWith("=")) body = body.slice(1);

    try {
      const raw = evaluateFormula(body, values);
      
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
      
      let out = n;
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE AST EVALUATOR (No eval, no Function)
// ─────────────────────────────────────────────────────────────────────────────

type Token = { type: "num" | "id" | "op" | "punc"; value: string };

function tokenize(str: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (/\s/.test(c)) { i++; continue; }
    
    // Numbers
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (i < str.length && /[0-9.]/.test(str[i])) { num += str[i]; i++; }
      tokens.push({ type: "num", value: num });
      continue;
    }
    
    // Identifiers (variables and function names)
    if (/[A-Za-z_]/.test(c)) {
      let id = "";
      while (i < str.length && /[A-Za-z0-9_]/.test(str[i])) { id += str[i]; i++; }
      tokens.push({ type: "id", value: id });
      continue;
    }
    
    // Operators
    if ("+-*/^%><!&|=".includes(c)) {
      let op = c; i++;
      if (i < str.length && "=<>&|".includes(str[i])) { op += str[i]; i++; }
      tokens.push({ type: "op", value: op });
      continue;
    }
    
    // Punctuation
    if ("(),?:".includes(c)) {
      tokens.push({ type: "punc", value: c });
      i++;
      continue;
    }
    
    throw new Error("Unknown character: " + c);
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;
  vars: Record<string, any>;

  constructor(tokens: Token[], vars: Record<string, any>) {
    this.tokens = tokens;
    this.vars = vars;
  }

  peek(): Token | undefined { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }
  match(val: string): boolean {
    if (this.peek()?.value === val) { this.pos++; return true; }
    return false;
  }

  parse(): any {
    const res = this.parseTernary();
    if (this.pos < this.tokens.length) throw new Error("Unexpected token: " + this.peek()?.value);
    return res;
  }

  parseTernary(): any {
    const cond = this.parseLogicalOr();
    if (this.match("?")) {
      const ifTrue = this.parseTernary();
      if (!this.match(":")) throw new Error("Expected ':'");
      const ifFalse = this.parseTernary();
      return truthy(cond) ? ifTrue : ifFalse;
    }
    return cond;
  }

  parseLogicalOr(): any {
    let left = this.parseLogicalAnd();
    while (this.match("||") || this.match("or")) {
      const right = this.parseLogicalAnd();
      left = truthy(left) || truthy(right) ? 1 : 0;
    }
    return left;
  }

  parseLogicalAnd(): any {
    let left = this.parseEquality();
    while (this.match("&&") || this.match("and")) {
      const right = this.parseEquality();
      left = truthy(left) && truthy(right) ? 1 : 0;
    }
    return left;
  }

  parseEquality(): any {
    let left = this.parseRelational();
    while (this.match("==") || this.match("!=") || this.match("eq") || this.match("ne")) {
      const op = this.tokens[this.pos - 1].value;
      const right = this.parseRelational();
      if (op === "==" || op === "eq") left = left === right ? 1 : 0;
      else left = left !== right ? 1 : 0;
    }
    return left;
  }

  parseRelational(): any {
    let left = this.parseAddition();
    while (this.match(">") || this.match("<") || this.match(">=") || this.match("<=") || this.match("gt") || this.match("lt") || this.match("ge") || this.match("le")) {
      const op = this.tokens[this.pos - 1].value;
      const right = this.parseAddition();
      if (op === ">" || op === "gt") left = left > right ? 1 : 0;
      else if (op === "<" || op === "lt") left = left < right ? 1 : 0;
      else if (op === ">=" || op === "ge") left = left >= right ? 1 : 0;
      else left = left <= right ? 1 : 0;
    }
    return left;
  }

  parseAddition(): any {
    let left = this.parseMultiplication();
    while (this.match("+") || this.match("-")) {
      const op = this.tokens[this.pos - 1].value;
      const right = this.parseMultiplication();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  parseMultiplication(): any {
    let left = this.parseUnary();
    while (this.match("*") || this.match("/") || this.match("%")) {
      const op = this.tokens[this.pos - 1].value;
      const right = this.parseUnary();
      if (op === "*") left = left * right;
      else if (op === "/") left = left / right;
      else left = left % right;
    }
    return left;
  }

  parseUnary(): any {
    if (this.match("-")) return -this.parseUnary();
    if (this.match("+")) return this.parseUnary();
    if (this.match("!") || this.match("not")) return truthy(this.parseUnary()) ? 0 : 1;
    return this.parsePower();
  }

  parsePower(): any {
    const left = this.parsePrimary();
    if (this.match("^")) {
      const right = this.parseUnary(); // Right associative
      return Math.pow(left, right);
    }
    return left;
  }

  parsePrimary(): any {
    const tok = this.next();
    if (!tok) throw new Error("Unexpected end of expression");

    if (tok.type === "num") return Number(tok.value);

    if (tok.type === "id") {
      const name = tok.value;
      if (this.match("(")) {
        // Function call
        const args: any[] = [];
        if (!this.match(")")) {
          do {
            args.push(this.parseTernary());
          } while (this.match(","));
          if (!this.match(")")) throw new Error("Expected ')'");
        }
        if (name in BUILTIN_FUNCTIONS) {
          return BUILTIN_FUNCTIONS[name](...args);
        }
        if (name in Math) {
          return (Math as any)[name](...args);
        }
        throw new Error("Unknown function: " + name);
      }
      
      // Variable
      if (name in this.vars) return this.vars[name];
      if (name === "true") return 1;
      if (name === "false") return 0;
      throw new Error("Unknown variable: " + name);
    }

    if (tok.value === "(") {
      const expr = this.parseTernary();
      if (!this.match(")")) throw new Error("Expected ')'");
      return expr;
    }

    throw new Error("Unexpected token: " + tok.value);
  }
}

export function evaluateFormula(expr: string, params: Record<string, any>): any {
  const source = String(expr ?? "").trim();
  if (!source) return null;
  
  let body = source;
  if (body.startsWith("=")) body = body.slice(1).trim();
  
  try {
    const tokens = tokenize(body);
    const parser = new Parser(tokens, params);
    const result = parser.parse();
    
    if (typeof result === "boolean") return result ? 1 : 0;
    if (result === undefined || result === null) return null;
    
    // If it's a number, ensure it's finite
    if (typeof result === "number" && !Number.isFinite(result)) return null;
    
    return result;
  } catch (err) {
    // Return null on parse failure, which the caller handles
    return null;
  }
}

export function hasFormulas(declarations: FamilyParameter[]): boolean {
  return declarations.some((p) => !!p.formula);
}