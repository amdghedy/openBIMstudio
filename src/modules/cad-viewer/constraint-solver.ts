/**
 * Deterministic 2D geometric constraint solver (Phase 4). Pure: no DOM, no randomness, no clock.
 *
 * Unknowns are point coordinates and radii of a `Sketch`. Every constraint contributes residual equations;
 * the system is solved by damped Gauss-Newton (Levenberg-Marquardt) with central-difference Jacobians, variables
 * and constraints processed in sorted-id order, so the same input always yields the same output.
 * Diagnostics report degrees of freedom, redundant constraints and conflicting constraints.
 */

export interface SPoint { x: number; y: number }
export interface SLine { p1: string; p2: string }
export interface SCircle { c: string; r: number }
/** Arc = circle centre + radius + the two end points (also points, so tangent/coincident can use them). */
export interface SArc { c: string; r: number; p1: string; p2: string }

export interface Sketch {
  points: Record<string, SPoint>;
  lines: Record<string, SLine>;
  circles: Record<string, SCircle>;
  arcs: Record<string, SArc>;
}

export type Constraint =
  | { id: string; type: "coincident"; a: string; b: string }
  | { id: string; type: "horizontal"; line: string }
  | { id: string; type: "vertical"; line: string }
  | { id: string; type: "parallel"; a: string; b: string }
  | { id: string; type: "perpendicular"; a: string; b: string }
  | { id: string; type: "tangent"; line: string; circle: string }
  | { id: string; type: "tangentCircles"; a: string; b: string; internal?: boolean }
  | { id: string; type: "concentric"; a: string; b: string }
  | { id: string; type: "equalLength"; a: string; b: string }
  | { id: string; type: "equalRadius"; a: string; b: string }
  | { id: string; type: "symmetric"; a: string; b: string; line: string }
  | { id: string; type: "fixed"; point: string; at?: SPoint }
  | { id: string; type: "distance"; a: string; b: string; value: number }
  | { id: string; type: "length"; line: string; value: number }
  | { id: string; type: "radius"; circle: string; value: number }
  | { id: string; type: "angle"; a: string; b: string; value: number /* radians between line directions */ };

export type SolveStatus = "solved" | "underconstrained" | "overconstrained" | "conflict" | "diverged" | "invalid";

export interface SolveResult {
  status: SolveStatus;
  sketch: Sketch;
  iterations: number;
  /** Max |residual| after solving. */
  residual: number;
  /** Remaining degrees of freedom (unknowns minus independent equations); 0 = fully constrained. */
  dof: number;
  /** Constraints whose equations are implied by the others (satisfied, but add no information). */
  redundant: string[];
  /** A minimal-looking set of constraints that cannot all hold together (when status is "conflict"). */
  conflicting: string[];
  messages: string[];
}

const TOL = 1e-9;

/* ── variable packing ── */
interface Layout { names: string[]; index: Map<string, number> }

function layout(sk: Sketch): Layout {
  const names: string[] = [];
  for (const id of Object.keys(sk.points).sort()) { names.push(`p:${id}:x`, `p:${id}:y`); }
  for (const id of Object.keys(sk.circles).sort()) names.push(`c:${id}:r`);
  for (const id of Object.keys(sk.arcs).sort()) names.push(`a:${id}:r`);
  return { names, index: new Map(names.map((n, i) => [n, i])) };
}

const pack = (sk: Sketch, L: Layout): number[] => L.names.map((n) => {
  const [k, id, f] = n.split(":") as [string, string, string];
  if (k === "p") return sk.points[id]![f as "x" | "y"];
  if (k === "c") return sk.circles[id]!.r;
  return sk.arcs[id]!.r;
});

function unpack(base: Sketch, L: Layout, v: number[]): Sketch {
  const out: Sketch = { points: {}, lines: base.lines, circles: {}, arcs: {} };
  for (const id of Object.keys(base.points)) out.points[id] = { x: v[L.index.get(`p:${id}:x`)!]!, y: v[L.index.get(`p:${id}:y`)!]! };
  for (const id of Object.keys(base.circles)) out.circles[id] = { c: base.circles[id]!.c, r: v[L.index.get(`c:${id}:r`)!]! };
  for (const id of Object.keys(base.arcs)) { const a = base.arcs[id]!; out.arcs[id] = { ...a, r: v[L.index.get(`a:${id}:r`)!]! }; }
  return out;
}

/* ── residuals ── */
function validate(sk: Sketch, cs: Constraint[]): string | null {
  const seen = new Set<string>();
  for (const c of cs) {
    if (seen.has(c.id)) return `Duplicate constraint id "${c.id}".`;
    seen.add(c.id);
  }
  for (const [id, l] of Object.entries(sk.lines)) if (!sk.points[l.p1] || !sk.points[l.p2]) return `Line "${id}" references a missing point.`;
  for (const [id, ci] of Object.entries(sk.circles)) if (!sk.points[ci.c]) return `Circle "${id}" references a missing centre.`;
  for (const [id, a] of Object.entries(sk.arcs)) if (!sk.points[a.c] || !sk.points[a.p1] || !sk.points[a.p2]) return `Arc "${id}" references a missing point.`;
  const need = (kind: "points" | "lines" | "circles" | "arcs", id: string, cid: string): string | null => (sk[kind][id] ? null : `Constraint "${cid}" references missing ${kind.slice(0, -1)} "${id}".`);
  for (const c of cs) {
    let e: string | null = null;
    switch (c.type) {
      case "coincident": e = need("points", c.a, c.id) ?? need("points", c.b, c.id); break;
      case "horizontal": case "vertical": case "length": e = need("lines", c.line, c.id); break;
      case "parallel": case "perpendicular": case "equalLength": case "angle": e = need("lines", c.a, c.id) ?? need("lines", c.b, c.id); break;
      case "tangent": e = need("lines", c.line, c.id) ?? (sk.circles[c.circle] || sk.arcs[c.circle] ? null : `Constraint "${c.id}" references missing circle "${c.circle}".`); break;
      case "tangentCircles": case "concentric": case "equalRadius": e = [c.a, c.b].map((x) => (sk.circles[x] || sk.arcs[x] ? null : `Constraint "${c.id}" references missing circle "${x}".`)).find(Boolean) ?? null; break;
      case "symmetric": e = need("points", c.a, c.id) ?? need("points", c.b, c.id) ?? need("lines", c.line, c.id); break;
      case "fixed": e = need("points", c.point, c.id); break;
      case "distance": e = need("points", c.a, c.id) ?? need("points", c.b, c.id); break;
      case "radius": e = sk.circles[c.circle] || sk.arcs[c.circle] ? null : `Constraint "${c.id}" references missing circle "${c.circle}".`; break;
    }
    if (e) return e;
  }
  return null;
}

const circ = (sk: Sketch, id: string): { c: SPoint; r: number } => {
  const ci = sk.circles[id];
  if (ci) return { c: sk.points[ci.c]!, r: ci.r };
  const a = sk.arcs[id]!;
  return { c: sk.points[a.c]!, r: a.r };
};
const dir = (sk: Sketch, id: string): { x: number; y: number; len: number; p: SPoint } => {
  const l = sk.lines[id]!, a = sk.points[l.p1]!, b = sk.points[l.p2]!;
  const x = b.x - a.x, y = b.y - a.y;
  return { x, y, len: Math.hypot(x, y), p: a };
};

/** Residual equations of one constraint (each should be 0 when satisfied). `anchor` = initial positions for `fixed`. */
export function residuals(sk: Sketch, c: Constraint, anchor: Record<string, SPoint>): number[] {
  switch (c.type) {
    case "coincident": { const a = sk.points[c.a]!, b = sk.points[c.b]!; return [a.x - b.x, a.y - b.y]; }
    case "horizontal": { const d = dir(sk, c.line); return [d.y]; }
    case "vertical": { const d = dir(sk, c.line); return [d.x]; }
    case "parallel": { const a = dir(sk, c.a), b = dir(sk, c.b); return [(a.x * b.y - a.y * b.x) / Math.max(a.len * b.len, 1e-12)]; }
    case "perpendicular": { const a = dir(sk, c.a), b = dir(sk, c.b); return [(a.x * b.x + a.y * b.y) / Math.max(a.len * b.len, 1e-12)]; }
    case "tangent": {
      const d = dir(sk, c.line), k = circ(sk, c.circle);
      const dist = Math.abs(d.x * (k.c.y - d.p.y) - d.y * (k.c.x - d.p.x)) / Math.max(d.len, 1e-12);
      return [dist - Math.abs(k.r)];
    }
    case "tangentCircles": {
      const a = circ(sk, c.a), b = circ(sk, c.b);
      const dd = Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y);
      return [c.internal ? dd - Math.abs(Math.abs(a.r) - Math.abs(b.r)) : dd - (Math.abs(a.r) + Math.abs(b.r))];
    }
    case "concentric": { const a = circ(sk, c.a), b = circ(sk, c.b); return [a.c.x - b.c.x, a.c.y - b.c.y]; }
    case "equalLength": return [dir(sk, c.a).len - dir(sk, c.b).len];
    case "equalRadius": return [circ(sk, c.a).r - circ(sk, c.b).r];
    case "symmetric": {
      const a = sk.points[c.a]!, b = sk.points[c.b]!, d = dir(sk, c.line);
      const mx = (a.x + b.x) / 2 - d.p.x, my = (a.y + b.y) / 2 - d.p.y;
      const onLine = (d.x * my - d.y * mx) / Math.max(d.len, 1e-12); // midpoint lies on the axis
      const perp = ((b.x - a.x) * d.x + (b.y - a.y) * d.y) / Math.max(d.len, 1e-12); // segment ⟂ axis
      return [onLine, perp];
    }
    case "fixed": { const p = sk.points[c.point]!, t = c.at ?? anchor[c.point]!; return [p.x - t.x, p.y - t.y]; }
    case "distance": { const a = sk.points[c.a]!, b = sk.points[c.b]!; return [Math.hypot(a.x - b.x, a.y - b.y) - c.value]; }
    case "length": return [dir(sk, c.line).len - c.value];
    case "radius": return [circ(sk, c.circle).r - c.value];
    case "angle": {
      const a = dir(sk, c.a), b = dir(sk, c.b);
      const cross = a.x * b.y - a.y * b.x, dot = a.x * b.x + a.y * b.y;
      let d = Math.atan2(cross, dot) - c.value;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to (-π, π]
      return [d];
    }
  }
}

/* ── linear algebra (small dense) ── */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      if (f !== 0) for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let k = i + 1; k < n; k++) s -= M[i]![k]! * x[k]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

/** Numerical rank by Gaussian elimination with column-scaled tolerance. */
function rankOf(J: number[][], nCols: number): number {
  const M = J.map((r) => r.slice());
  let rank = 0;
  const used = new Array<boolean>(M.length).fill(false);
  for (let col = 0; col < nCols; col++) {
    let piv = -1, best = 1e-7;
    for (let r = 0; r < M.length; r++) if (!used[r] && Math.abs(M[r]![col]!) > best) { best = Math.abs(M[r]![col]!); piv = r; }
    if (piv < 0) continue;
    used[piv] = true; rank++;
    for (let r = 0; r < M.length; r++) {
      if (r === piv) continue;
      const f = M[r]![col]! / M[piv]![col]!;
      if (f !== 0) for (let k = col; k < nCols; k++) M[r]![k]! -= f * M[piv]![k]!;
    }
  }
  return rank;
}

function equations(sk: Sketch, cs: Constraint[], anchor: Record<string, SPoint>): { f: number[]; owner: number[] } {
  const f: number[] = [], owner: number[] = [];
  cs.forEach((c, ci) => { for (const r of residuals(sk, c, anchor)) { f.push(r); owner.push(ci); } });
  return { f, owner };
}

function jacobian(base: Sketch, L: Layout, v: number[], cs: Constraint[], anchor: Record<string, SPoint>): number[][] {
  const n = v.length;
  const m = equations(unpack(base, L, v), cs, anchor).f.length;
  const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(v[j]!));
    const vp = v.slice(), vm = v.slice();
    vp[j] = v[j]! + h; vm[j] = v[j]! - h;
    const fp = equations(unpack(base, L, vp), cs, anchor).f, fm = equations(unpack(base, L, vm), cs, anchor).f;
    for (let i = 0; i < m; i++) J[i]![j] = (fp[i]! - fm[i]!) / (2 * h);
  }
  return J;
}

interface Core { v: number[]; iterations: number; maxRes: number; converged: boolean }

function lm(base: Sketch, L: Layout, v0: number[], cs: Constraint[], anchor: Record<string, SPoint>, maxIter: number): Core {
  let v = v0.slice();
  let lambda = 1e-3;
  let { f } = equations(unpack(base, L, v), cs, anchor);
  let cost = f.reduce((s, x) => s + x * x, 0);
  let it = 0;
  const maxRes = (ff: number[]): number => ff.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
  while (it < maxIter && maxRes(f) > TOL) {
    it++;
    const J = jacobian(base, L, v, cs, anchor);
    const n = v.length, m = f.length;
    const JTJ: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) {
      const row = J[i]!;
      for (let a = 0; a < n; a++) {
        const ra = row[a]!;
        if (ra === 0) continue;
        g[a]! += ra * f[i]!;
        for (let b = 0; b < n; b++) JTJ[a]![b]! += ra * row[b]!;
      }
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JTJ.map((r, i) => r.map((x, j) => (i === j ? x + lambda * Math.max(x, 1e-3) : x)));
      const step = solveLinear(A, g.map((x) => -x));
      if (!step) { lambda *= 10; continue; }
      const vn = v.map((x, i) => x + step[i]!);
      const fn = equations(unpack(base, L, vn), cs, anchor).f;
      const cn = fn.reduce((s, x) => s + x * x, 0);
      if (Number.isFinite(cn) && cn < cost) { v = vn; f = fn; cost = cn; lambda = Math.max(lambda / 10, 1e-15); improved = true; break; }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { v, iterations: it, maxRes: maxRes(f), converged: maxRes(f) <= 1e-7 };
}

/**
 * Solve the sketch. `anchor` positions (for "fixed" without an explicit `at`) default to the sketch's initial
 * point positions, so fixing a point means "keep it where it is".
 */
export function solve(sketch: Sketch, constraints: Constraint[], opt: { maxIterations?: number } = {}): SolveResult {
  const msg: string[] = [];
  const bad = validate(sketch, constraints);
  if (bad) return { status: "invalid", sketch, iterations: 0, residual: NaN, dof: NaN, redundant: [], conflicting: [], messages: [bad] };
  const cs = constraints.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const anchor: Record<string, SPoint> = {};
  for (const [id, p] of Object.entries(sketch.points)) anchor[id] = { ...p };
  const L = layout(sketch);
  const v0 = pack(sketch, L);
  const core = lm(sketch, L, v0, cs, anchor, opt.maxIterations ?? 200);
  const solved = unpack(sketch, L, core.v);

  const J = jacobian(sketch, L, core.v, cs, anchor);
  const owner = equations(solved, cs, anchor).owner;
  const rank = rankOf(J, L.names.length);
  const dof = Math.max(0, L.names.length - rank);

  // Redundancy: a constraint adds no information if the rank without it is unchanged (and it is satisfied).
  const redundant: string[] = [];
  if (core.converged) {
    for (let ci = 0; ci < cs.length; ci++) {
      const rows = J.filter((_, i) => owner[i] !== ci);
      if (rankOf(rows, L.names.length) === rank) redundant.push(cs[ci]!.id);
    }
  }

  let conflicting: string[] = [];
  let status: SolveStatus;
  if (!core.converged) {
    // Find constraints whose removal lets the rest converge: those participate in the conflict.
    for (let ci = 0; ci < cs.length; ci++) {
      const rest = cs.filter((_, i) => i !== ci);
      const r = lm(sketch, L, v0, rest, anchor, opt.maxIterations ?? 200);
      if (r.converged) conflicting.push(cs[ci]!.id);
    }
    if (!conflicting.length) conflicting = cs.map((c) => c.id);
    status = Number.isFinite(core.maxRes) && core.maxRes < 1e6 ? "conflict" : "diverged";
    msg.push(`Constraints cannot all be satisfied (max residual ${core.maxRes.toExponential(2)}). Conflicting: ${conflicting.join(", ")}.`);
  } else if (redundant.length) {
    status = "overconstrained";
    msg.push(`Redundant constraints (already implied): ${redundant.join(", ")}.`);
  } else if (dof > 0) {
    status = "underconstrained";
    msg.push(`${dof} degree(s) of freedom remain.`);
  } else status = "solved";

  return { status, sketch: core.converged ? solved : sketch, iterations: core.iterations, residual: core.maxRes, dof, redundant, conflicting, messages: msg };
}

/** Largest violation of any constraint in `sketch` (0 = all satisfied). */
export function maxViolation(sketch: Sketch, constraints: Constraint[]): number {
  const anchor: Record<string, SPoint> = {};
  for (const [id, p] of Object.entries(sketch.points)) anchor[id] = { ...p };
  return equations(sketch, constraints, anchor).f.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
}

/** Stable JSON form for persistence (sorted keys, ids preserved). */
export function serializeConstraints(cs: Constraint[]): string {
  return JSON.stringify(cs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)));
}
export function parseConstraints(json: string): Constraint[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v)) throw new Error("Constraint data must be an array.");
  const types = new Set(["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "tangentCircles", "concentric", "equalLength", "equalRadius", "symmetric", "fixed", "distance", "length", "radius", "angle"]);
  for (const c of v) if (!c || typeof c !== "object" || typeof (c as Constraint).id !== "string" || !types.has((c as Constraint).type)) throw new Error("Invalid constraint record.");
  return v as Constraint[];
}
