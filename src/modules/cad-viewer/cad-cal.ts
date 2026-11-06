/**
 * AutoCAD CAL — a small, safe expression evaluator for the command line.
 *
 * Accepted syntax (AutoCAD QuickCalc subset, degrees for trig like the
 * AutoCAD UI prompts, not radians):
 *
 *   CAL 2*PI*25              → 157.0796
 *   CAL (3+4)*abs(-2)        → 14
 *   CAL sin(30)^2+cos(30)^2  → 1
 *   CAL sqrt(2)*round(3.6)   → 5.6569
 *   CAL min(10,max(4,7))     → 7
 *
 * Only whitelisted tokens survive the tokenizer, so no identifiers, property
 * access or constructors can reach the evaluator — the parser is a plain
 * recursive-descent arithmetic reader on a number/token stream.
 */

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (a) => Math.sin((a * Math.PI) / 180),
  cos: (a) => Math.cos((a * Math.PI) / 180),
  tan: (a) => Math.tan((a * Math.PI) / 180),
  asin: (a) => (Math.asin(a) * 180) / Math.PI,
  acos: (a) => (Math.acos(a) * 180) / Math.PI,
  atan: (a) => (Math.atan(a) * 180) / Math.PI,
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { k: "num" | "id" | "op"; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const s = src.replace(/\s+/g, "");
  while (i < s.length) {
    const ch = s[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      // 1e-3 style exponents
      if (j < s.length && /[eE]/.test(s[j]) && /[0-9+-]/.test(s[j + 1] ?? "") && /[0-9]/.test(s[i])) {
        j += 2;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      if ((s.slice(i, j).match(/\./g) ?? []).length > 1) return null;
      out.push({ k: "num", v: s.slice(i, j) });
      i = j;
    } else if (/[a-z_]/i.test(ch)) {
      let j = i;
      while (j < s.length && /[a-z0-9_]/i.test(s[j])) j++;
      out.push({ k: "id", v: s.slice(i, j).toLowerCase() });
      i = j;
    } else if ("+-*/^(),".includes(ch)) {
      out.push({ k: "op", v: ch });
      i++;
    } else {
      return null; // disallowed character — reject, never guess
    }
  }
  return out.length ? out : null;
}

export const CALC_FUNCS = Object.keys(FUNCS);
export const CALC_CONSTS = Object.keys(CONSTS);

/**
 * Heuristic: does this string look like a pure arithmetic expression the CAL
 * evaluator should consume? Requires at least one digit and an operator, and
 * rejects anything that could be a drawing word (spaces with letters like
 * "WALL 3", unit suffixes, etc.).
 */
export function isCalcExpr(src: string): boolean {
  const s = src.trim();
  if (!s || !/[0-9]/.test(s)) return false;
  if (!/[+\-*/^()]/.test(s)) return false;
  if (/\s/.test(s)) return false; // AutoCAD numeric entry never contains spaces
  return tokenize(s) !== null;
}

/** Evaluate an expression; returns null on any parse/eval failure. */
export function evalExpr(src: string): number | null {
  const toks = tokenize(src);
  if (!toks) return null;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string): boolean => {
    if (toks[p] && toks[p].k === "op" && toks[p].v === v) {
      p++;
      return true;
    }
    return false;
  };

  const primary = (): number | null => {
    const t = peek();
    if (!t) return null;
    if (t.k === "num") {
      p++;
      const n = parseFloat(t.v);
      return Number.isFinite(n) ? n : null;
    }
    if (t.k === "op" && t.v === "(") {
      p++;
      const v = expr();
      if (v === null || !eat(")")) return null;
      return v;
    }
    if (t.k === "op" && t.v === "-") {
      p++;
      const v = primary();
      return v === null ? null : -v;
    }
    if (t.k === "op" && t.v === "+") {
      p++;
      return primary();
    }
    if (t.k === "id") {
      p++;
      const name = t.v;
      if (peek() && peek().k === "op" && peek().v === "(") {
        const f = FUNCS[name];
        if (!f) return null;
        p++; // consume "("
        const args: number[] = [];
        if (!(peek() && peek().k === "op" && peek().v === ")")) {
          for (;;) {
            const a = expr();
            if (a === null) return null;
            args.push(a);
            if (eat(",")) continue;
            break;
          }
        }
        if (!eat(")")) return null;
        if (args.length < 1 || args.length > 5) return null;
        const r = f(...args);
        return Number.isFinite(r) ? r : null;
      }
      if (name in CONSTS) return CONSTS[name];
      return null; // bare identifiers are not variables in CAL
    }
    return null;
  };

  const power = (): number | null => {
    const base = primary();
    if (base === null) return null;
    if (peek() && peek().k === "op" && peek().v === "^") {
      p++;
      const exp = unary();
      if (exp === null) return null;
      const r = Math.pow(base, exp);
      return Number.isFinite(r) ? r : null;
    }
    return base;
  };

  const unary = (): number | null => {
    if (peek() && peek().k === "op" && (peek().v === "-" || peek().v === "+")) {
      const neg = peek().v === "-";
      p++;
      const v = unary();
      return v === null ? null : neg ? -v : v;
    }
    return power();
  };

  const term = (): number | null => {
    let v = unary();
    if (v === null) return null;
    for (;;) {
      if (eat("*")) {
        const r = unary();
        if (r === null) return null;
        v *= r;
      } else if (eat("/")) {
        const r = unary();
        if (r === null || r === 0) return null;
        v /= r;
      } else return Number.isFinite(v) ? v : null;
    }
  };

  const expr = (): number | null => {
    let v = term();
    if (v === null) return null;
    for (;;) {
      if (eat("+")) {
        const r = term();
        if (r === null) return null;
        v += r;
      } else if (eat("-")) {
        const r = term();
        if (r === null) return null;
        v -= r;
      } else return Number.isFinite(v) ? v : null;
    }
  };

  const result = expr();
  if (result === null || p !== toks.length) return null;
  return result;
}
