"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateExpression = evaluateExpression;
exports.safeEval = safeEval;
const OPS = ["===", "!==", "**", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ","];
const MAX_LEN = 2000;
const MAX_DEPTH = 64;
function tokenize(src) {
    if (src.length > MAX_LEN)
        throw new Error("Formula is too long");
    const out = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
        if (num) {
            out.push({ t: "num", v: num[0] });
            i += num[0].length;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1, s = "";
            while (j < src.length && src[j] !== c) {
                if (src[j] === "\\" || src[j] === "\n")
                    throw new Error("Unsupported character in text");
                s += src[j++];
            }
            if (j >= src.length)
                throw new Error("Unterminated text");
            out.push({ t: "str", v: s });
            i = j + 1;
            continue;
        }
        const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        if (id) {
            out.push({ t: "id", v: id[0] });
            i += id[0].length;
            continue;
        }
        const op = OPS.find((o) => src.startsWith(o, i));
        if (!op)
            throw new Error(`Unsupported character "${c}"`);
        out.push({ t: "op", v: op });
        i += op.length;
    }
    out.push({ t: "end", v: "" });
    return out;
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function evaluateExpression(source, scope, fns) {
    const toks = tokenize(source);
    let p = 0;
    let depth = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => peek().t === "op" && peek().v === v;
    const expect = (v) => { if (!isOp(v))
        throw new Error(`Expected "${v}"`); p++; };
    const enter = () => { if (++depth > MAX_DEPTH)
        throw new Error("Formula is nested too deeply"); };
    const leave = () => { depth--; };
    function ternary() {
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
    function or() { let l = and(); while (isOp("||")) {
        p++;
        const r = and();
        l = l || r;
    } return l; }
    function and() { let l = eq(); while (isOp("&&")) {
        p++;
        const r = eq();
        l = l && r;
    } return l; }
    function eq() {
        let l = rel();
        while (isOp("==") || isOp("!=") || isOp("===") || isOp("!==")) {
            const o = next().v;
            const r = rel();
            l = o === "==" || o === "===" ? l === r : l !== r;
        }
        return l;
    }
    function rel() {
        let l = add();
        while (isOp("<") || isOp(">") || isOp("<=") || isOp(">=")) {
            const o = next().v;
            const r = add();
            const a = l;
            l = o === "<" ? a < r : o === ">" ? a > r : o === "<=" ? a <= r : a >= r;
        }
        return l;
    }
    function add() {
        let l = mul();
        while (isOp("+") || isOp("-")) {
            const o = next().v;
            const r = mul();
            const a = l;
            l = o === "+" ? a + r : a - r;
        }
        return l;
    }
    function mul() {
        let l = pow();
        while (isOp("*") || isOp("/") || isOp("%")) {
            const o = next().v;
            const r = pow();
            const a = l;
            l = o === "*" ? a * r : o === "/" ? a / r : a % r;
        }
        return l;
    }
    function pow() {
        const base = unary();
        if (isOp("**") || isOp("^")) {
            p++;
            return Math.pow(base, pow());
        }
        return base;
    }
    function unary() {
        enter();
        let v;
        if (isOp("-")) {
            p++;
            v = -unary();
        }
        else if (isOp("+")) {
            p++;
            v = +unary();
        }
        else if (isOp("!")) {
            p++;
            v = !unary();
        }
        else
            v = primary();
        leave();
        return v;
    }
    function primary() {
        const t = next();
        if (t.t === "num")
            return Number(t.v);
        if (t.t === "str")
            return t.v;
        if (t.t === "op" && t.v === "(") {
            const v = ternary();
            expect(")");
            return v;
        }
        if (t.t === "id") {
            if (isOp("(")) {
                p++;
                const args = [];
                if (!isOp(")")) {
                    do {
                        args.push(ternary());
                        if (isOp(","))
                            p++;
                        else
                            break;
                    } while (true);
                }
                expect(")");
                if (!hasOwn(fns, t.v))
                    throw new Error(`Unknown function "${t.v}"`);
                return fns[t.v](...args);
            }
            if (t.v === "true")
                return true;
            if (t.v === "false")
                return false;
            if (hasOwn(scope, t.v))
                return scope[t.v];
            throw new Error(`Unknown name "${t.v}"`);
        }
        throw new Error(t.t === "end" ? "Formula ended unexpectedly" : `Unexpected "${t.v}"`);
    }
    const result = ternary();
    if (peek().t !== "end")
        throw new Error(`Unexpected "${peek().v}"`);
    return result;
}
/**
 * Convenience wrapper around {@link evaluateExpression} for one-off evaluations.
 * Scope and function table are optional, and any parse/evaluation error
 * (unknown name, unknown function, unsupported syntax, too long, …) yields
 * `null` instead of throwing, so formulas coming from untrusted family files
 * can never crash the caller.
 */
function safeEval(source, scope = {}, fns = {}) {
    try {
        return evaluateExpression(source, scope, fns);
    }
    catch {
        return null;
    }
}
