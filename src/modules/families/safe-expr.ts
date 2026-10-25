/**
 * Safe expression evaluator for family / parameter formulas.
 *
 * Replaces `new Function(...)`: formulas come from family files that may be imported from anywhere,
 * so they must never be able to run arbitrary script. This is a small parser/interpreter for
 * arithmetic, comparisons, logic, the ternary operator, string/number/boolean literals, named
 * values and calls to an explicit function table. There is no property access, no assignment and
 * no access to globals.
 */
export type Scope = Record<string, unknown>;
export type FnTable = Record<string, (...args: any[]) => unknown>;

type Tok = { t: "num" | "str" | "id" | "op" | "end"; v: string };

const OPS = ["===", "!==", "**", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "?", ":", "(", ")", ","];
const MAX_LEN = 2000;
const MAX_DEPTH = 64;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new Error("Formula is too long");
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" || src[j] === "\n") throw new Error("Unsupported character in text");
        s += src[j++];
      }
      if (j >= src.length) throw new Error("Unterminated text");
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unsupported character "${c}"`);
    out.push({ t: "op", v: op }); i += op.length;
  }
  out.push({ t: "end", v: "" });
  return out;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function evaluateExpression(source: string, scope: Scope, fns: FnTable): unknown {
  const toks = tokenize(source);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => peek().t === "op" && peek().v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new Error("Formula is nested too deeply"); };
  const leave = () => { depth--; };

  function ternary(): unknown {
    enter();
    const c = or();
    if (isOp("?")) {
      p++;
      const a = ternary();
      expect(":");
      const b = ternary();
      leave();
      return c ? a : b;
    }
    leave();
    return c;
  }
  function or(): unknown { let l = and(); while (isOp("||")) { p++; const r = and(); l = l || r; } return l; }
  function and(): unknown { let l = eq(); while (isOp("&&")) { p++; const r = eq(); l = l && r; } return l; }
  function eq(): unknown {
    let l = rel();
    while (isOp("==") || isOp("!=") || isOp("===") || isOp("!==")) {
      const o = next().v; const r = rel();
      l = o === "==" || o === "===" ? l === r : l !== r;
    }
    return l;
  }
  function rel(): unknown {
    let l = add();
    while (isOp("<") || isOp(">") || isOp("<=") || isOp(">=")) {
      const o = next().v; const r = add() as any; const a = l as any;
      l = o === "<" ? a < r : o === ">" ? a > r : o === "<=" ? a <= r : a >= r;
    }
    return l;
  }
  function add(): unknown {
    let l = mul();
    while (isOp("+") || isOp("-")) {
      const o = next().v; const r = mul() as any; const a = l as any;
      l = o === "+" ? a + r : a - r;
    }
    return l;
  }
  function mul(): unknown {
    let l = pow();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const o = next().v; const r = pow() as number; const a = l as number;
      l = o === "*" ? a * r : o === "/" ? a / r : a % r;
    }
    return l;
  }
  function pow(): unknown {
    const base = unary();
    if (isOp("**")) { p++; return Math.pow(base as number, pow() as number); }
    return base;
  }
  function unary(): unknown {
    enter();
    let v: unknown;
    if (isOp("-")) { p++; v = -(unary() as number); }
    else if (isOp("+")) { p++; v = +(unary() as number); }
    else if (isOp("!")) { p++; v = !unary(); }
    else v = primary();
    leave();
    return v;
  }
  function primary(): unknown {
    const t = next();
    if (t.t === "num") return Number(t.v);
    if (t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") { const v = ternary(); expect(")"); return v; }
    if (t.t === "id") {
      if (isOp("(")) {
        p++;
        const args: unknown[] = [];
        if (!isOp(")")) { do { args.push(ternary()); if (isOp(",")) p++; else break; } while (true); }
        expect(")");
        if (!hasOwn(fns, t.v)) throw new Error(`Unknown function "${t.v}"`);
        return fns[t.v](...args);
      }
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      if (hasOwn(scope, t.v)) return scope[t.v];
      throw new Error(`Unknown name "${t.v}"`);
    }
    throw new Error(t.t === "end" ? "Formula ended unexpectedly" : `Unexpected "${t.v}"`);
  }

  const result = ternary();
  if (peek().t !== "end") throw new Error(`Unexpected "${peek().v}"`);
  return result;
}

/**
 * Convenience wrapper around {@link evaluateExpression} for one-off evaluations.
 * Scope and function table are optional, and any parse/evaluation error
 * (unknown name, unknown function, unsupported syntax, too long, …) yields
 * `null` instead of throwing, so formulas coming from untrusted family files
 * can never crash the caller.
 */
export function safeEval(source: string, scope: Scope = {}, fns: FnTable = {}): unknown {
  try {
    return evaluateExpression(source, scope, fns);
  } catch {
    return null;
  }
}
