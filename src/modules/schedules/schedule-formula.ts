/**
 * Schedule formula engine.
 *
 * Safe expression language:
 *   • Numbers, strings, booleans, null
 *   • Arithmetic: + - * / % ^
 *   • Comparison: = == != <> < <= > >=
 *   • Logic: AND OR NOT (also && || !)
 *   • Column refs: [Column Header]
 *   • Aggregates over group scope: SUM([Area]) etc.
 *   • Functions: IF, ROUND, MIN, MAX, ABS, CEIL, FLOOR, COUNT,
 *                SUM, AVG, CONCAT, LEN, UPPER, LOWER, TRIM,
 *                CONTAINS, STARTSWITH, ENDSWITH, ISEMPTY, ISNUMBER
 *
 * Compile once with `compileFormula` → returns a function.
 * The evaluator never touches `eval` or 
ew Function` — it walks an AST.
 */

export interface FormulaContext {
  /** Direct row values, keyed by column header (case-insensitive). */
  values: Record<string, string | number | null>;
  /** Aggregates over the current group scope. */
  aggregates?: {
    sum: (header: string) => number;
    avg: (header: string) => number;
    count: (header: string) => number;
    min: (header: string) => number;
    max: (header: string) => number;
  };
  /** Optional user variables. */
  vars?: Record<string, number | string | boolean | null>;
}

export class FormulaError extends Error {
  constructor(message: string, public readonly position: number) {
    super(message);
    this.name = "FormulaError";
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Tokenizer
   ═════════════════════════════════════════════════════════════════════════ */
type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "str"; value: string; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "colref"; value: string; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "lparen"; pos: number }
  | { type: "rparen"; pos: number }
  | { type: "comma"; pos: number }
  | { type: "eof"; pos: number };

const OPS = [
  "==", "!=", "<>", "<=", ">=", "&&", "||",
  "+", "-", "*", "/", "%", "^", "=", "<", ">", "!",
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Bracketed column reference
    if (c === "[") {
      const start = i + 1;
      const end = src.indexOf("]", start);
      if (end < 0) throw new FormulaError("Unclosed column reference", i);
      const name = src.slice(start, end);
      out.push({ type: "colref", value: name, pos: i });
      i = end + 1;
      continue;
    }
    // String
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i + 1;
      let j = start;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) j += 2;
        else j++;
      }
      if (j >= src.length) throw new FormulaError("Unterminated string", i);
      const raw = src.slice(start, j);
      const unescaped = raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      out.push({ type: "str", value: unescaped, pos: i });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      const text = src.slice(start, i);
      const value = parseFloat(text);
      if (!Number.isFinite(value)) throw new FormulaError(`Invalid number "${text}"`, start);
      out.push({ type: "num", value, pos: start });
      continue;
    }
    // Identifier
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      const value = src.slice(start, i);
      out.push({ type: "ident", value, pos: start });
      continue;
    }
    // Punctuation
    if (c === "(") { out.push({ type: "lparen", pos: i }); i++; continue; }
    if (c === ")") { out.push({ type: "rparen", pos: i }); i++; continue; }
    if (c === ",") { out.push({ type: "comma", pos: i }); i++; continue; }
    // Operators
    let matched = false;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        out.push({ type: "op", value: op, pos: i });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    throw new FormulaError(`Unexpected character "${c}"`, i);
  }
  out.push({ type: "eof", pos: src.length });
  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
   Parser — recursive descent with precedence
   ═════════════════════════════════════════════════════════════════════════ */
type Node =
  | { kind: "lit"; value: number | string | boolean | null }
  | { kind: "colref"; name: string }
  | { kind: "unary"; op: string; expr: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

class Parser {
  private tokens: Token[];
  private i = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  parse(): Node {
    const expr = this.parseOr();
    if (this.peek().type !== "eof") {
      throw new FormulaError(
        `Unexpected token after expression: ${this.describe(this.peek())}`,
        this.peek().pos,
      );
    }
    return expr;
  }

  private peek(): Token { return this.tokens[this.i]; }
  private next(): Token { return this.tokens[this.i++]; }

  private describe(t: Token): string {
    switch (t.type) {
      case "num": return String(t.value);
      case "str": return `"${t.value}"`;
      case "ident": return t.value;
      case "colref": return `[${t.value}]`;
      case "op": return t.value;
      case "lparen": return "(";
      case "rparen": return ")";
      case "comma": return ",";
      case "eof": return "<end>";
    }
  }

  private matchOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t.type === "op" && ops.includes(t.value)) {
      this.next();
      return t.value;
    }
    return null;
  }

  private matchKeyword(kw: string): boolean {
    const t = this.peek();
    if (t.type === "ident" && t.value.toUpperCase() === kw) {
      this.next();
      return true;
    }
    return false;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    for (;;) {
      if (this.matchOp("||")) {
        const right = this.parseAnd();
        left = { kind: "binary", op: "||", left, right };
        continue;
      }
      if (this.matchKeyword("OR")) {
        const right = this.parseAnd();
        left = { kind: "binary", op: "||", left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    for (;;) {
      if (this.matchOp("&&")) {
        const right = this.parseEquality();
        left = { kind: "binary", op: "&&", left, right };
        continue;
      }
      if (this.matchKeyword("AND")) {
        const right = this.parseEquality();
        left = { kind: "binary", op: "&&", left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parseComparison();
    for (;;) {
      const op = this.matchOp("=", "==", "!=", "<>");
      if (!op) break;
      const right = this.parseComparison();
      left = { kind: "binary", op: op === "<>" ? "!=" : op === "==" ? "=" : op, left, right };
    }
    return left;
  }

  private parseComparison(): Node {
    let left = this.parseAdditive();
    for (;;) {
      const op = this.matchOp("<", "<=", ">", ">=");
      if (!op) break;
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.matchOp("+", "-");
      if (!op) break;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parsePower();
    for (;;) {
      const op = this.matchOp("*", "/", "%");
      if (!op) break;
      const right = this.parsePower();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parsePower(): Node {
    const left = this.parseUnary();
    const op = this.matchOp("^");
    if (!op) return left;
    const right = this.parsePower();
    return { kind: "binary", op: "^", left, right };
  }

  private parseUnary(): Node {
    if (this.matchOp("!")) {
      return { kind: "unary", op: "!", expr: this.parseUnary() };
    }
    if (this.matchKeyword("NOT")) {
      return { kind: "unary", op: "!", expr: this.parseUnary() };
    }
    if (this.matchOp("-")) {
      return { kind: "unary", op: "-", expr: this.parseUnary() };
    }
    if (this.matchOp("+")) {
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.peek();

    if (t.type === "num") { this.next(); return { kind: "lit", value: t.value }; }
    if (t.type === "str") { this.next(); return { kind: "lit", value: t.value }; }
    if (t.type === "colref") { this.next(); return { kind: "colref", name: t.value }; }

    if (t.type === "lparen") {
      this.next();
      const inner = this.parseOr();
      if (this.peek().type !== "rparen") {
        throw new FormulaError("Expected ')'", this.peek().pos);
      }
      this.next();
      return inner;
    }

    if (t.type === "ident") {
      const upper = t.value.toUpperCase();
      if (upper === "TRUE") { this.next(); return { kind: "lit", value: true }; }
      if (upper === "FALSE") { this.next(); return { kind: "lit", value: false }; }
      if (upper === "NULL") { this.next(); return { kind: "lit", value: null }; }

      // Function call
      if (this.tokens[this.i + 1]?.type === "lparen") {
        const name = String((this.next() as { value?: unknown }).value ?? "");
        this.next(); // consume lparen
        const args: Node[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseOr());
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseOr());
          }
        }
        if (this.peek().type !== "rparen") {
          throw new FormulaError("Expected ')' after function args", this.peek().pos);
        }
        this.next();
        return { kind: "call", name: upper, args };
      }

      // Bare identifier treated as a column reference (case-insensitive)
      this.next();
      return { kind: "colref", name: t.value };
    }

    throw new FormulaError(`Unexpected token: ${this.describe(t)}`, t.pos);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Evaluator
   ═════════════════════════════════════════════════════════════════════════ */
type Value = number | string | boolean | null;

function toNumber(v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function toString(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return v ? "true" : "false";
}

function toBool(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "no" && s !== "null";
}

function compare(a: Value, b: Value): number {
  // Numeric comparison when both coerce to numbers, else string compare.
  const na = typeof a === "number" ? a : parseFloat(String(a));
  const nb = typeof b === "number" ? b : parseFloat(String(b));
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = toString(a).toLowerCase();
  const sb = toString(b).toLowerCase();
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function lookupColumn(ctx: FormulaContext, name: string): Value {
  // Direct match
  if (name in ctx.values) return ctx.values[name];
  // Case-insensitive
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(ctx.values)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function evalNode(node: Node, ctx: FormulaContext): Value {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "colref":
      return lookupColumn(ctx, node.name);
    case "unary": {
      const v = evalNode(node.expr, ctx);
      if (node.op === "-") return -toNumber(v);
      if (node.op === "!") return !toBool(v);
      return v;
    }
    case "binary": {
      const op = node.op;
      // Short-circuit for && / ||
      if (op === "&&") {
        if (!toBool(evalNode(node.left, ctx))) return false;
        return toBool(evalNode(node.right, ctx));
      }
      if (op === "||") {
        if (toBool(evalNode(node.left, ctx))) return true;
        return toBool(evalNode(node.right, ctx));
      }
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      switch (op) {
        case "+": {
          // String concat if either side is a non-numeric string.
          if (
            (typeof l === "string" && !isNumeric(l)) ||
            (typeof r === "string" && !isNumeric(r))
          ) {
            return toString(l) + toString(r);
          }
          return toNumber(l) + toNumber(r);
        }
        case "-": return toNumber(l) - toNumber(r);
        case "*": return toNumber(l) * toNumber(r);
        case "/": {
          const d = toNumber(r);
          return d === 0 ? 0 : toNumber(l) / d;
        }
        case "%": {
          const d = toNumber(r);
          return d === 0 ? 0 : toNumber(l) % d;
        }
        case "^": return Math.pow(toNumber(l), toNumber(r));
        case "=": return compare(l, r) === 0;
        case "!=": return compare(l, r) !== 0;
        case "<": return compare(l, r) < 0;
        case "<=": return compare(l, r) <= 0;
        case ">": return compare(l, r) > 0;
        case ">=": return compare(l, r) >= 0;
      }
      return null;
    }
    case "call": {
      const name = node.name;
      const args = node.args.map((a) => evalNode(a, ctx));

      switch (name) {
        case "IF":
          if (args.length < 2) throw new Error("IF requires 2 or 3 arguments");
          return toBool(args[0]) ? args[1] : (args[2] ?? null);
        case "AND":
          return args.every((a) => toBool(a));
        case "OR":
          return args.some((a) => toBool(a));
        case "NOT":
          return !toBool(args[0]);

        case "ROUND": {
          const digits = args.length > 1 ? Math.trunc(toNumber(args[1])) : 0;
          const f = Math.pow(10, digits);
          return Math.round(toNumber(args[0]) * f) / f;
        }
        case "CEIL": return Math.ceil(toNumber(args[0]));
        case "FLOOR": return Math.floor(toNumber(args[0]));
        case "ABS": return Math.abs(toNumber(args[0]));
        case "MIN":
          return Math.min(...args.map(toNumber));
        case "MAX":
          return Math.max(...args.map(toNumber));

        case "SUM":
        case "AVG":
        case "COUNT": {
          // Aggregate — resolve over the current group scope.
          if (!ctx.aggregates) return 0;
          const header = colRefName(node.args[0]);
          if (!header) throw new Error(`${name} requires a column reference`);
          if (name === "SUM") return ctx.aggregates.sum(header);
          if (name === "AVG") return ctx.aggregates.avg(header);
          return ctx.aggregates.count(header);
        }

        case "CONCAT":
          return args.map(toString).join("");
        case "LEN":
          return toString(args[0]).length;
        case "UPPER":
          return toString(args[0]).toUpperCase();
        case "LOWER":
          return toString(args[0]).toLowerCase();
        case "TRIM":
          return toString(args[0]).trim();
        case "CONTAINS":
          return toString(args[0]).toLowerCase().includes(toString(args[1]).toLowerCase());
        case "STARTSWITH":
          return toString(args[0]).toLowerCase().startsWith(toString(args[1]).toLowerCase());
        case "ENDSWITH":
          return toString(args[0]).toLowerCase().endsWith(toString(args[1]).toLowerCase());
        case "ISEMPTY":
          return args[0] === null || args[0] === "";
        case "ISNUMBER":
          return typeof args[0] === "number" ||
            (typeof args[0] === "string" && isNumeric(args[0]));
        case "NUMBER":
          return toNumber(args[0]);
        case "TEXT":
          return toString(args[0]);

        default:
          throw new Error(`Unknown function: ${name}`);
      }
    }
  }
  return null;
}

function colRefName(n: Node): string | null {
  if (n.kind === "colref") return n.name;
  return null;
}

function isNumeric(s: string): boolean {
  const t = s.trim();
  return t !== "" && !Number.isNaN(parseFloat(t)) && Number.isFinite(parseFloat(t));
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
export type CompiledFormula = (ctx: FormulaContext) => number;

export function compileFormula(source: string): CompiledFormula {
  if (!source.trim()) return () => 0;
  const ast = new Parser(source).parse();
  return (ctx) => {
    const v = evalNode(ast, ctx);
    const n = toNumber(v);
    return Number.isFinite(n) ? n : 0;
  };
}

export function validateFormula(source: string): { ok: true } | { ok: false; error: string; position?: number } {
  if (!source.trim()) return { ok: true };
  try {
    new Parser(source).parse();
    return { ok: true };
  } catch (err) {
    if (err instanceof FormulaError) {
      return { ok: false, error: err.message, position: err.position };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Extract all [Column Name] references from a formula. */
export function extractColumnRefs(source: string): string[] {
  const refs: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!refs.includes(m[1])) refs.push(m[1]);
  }
  return refs;
}