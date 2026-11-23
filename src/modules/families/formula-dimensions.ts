// openbim-families:dimensional-analysis (PE-01)
//
// Dimensional analysis for family formulas.
//
// The formula engine used to treat units as decoration: a parameter's
// `type`/`unit` was never checked during evaluation, `mm`/`ft` were plain
// numeric scalings, and `Length + Area` evaluated silently to a wrong
// number. This module carries a dimension with every value through the
// formula AST and rejects ill-typed formulas with a named, typed error
// (DimensionError) instead of evaluating them.
//
// Design — a static gate, not a second evaluator:
//   - `analyseFormulaDimensions` parses the (already word-operator
//     rewritten) formula body with a small recursive-descent parser that
//     mirrors the safe-expr grammar, and infers the result dimension.
//     The numeric evaluator in safe-expr.ts is untouched: a formula that
//     passes the gate evaluates exactly as before, so valid formulas keep
//     their values bit-for-bit.
//   - Dimensions are length/mass/angle exponents { L, M, A } (angle is
//     its own dimension, distinct from dimensionless). Length^2 is area,
//     length^3 is volume; there is no separate area/volume axis.
//   - A bare numeric literal is *polymorphic*: in an additive context it
//     takes the dimension of the other operand (`Width - 0.08` reads 0.08
//     as metres — the formula's implicit SI context), in a multiplicative
//     context it is a dimensionless scalar. This is what the live corpus
//     requires: every built-in formula mixes literals with lengths
//     (`OpeningWidth / 2 - 0.01`, `min(PanelWidth * 0.5, 0.5)`).
//   - A parameter reference resolves to the dimension of its declared
//     type. Length / area / volume values are converted to SI (metres /
//     m^2 / m^3) before arithmetic, using the declared unit, so `mm + m`
//     converts and evaluates correctly. Angle values are NOT converted:
//     they are stored in their declared unit (degrees for unit "deg")
//     because the live corpus consumes them as degrees and converts
//     explicitly at the point of use — see unitFactorFor. A dimensional
//     parameter with no `unit` is read as SI — the repo's stated
//     internal-storage convention (src/core/units.ts: "Internal storage
//     is always SI") — because the live suites declare unit-less length
//     parameters and require them to evaluate
//     (tests/parameter-scope.test.cjs synthetic family,
//     tests/zod-boundaries.test.cjs §F). A unit string that names no unit
//     of the parameter's type (e.g. a length with unit "m2") is NOT
//     silently defaulted: any formula touching that parameter is rejected
//     with `unit-confusion`.
//   - Trig follows the evaluator's documented convention: sin()/cos()/
//     tan() are radians ("Trig (radians)" in formula-engine.ts) and
//     therefore require a dimensionless argument — an angle-typed
//     (degree-stored) argument is rejected with
//     `non-dimensionless-argument` and the message directs to sind() or
//     deg(), because accepting it would compute sin(degrees), a silent
//     wrong number. sind()/cosd()/tand() take an angle or a dimensionless
//     value (read as degrees). asin()/acos()/atan()/atan2() return an
//     angle whose VALUE is in radians (Math.asin); assigning it to a
//     degree-stored angle parameter needs to_deg() — the explicit bridge.
//   - A name with no declaration and no seed value is already rejected
//     upstream (PE-20 unknown-name). A seed-only name — a value injected
//     by the host without a declaration — has dimension `unknown`: it
//     unifies with anything and propagates opaquely. That is the deliberate
//     legacy escape for host-injected values (zod-boundaries pins
//     `seeded + 1`); it is not a silent dimensionless default for a
//     declared parameter.
//   - A `number`/`integer` formula *target* accepts any result dimension:
//     the corpus declares section inertia (L^4) as `number`, and the
//     golden harness declares every parameter `number`. Only dimensional
//     targets (length/area/volume/angle) are checked against the inferred
//     result dimension. See checkTargetDimension in formula-engine.ts.
//
// Error codes (all surfaced through the existing per-parameter formula
// error path, never as a silent wrong number):
//   - `dimension-mismatch`: + / - / % / comparisons / min / max / if-
//     branches across different dimensions, a function given a dimension
//     it does not accept (e.g. sin(length)), or a result whose dimension
//     does not match a dimensional target.
//   - `unit-confusion`: a declared unit that does not belong to the
//     parameter's type, or a unit converter/constructor applied to a
//     value of the wrong dimension (e.g. to_mm(area)).
//   - `non-dimensionless-argument`: a function that requires a
//     dimensionless argument given a dimensional one (e.g. round(length),
//     log(length), mm(length), a non-dimensionless power exponent).
//
// This module never evaluates and never touches the DOM, storage, or
// the network. It has no dependency on safe-expr: the parser here is a
// static analyser, not an evaluator.

import type { FamilyParameter } from "./types";

/* -- Dimensions ------------------------------------------------------- */

/** Exponents for length / mass / angle. Area is L=2, volume is L=3. */
export interface Dimension {
  L: number;
  M: number;
  A: number;
}

export const DIMENSIONLESS: Dimension = { L: 0, M: 0, A: 0 };
export const LENGTH: Dimension = { L: 1, M: 0, A: 0 };
export const AREA: Dimension = { L: 2, M: 0, A: 0 };
export const VOLUME: Dimension = { L: 3, M: 0, A: 0 };
export const ANGLE: Dimension = { L: 0, M: 0, A: 1 };

/**
 * The dimension carried by one value during inference.
 * - `dim`: a concrete dimension (exponents).
 * - `literal`: a bare numeric literal — polymorphic, see the header.
 * - `unknown`: a seed-only / untyped name — unifies with anything.
 * - `text` / `bool`: non-numeric values (string literals, booleans).
 */
export type DimValue =
  | { kind: "dim"; dim: Dimension }
  | { kind: "literal" }
  | { kind: "unknown" }
  | { kind: "text" }
  | { kind: "bool" };

export const LITERAL: DimValue = { kind: "literal" };
export const UNKNOWN_DIM: DimValue = { kind: "unknown" };
export const TEXT_DIM: DimValue = { kind: "text" };
export const BOOL_DIM: DimValue = { kind: "bool" };

export function dimOf(d: Dimension): DimValue {
  return { kind: "dim", dim: { L: d.L, M: d.M, A: d.A } };
}

function dimsEqual(a: Dimension, b: Dimension): boolean {
  return a.L === b.L && a.M === b.M && a.A === b.A;
}

function isDimensionlessValue(v: DimValue): boolean {
  return (
    v.kind === "literal" ||
    v.kind === "unknown" ||
    (v.kind === "dim" && dimsEqual(v.dim, DIMENSIONLESS)) ||
    v.kind === "bool"
  );
}

/** Human-readable dimension for error messages. */
export function dimensionLabel(v: DimValue): string {
  if (v.kind === "literal") return "a bare number (no unit)";
  if (v.kind === "unknown") return "an untyped value";
  if (v.kind === "text") return "text";
  if (v.kind === "bool") return "a boolean";
  const d = v.dim;
  if (dimsEqual(d, DIMENSIONLESS)) return "dimensionless";
  if (dimsEqual(d, LENGTH)) return "length";
  if (dimsEqual(d, AREA)) return "area";
  if (dimsEqual(d, VOLUME)) return "volume";
  if (dimsEqual(d, ANGLE)) return "angle";
  const parts: string[] = [];
  if (d.L !== 0) parts.push(d.L === 1 ? "length" : `length^${d.L}`);
  if (d.M !== 0) parts.push(d.M === 1 ? "mass" : `mass^${d.M}`);
  if (d.A !== 0) parts.push(d.A === 1 ? "angle" : `angle^${d.A}`);
  return parts.join(" * ") || "dimensionless";
}

/* -- Named errors ------------------------------------------------------ */

export type DimensionErrorCode =
  | "dimension-mismatch"
  | "unit-confusion"
  | "non-dimensionless-argument";

/** Named, typed rejection for an ill-typed formula. Never a silent number. */
export class DimensionError extends Error {
  readonly code: DimensionErrorCode;
  constructor(code: DimensionErrorCode, message: string) {
    super(message);
    this.name = "DimensionError";
    this.code = code;
  }
}

function mismatch(message: string): DimensionError {
  return new DimensionError("dimension-mismatch", message);
}

function unitConfusion(message: string): DimensionError {
  return new DimensionError("unit-confusion", message);
}

function nonDimensionless(message: string): DimensionError {
  return new DimensionError("non-dimensionless-argument", message);
}

/* -- Units: declared unit -> SI factor ---------------------------------- */

// Conversion factors to SI, mirroring src/core/units.ts
// (LENGTH_TO_M, AREA_TO_M2, VOLUME_TO_M3, ANGLE_TO_RAD). Kept as a local
// table so this module stays dependency-free; the values are the same
// constants, and tests/dimensional-analysis.test.cjs pins the table
// against src/core/units.ts.
const LENGTH_TO_M: Record<string, number> = {
  mm: 1e-3,
  cm: 1e-2,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};
const AREA_TO_M2: Record<string, number> = {
  mm2: 1e-6,
  cm2: 1e-4,
  m2: 1,
  ft2: 0.09290304,
  in2: 0.00064516,
};
const VOLUME_TO_M3: Record<string, number> = {
  mm3: 1e-9,
  cm3: 1e-6,
  m3: 1,
  ft3: 0.028316846592,
  in3: 1.6387064e-5,
  l: 1e-3,
};
// NOTE on angles: there is deliberately no angle conversion table
// here. Angle parameter values are stored in their declared unit
// (degrees for unit "deg") and are never converted on input: the live
// corpus consumes them as degrees and converts explicitly at the point
// of use (the plinth family's geometry does "rotation * pi() / 180";
// ProfileSpec documents arc angles in degrees). Converting angle
// parameters to radians would double-convert and break
// parametric-rectangular-family T3/T4 and sketch-arcs-constraints T3.
// The radian builtins (deg(), to_deg(), asin(), sind() for degrees) are
// the explicit bridges; the engine never converts an angle parameter.

/** Normalise a unit string for lookup: case, superscript powers, °. */
function normaliseUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/°/g, "deg");
}

/**
 * SI factor for a parameter's declared unit, or `null` when the unit
 * string names no unit of the parameter's type. A missing/empty unit on
 * a dimensional type returns 1 (SI assumed — see the header); a unit on
 * a dimensionless / non-numeric type is display-only and ignored.
 *
 * Angles are the exception: always 1, whatever the declared unit.
 * Length/area/volume values must be SI (metres) because geometry
 * consumes metres, but angle values are stored in their declared unit
 * (degrees for unit "deg") because the live corpus consumes them as
 * degrees and converts explicitly at the point of use (plinth geometry
 * "rotation * pi() / 180"; ProfileSpec arc angles in degrees). The
 * radian builtins (deg(), to_deg(), asin(), sind() for degrees) are the
 * explicit bridges; the engine never converts an angle parameter.
 */
export function unitFactorFor(
  type: string | undefined,
  unit: string | undefined,
): number | null {
  if (type === "angle") return 1;
  if (type === "length" || type === "area" || type === "volume") {
    if (unit === undefined || unit === null || String(unit).trim() === "") return 1;
    const table =
      type === "length" ? LENGTH_TO_M : type === "area" ? AREA_TO_M2 : VOLUME_TO_M3;
    const factor = table[normaliseUnit(unit)];
    return factor === undefined ? null : factor;
  }
  return 1;
}

/** Dimension implied by a parameter type (ignoring its unit). */
export function dimensionOfType(type: string | undefined): DimValue {
  switch (type) {
    case "length":
      return dimOf(LENGTH);
    case "area":
      return dimOf(AREA);
    case "volume":
      return dimOf(VOLUME);
    case "angle":
      return dimOf(ANGLE);
    case "number":
    case "integer":
      return dimOf(DIMENSIONLESS);
    case "boolean":
      return BOOL_DIM;
    case "text":
    case "material":
    case "colour":
    case "family-type":
      return TEXT_DIM;
    default:
      return UNKNOWN_DIM;
  }
}

/* -- Environment -------------------------------------------------------- */

export interface DimensionInfo {
  /** Dimension carried by the parameter's value (in SI). */
  dimension: DimValue;
  /** Multiply a stored (declared-unit) value to get SI. 1 for SI units. */
  toSI: number;
  /** Set when the declared unit cannot be converted for this type. */
  unitError?: string;
}

export interface DimensionEnv {
  /** Declared parameters by name. */
  declared: Map<string, DimensionInfo>;
  /** Seed-only names (a value with no declaration): dimension unknown. */
  seedOnly: Set<string>;
}

/**
 * Build the dimension environment for one evaluation pass. `seedValues`
 * supplies the seed-only names; every other name must be a declared
 * parameter (unknown names are rejected upstream by PE-20).
 */
export function buildDimensionEnv(
  declarations: FamilyParameter[],
  seedValues: Record<string, unknown> = {},
): DimensionEnv {
  const declared = new Map<string, DimensionInfo>();
  for (const p of declarations) {
    const factor = unitFactorFor(p.type, p.unit);
    if (factor === null) {
      declared.set(p.name, {
        dimension: dimensionOfType(p.type),
        toSI: 1,
        unitError:
          `parameter "${p.name}" is declared ${p.type ?? "untyped"} ` +
          `with unit "${p.unit}", which is not a ${p.type} unit`,
      });
    } else {
      declared.set(p.name, { dimension: dimensionOfType(p.type), toSI: factor });
    }
  }
  const seedOnly = new Set<string>();
  for (const k of Object.keys(seedValues ?? {})) {
    if (!declared.has(k)) seedOnly.add(k);
  }
  return { declared, seedOnly };
}

/** Convert one stored value to SI using its declaration (non-numbers pass through). */
export function toSIValue(value: unknown, info: DimensionInfo | undefined): unknown {
  if (typeof value !== "number" || !info || info.toSI === 1) return value;
  return value * info.toSI;
}

/** Convert one SI value back to the parameter's declared unit. */
export function fromSIValue(value: unknown, info: DimensionInfo | undefined): unknown {
  if (typeof value !== "number" || !info || info.toSI === 1) return value;
  return value / info.toSI;
}

/**
 * Convert a resolved (SI) value map back to declared units, for callers
 * that must re-feed resolved values as `evaluateParameters` seeds (seeds
 * are always in declared units). Seed-only names pass through unchanged.
 */
export function toDeclaredUnits(
  values: Record<string, unknown>,
  declarations: FamilyParameter[],
): Record<string, unknown> {
  const env = buildDimensionEnv(declarations, {});
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    out[k] = fromSIValue(v, env.declared.get(k));
  }
  return out;
}

/* -- AST + inference ----------------------------------------------------- */

type Tok = { t: "num" | "str" | "id" | "op" | "end"; v: string };

const OPS = [
  "===",
  "!==",
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "<",
  ">",
  "!",
  "?",
  ":",
  "(",
  ")",
  ",",
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
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
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" || src[j] === "\n") throw new Error("Unsupported character in text");
        s += src[j++];
      }
      if (j >= src.length) throw new Error("Unterminated text");
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
    if (!op) throw new Error(`Unsupported character "${c}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "end", v: "" });
  return out;
}

type AstNode =
  | { kind: "num"; value: number }
  | { kind: "str" }
  | { kind: "bool"; value: boolean }
  | { kind: "id"; name: string }
  | { kind: "call"; name: string; args: AstNode[] }
  | { kind: "unary"; op: string; arg: AstNode }
  | { kind: "binary"; op: string; left: AstNode; right: AstNode }
  | { kind: "ternary"; cond: AstNode; then: AstNode; otherwise: AstNode };

/**
 * Parse a formula body. The grammar mirrors safe-expr.ts exactly
 * (ternary > || > && > ==/!= > relational > additive > multiplicative >
 * power (right-associative, `^` and `**`) > unary > primary), so the
 * inferred dimension always describes the value the evaluator computes.
 * Throws a plain Error on syntax problems; callers report it as a
 * formula error, exactly as the evaluator's own parse errors are.
 */
function parse(src: string): AstNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => peek().t === "op" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    p++;
  };

  function ternary(): AstNode {
    const c = or();
    if (isOp("?")) {
      p++;
      const a = ternary();
      expect(":");
      const b = ternary();
      return { kind: "ternary", cond: c, then: a, otherwise: b };
    }
    return c;
  }
  function or(): AstNode {
    let l = and();
    while (isOp("||")) {
      p++;
      l = { kind: "binary", op: "||", left: l, right: and() };
    }
    return l;
  }
  function and(): AstNode {
    let l = eq();
    while (isOp("&&")) {
      p++;
      l = { kind: "binary", op: "&&", left: l, right: eq() };
    }
    return l;
  }
  function eq(): AstNode {
    let l = rel();
    while (isOp("==") || isOp("!=") || isOp("===") || isOp("!==")) {
      const o = next().v;
      l = { kind: "binary", op: o, left: l, right: rel() };
    }
    return l;
  }
  function rel(): AstNode {
    let l = add();
    while (isOp("<") || isOp(">") || isOp("<=") || isOp(">=")) {
      const o = next().v;
      l = { kind: "binary", op: o, left: l, right: add() };
    }
    return l;
  }
  function add(): AstNode {
    let l = mul();
    while (isOp("+") || isOp("-")) {
      const o = next().v;
      l = { kind: "binary", op: o, left: l, right: mul() };
    }
    return l;
  }
  function mul(): AstNode {
    let l = pow();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const o = next().v;
      l = { kind: "binary", op: o, left: l, right: pow() };
    }
    return l;
  }
  function pow(): AstNode {
    const base = unary();
    if (isOp("**") || isOp("^")) {
      const o = next().v;
      return { kind: "binary", op: o, left: base, right: pow() };
    }
    return base;
  }
  function unary(): AstNode {
    if (isOp("-") || isOp("+") || isOp("!")) {
      const o = next().v;
      return { kind: "unary", op: o, arg: unary() };
    }
    return primary();
  }
  function primary(): AstNode {
    const t = next();
    if (t.t === "num") return { kind: "num", value: Number(t.v) };
    if (t.t === "str") return { kind: "str" };
    if (t.t === "op" && t.v === "(") {
      const v = ternary();
      expect(")");
      return v;
    }
    if (t.t === "id") {
      if (t.v === "true") return { kind: "bool", value: true };
      if (t.v === "false") return { kind: "bool", value: false };
      if (isOp("(")) {
        p++;
        const args: AstNode[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(ternary());
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        expect(")");
        return { kind: "call", name: t.v, args };
      }
      return { kind: "id", name: t.v };
    }
    throw new Error(t.t === "end" ? "Formula ended unexpectedly" : `Unexpected "${t.v}"`);
  }

  const result = ternary();
  if (peek().t !== "end") throw new Error(`Unexpected "${peek().v}"`);
  return result;
}

/* -- Inference rules ------------------------------------------------------ */

/** Unify two operand dimensions for + / - / comparisons / min / max / if. */
function unify(a: DimValue, b: DimValue, what: string): DimValue {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN_DIM;
  if (a.kind === "literal") return b;
  if (b.kind === "literal") return a;
  if (a.kind === "text" || b.kind === "text") {
    if (a.kind === "text" && b.kind === "text") return TEXT_DIM;
    throw mismatch(
      `${what} cannot combine ${dimensionLabel(a)} and ${dimensionLabel(b)}`,
    );
  }
  if (a.kind === "bool" || b.kind === "bool") {
    // bool == bool is fine. (A bare 0/1 literal against a boolean is
    // already handled above: the literal arms return before this point,
    // so bool-vs-literal unifies to the boolean side.)
    if (a.kind === "bool" && b.kind === "bool") return BOOL_DIM;
    throw mismatch(
      `${what} cannot combine ${dimensionLabel(a)} and ${dimensionLabel(b)}`,
    );
  }
  if (a.kind === "dim" && b.kind === "dim") {
    if (!dimsEqual(a.dim, b.dim)) {
      throw mismatch(
        `${what} cannot combine ${dimensionLabel(a)} and ${dimensionLabel(b)}`,
      );
    }
    return a;
  }
  throw mismatch(`${what} cannot combine ${dimensionLabel(a)} and ${dimensionLabel(b)}`);
}

function requireDimensionless(v: DimValue, what: string): void {
  if (v.kind === "literal" || v.kind === "unknown") return;
  if (v.kind === "dim" && dimsEqual(v.dim, DIMENSIONLESS)) return;
  if (v.kind === "bool") return;
  throw nonDimensionless(`${what} expects a dimensionless argument, got ${dimensionLabel(v)}`);
}

function requireAngleOrDimensionless(v: DimValue, what: string): DimValue {
  if (v.kind === "literal" || v.kind === "unknown") return v;
  if (v.kind === "dim" && (dimsEqual(v.dim, DIMENSIONLESS) || dimsEqual(v.dim, ANGLE))) return v;
  throw mismatch(
    `${what} expects an angle or a dimensionless value, got ${dimensionLabel(v)}`,
  );
}

function requireNumeric(v: DimValue, what: string): DimValue {
  if (v.kind === "text" || v.kind === "bool") {
    throw mismatch(`${what} cannot be applied to ${dimensionLabel(v)}`);
  }
  return v;
}

function scaleDim(v: DimValue, exponent: number): DimValue {
  if (v.kind === "literal") return LITERAL;
  if (v.kind === "unknown") return UNKNOWN_DIM;
  if (v.kind === "text" || v.kind === "bool") {
    throw mismatch(`a power cannot be applied to ${dimensionLabel(v)}`);
  }
  const d = v.dim;
  return dimOf({ L: d.L * exponent, M: d.M * exponent, A: d.A * exponent });
}

function infer(node: AstNode, env: DimensionEnv): DimValue {
  switch (node.kind) {
    case "num":
      return LITERAL;
    case "str":
      return TEXT_DIM;
    case "bool":
      return BOOL_DIM;
    case "id": {
      const info = env.declared.get(node.name);
      if (info) {
        if (info.unitError) throw unitConfusion(info.unitError);
        return info.dimension;
      }
      if (env.seedOnly.has(node.name)) return UNKNOWN_DIM;
      // Unknown names are rejected upstream by PE-20 validation; reaching
      // here means the checker was called without that validation.
      throw new Error(`Unknown name "${node.name}"`);
    }
    case "unary": {
      const a = infer(node.arg, env);
      if (node.op === "!") {
        if (a.kind === "dim" && !dimsEqual(a.dim, DIMENSIONLESS)) {
          throw mismatch(`"!" cannot be applied to ${dimensionLabel(a)}`);
        }
        if (a.kind === "text") throw mismatch(`"!" cannot be applied to text`);
        return BOOL_DIM;
      }
      return requireNumeric(a, `unary "${node.op}"`);
    }
    case "ternary": {
      const c = infer(node.cond, env);
      if (c.kind === "dim" && !dimsEqual(c.dim, DIMENSIONLESS)) {
        throw mismatch(
          `a condition must be dimensionless or boolean, got ${dimensionLabel(c)}`,
        );
      }
      if (c.kind === "text") throw mismatch("a condition must be dimensionless or boolean, got text");
      return unify(infer(node.then, env), infer(node.otherwise, env), "if branches");
    }
    case "binary": {
      const op = node.op;
      if (op === "&&" || op === "||") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        for (const v of [l, r]) {
          if (v.kind === "dim" && !dimsEqual(v.dim, DIMENSIONLESS)) {
            throw mismatch(`"${op}" cannot be applied to ${dimensionLabel(v)}`);
          }
          if (v.kind === "text") throw mismatch(`"${op}" cannot be applied to text`);
        }
        return BOOL_DIM;
      }
      if (op === "==" || op === "!=" || op === "===" || op === "!==") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        unify(l, r, "comparison");
        return BOOL_DIM;
      }
      if (op === "<" || op === ">" || op === "<=" || op === ">=") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        if (l.kind === "text" || r.kind === "text" || l.kind === "bool" || r.kind === "bool") {
          throw mismatch(
            `"${op}" cannot compare ${dimensionLabel(l)} and ${dimensionLabel(r)}`,
          );
        }
        unify(l, r, "comparison");
        return BOOL_DIM;
      }
      if (op === "+") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        // `+` is also string concatenation in this engine ("W-" + width).
        if (l.kind === "text" || r.kind === "text") return TEXT_DIM;
        return unify(l, r, "addition");
      }
      if (op === "-") {
        return unify(infer(node.left, env), infer(node.right, env), "subtraction");
      }
      if (op === "%") {
        return unify(infer(node.left, env), infer(node.right, env), "remainder");
      }
      if (op === "*") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        requireNumeric(l, "multiplication");
        requireNumeric(r, "multiplication");
        if (l.kind === "unknown" || r.kind === "unknown") return UNKNOWN_DIM;
        if (l.kind === "literal") return r;
        if (r.kind === "literal") return l;
        const ld = (l as { dim: Dimension }).dim;
        const rd = (r as { dim: Dimension }).dim;
        return dimOf({ L: ld.L + rd.L, M: ld.M + rd.M, A: ld.A + rd.A });
      }
      if (op === "/") {
        const l = infer(node.left, env);
        const r = infer(node.right, env);
        requireNumeric(l, "division");
        requireNumeric(r, "division");
        if (l.kind === "unknown" || r.kind === "unknown") return UNKNOWN_DIM;
        if (l.kind === "literal") {
          if (r.kind === "literal") return LITERAL;
          const rd = (r as { dim: Dimension }).dim;
          return dimOf({ L: -rd.L, M: -rd.M, A: -rd.A });
        }
        if (r.kind === "literal") return l;
        const ld = (l as { dim: Dimension }).dim;
        const rd = (r as { dim: Dimension }).dim;
        return dimOf({ L: ld.L - rd.L, M: ld.M - rd.M, A: ld.A - rd.A });
      }
      if (op === "^" || op === "**") {
        const base = infer(node.left, env);
        const exp = infer(node.right, env);
        requireDimensionless(exp, `the exponent of "${op}"`);
        requireNumeric(base, `"${op}"`);
        if (node.right.kind === "num") return scaleDim(base, node.right.value);
        if (exp.kind === "literal" || exp.kind === "unknown") {
          // A non-literal dimensionless exponent: the result dimension
          // cannot be known statically (length^n for unknown n).
          return base.kind === "literal" ? LITERAL : UNKNOWN_DIM;
        }
        return UNKNOWN_DIM;
      }
      throw new Error(`Unsupported operator "${op}"`);
    }
    case "call":
      return inferCall(node, env);
  }
}

function inferCall(node: Extract<AstNode, { kind: "call" }>, env: DimensionEnv): DimValue {
  const args = node.args.map((a) => infer(a, env));
  const name = node.name;
  const arity = (n: number) => {
    if (args.length !== n) throw new Error(`"${name}" expects ${n} argument(s)`);
  };
  const atLeast = (n: number) => {
    if (args.length < n) throw new Error(`"${name}" expects at least ${n} argument(s)`);
  };
  switch (name) {
    // Trig (radians): dimensionless in, dimensionless out. An angle
    // argument is rejected, not silently computed: the evaluator's
    // sin() is radians ("Trig (radians)" in formula-engine.ts) while an
    // angle-typed value is degree-stored, so sin(angle) would compute
    // sin(degrees) — a silent wrong number, the exact failure PE-01
    // exists to prevent. sind()/cosd()/tand() are the degree builtins.
    case "sin":
    case "cos":
    case "tan":
      arity(1);
      requireDimensionless(
        args[0],
        `${name}() (radians — use ${name}d() for degrees, or deg() to convert an angle)`,
      );
      return dimOf(DIMENSIONLESS);
    // Inverse trig: dimensionless in, angle out.
    case "asin":
    case "acos":
    case "atan":
      arity(1);
      requireDimensionless(args[0], `${name}()`);
      return dimOf(ANGLE);
    case "atan2": {
      arity(2);
      unify(args[0], args[1], "atan2 arguments");
      return dimOf(ANGLE);
    }
    // Degree trig: angle or dimensionless (read as degrees) in.
    case "sind":
    case "cosd":
    case "tand":
      arity(1);
      requireAngleOrDimensionless(args[0], `${name}()`);
      return dimOf(DIMENSIONLESS);
    case "sqrt":
      arity(1);
      requireNumeric(args[0], "sqrt()");
      return scaleDim(args[0], 0.5);
    case "abs":
      arity(1);
      return requireNumeric(args[0], "abs()");
    case "min":
    case "max": {
      if (args.length === 0) return dimOf(DIMENSIONLESS);
      let acc = args[0];
      for (let i = 1; i < args.length; i++) acc = unify(acc, args[i], `${name}() arguments`);
      return acc;
    }
    case "round": {
      atLeast(1);
      if (args.length > 2) throw new Error(`"round" expects at most 2 arguments`);
      requireDimensionless(args[0], "round()");
      if (args.length === 2) requireDimensionless(args[1], "round() digits");
      return dimOf(DIMENSIONLESS);
    }
    case "floor":
    case "ceil":
      arity(1);
      requireDimensionless(args[0], `${name}()`);
      return dimOf(DIMENSIONLESS);
    case "pow": {
      arity(2);
      requireDimensionless(args[1], "the exponent of pow()");
      requireNumeric(args[0], "pow()");
      if (node.args[1].kind === "num") return scaleDim(args[0], node.args[1].value);
      return args[0].kind === "literal" ? LITERAL : UNKNOWN_DIM;
    }
    case "log":
    case "log10":
    case "exp":
      arity(1);
      requireDimensionless(args[0], `${name}()`);
      return dimOf(DIMENSIONLESS);
    case "pi":
    case "e":
      arity(0);
      return dimOf(DIMENSIONLESS);
    case "if": {
      arity(3);
      const c = args[0];
      if (c.kind === "dim" && !dimsEqual(c.dim, DIMENSIONLESS)) {
        throw mismatch(`if() condition must be dimensionless or boolean, got ${dimensionLabel(c)}`);
      }
      if (c.kind === "text") throw mismatch("if() condition must be dimensionless or boolean, got text");
      return unify(args[1], args[2], "if() branches");
    }
    case "and":
    case "or":
      atLeast(1);
      for (const a of args) {
        if (a.kind === "dim" && !dimsEqual(a.dim, DIMENSIONLESS)) {
          throw mismatch(`${name}() cannot be applied to ${dimensionLabel(a)}`);
        }
        if (a.kind === "text") throw mismatch(`${name}() cannot be applied to text`);
      }
      return BOOL_DIM;
    case "not":
      arity(1);
      if (args[0].kind === "dim" && !dimsEqual(args[0].dim, DIMENSIONLESS)) {
        throw mismatch(`not() cannot be applied to ${dimensionLabel(args[0])}`);
      }
      if (args[0].kind === "text") throw mismatch("not() cannot be applied to text");
      return BOOL_DIM;
    case "xor":
      arity(2);
      for (const a of args) {
        if (a.kind === "dim" && !dimsEqual(a.dim, DIMENSIONLESS)) {
          throw mismatch(`xor() cannot be applied to ${dimensionLabel(a)}`);
        }
        if (a.kind === "text") throw mismatch("xor() cannot be applied to text");
      }
      return BOOL_DIM;
    case "eq":
    case "ne": {
      arity(2);
      unify(args[0], args[1], `${name}() arguments`);
      return BOOL_DIM;
    }
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      arity(2);
      if (args[0].kind === "text" || args[1].kind === "text" || args[0].kind === "bool" || args[1].kind === "bool") {
        throw mismatch(`${name}() cannot compare ${dimensionLabel(args[0])} and ${dimensionLabel(args[1])}`);
      }
      unify(args[0], args[1], `${name}() arguments`);
      return BOOL_DIM;
    }
    // Unit constructors: a dimensionless number of the named unit in,
    // a length (or angle) in SI out. deg() also accepts an angle-typed
    // value: a literal 180 and a degree-stored angle parameter are both
    // numbers of degrees, and deg() is the bridge from degrees to the
    // radians sin() wants. rad() stays dimensionless-only: it would
    // misread a degree-stored angle as radians.
    case "mm":
    case "cm":
    case "m":
    case "ft":
    case "in":
      arity(1);
      requireDimensionless(args[0], `${name}()`);
      return dimOf(LENGTH);
    case "deg":
      arity(1);
      requireAngleOrDimensionless(args[0], "deg()");
      return dimOf(ANGLE);
    case "rad":
      arity(1);
      requireDimensionless(args[0], "rad()");
      return dimOf(ANGLE);
    // Unit converters: a length (or angle) in SI in, a dimensionless
    // number of the named unit out. Wrong dimension is unit confusion,
    // not a plain mismatch: the value has a unit, just not this one.
    case "to_mm":
    case "to_cm":
    case "to_ft":
    case "to_in": {
      arity(1);
      const a = args[0];
      if (a.kind === "literal" || a.kind === "unknown") return dimOf(DIMENSIONLESS);
      if (a.kind === "dim" && dimsEqual(a.dim, LENGTH)) return dimOf(DIMENSIONLESS);
      throw unitConfusion(`${name}() expects a length, got ${dimensionLabel(a)}`);
    }
    case "to_deg": {
      arity(1);
      const a = args[0];
      if (a.kind === "literal" || a.kind === "unknown") return dimOf(DIMENSIONLESS);
      if (a.kind === "dim" && dimsEqual(a.dim, ANGLE)) return dimOf(DIMENSIONLESS);
      throw unitConfusion(`to_deg() expects an angle, got ${dimensionLabel(a)}`);
    }
    default:
      // Unknown functions are rejected upstream by PE-20 validation
      // (only declared builtins are allowed names); reaching here means
      // the checker was called without that validation.
      throw new Error(`Unknown function "${name}"`);
  }
}

/* -- Public entry point --------------------------------------------------- */

/**
 * Result of {@link analyseFormulaDimensions}. Deliberately a flat
 * interface, not a discriminated union: the repo's node-test harness
 * compiles these files without `--strict`, under which TS does not narrow
 * a discriminated union on `ok`, so call sites read `code` / `message` /
 * `dimension` as optional fields instead of relying on narrowing. On
 * failure `code` is always set; on success `dimension` is always set.
 */
export interface DimensionCheckResult {
  ok: boolean;
  dimension?: DimValue;
  code?: DimensionErrorCode | "syntax";
  message?: string;
}

/**
 * Statically analyse a formula body (already `=`-stripped and
 * word-operator-rewritten, exactly as the evaluator receives it) against
 * a dimension environment. Never throws: syntax problems are returned as
 * `{ ok: false, code: "syntax" }` with the parser's message, and
 * dimensional rejections as `{ ok: false, code: <DimensionErrorCode> }`.
 */
export function analyseFormulaDimensions(
  body: string,
  env: DimensionEnv,
): DimensionCheckResult {
  try {
    const ast = parse(body);
    return { ok: true, dimension: infer(ast, env) };
  } catch (err) {
    if (err instanceof DimensionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: "syntax",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check a formula's result dimension against the dimension its target
 * parameter declares. Returns a DimensionError, or null when the result
 * is acceptable. `number` / `integer` targets (and text / boolean
 * targets) are unchecked: the corpus declares section inertia (L^4) as
 * `number`, so a `number` target cannot demand dimensionlessness.
 * Literal and unknown results unify with any dimensional target.
 */
export function checkTargetDimension(
  target: FamilyParameter,
  result: DimValue,
): DimensionError | null {
  // Only dimensional targets are checked. `number` / `integer` targets
  // accept any result dimension: the corpus declares section inertia
  // (L^4) as `number`, and the golden harness declares every parameter
  // `number` — a `number` target cannot demand dimensionlessness.
  // Text / boolean targets are likewise unchecked (a comparison result
  // is stored as 1/0 on a numeric or boolean target, as before).
  if (
    target.type !== "length" &&
    target.type !== "area" &&
    target.type !== "volume" &&
    target.type !== "angle"
  ) {
    return null;
  }
  const expected = dimensionOfType(target.type);
  if (expected.kind !== "dim") return null;
  if (result.kind === "literal" || result.kind === "unknown") return null;
  if (result.kind !== "dim") {
    return mismatch(
      `formula for "${target.name}" evaluates to ${dimensionLabel(result)} ` +
        `but "${target.name}" is declared ${target.type}`,
    );
  }
  if (!dimsEqual(result.dim, expected.dim)) {
    return mismatch(
      `formula for "${target.name}" evaluates to ${dimensionLabel(result)} ` +
        `but "${target.name}" is declared ${target.type}`,
    );
  }
  return null;
}
