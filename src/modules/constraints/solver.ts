/**
 * Geometric constraint solver — numeric, damped least-squares (Levenberg-Marquardt).
 *
 * This is the parametric core that Revit is famous for: sketch or model
 * geometry constrained by dimensions and relations that survive edits.
 * When the user drags a wall, locked distances hold, parallel walls stay
 * parallel, endpoints that were joined stay joined.
 *
 * Design:
 *   - Unknowns are 2D points (x, y) flattened into one vector. All model
 *     geometry (walls in plan, family sketches, adaptive paths) reduces to
 *     constrained points.
 *   - Each constraint contributes scalar residual equations. We assemble the
 *     residual vector numerically and differentiate with central finite
 *     differences — no closed-form Jacobians per constraint type, which keeps
 *     adding new constraint types a one-function change.
 *   - The system is solved with damped least squares (L-M): gradient step
 *     blended with Gauss-Newton, damping adapted each iteration. This is the
 *     same family of solver commercial CAD kernels use for sketch solving.
 *   - Dof accounting: naive dof = 2*nPoints - nEquations; over-constrained
 *     systems are reported instead of silently mis-solving.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

/** A 2D point participating in constraints. */
export interface SolverPoint {
  /** Frozen x/y (or plan x/z) coordinates, metres. */
  x: number;
  y: number;
  /** When true the point never moves during solving (user pinned it). */
  fixed?: boolean;
}

export type ConstraintKind =
  | "coincident"
  | "distance"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal-length"
  | "angle"
  | "fixed"
  | "point-on-line"
  | "midpoint"
  | "tangent"
  | "concentric";

export interface Constraint {
  kind: ConstraintKind;
  /**
   * Point indices, meaning per kind:
   *   coincident      [a, b]
   *   distance        [a, b] + value
   *   horizontal      [a, b] (segment) or [a] (single point pinned to its own y)
   *   vertical        [a, b] or [a]
   *   parallel        [a, b, c, d]  — segment ab ∥ cd
   *   perpendicular   [a, b, c, d]  — segment ab ⊥ cd
   *   equal-length    [a, b, c, d]  — |ab| = |cd|
   *   angle           [a, b, c, d] + value (radians, ab→cd CCW)
   *   fixed           [a]
   *   point-on-line   [p, a, b]     — p on infinite line ab
   *   midpoint        [p, a, b]     — p at midpoint of ab
   *   tangent         [a, b, c] + value (fixed radius), or [a, b, c, r]
   *                     (radius = |c−r|) — line ab tangent to circle at c
   *   concentric      [c1, c2]      — two circle centres coincide
   */
  pts: number[];
  /** Metres for distance, radians for angle. */
  value?: number;
}

export interface SolveResult {
  status: "converged" | "unconverged" | "over-constrained";
  /** Solver iterations used. */
  iterations: number;
  /** Max |residual| at the final configuration. */
  maxResidual: number;
  /** Naive dof count: 2·points − fixed(2 each) − equations. */
  dof: number;
  /** Wall-clock solve time in ms (diagnostics). */
  ms: number;
}

const EPS = 1e-9;

/** Number of scalar equations a constraint contributes. */
export function equationsFor(c: Constraint): number {
  switch (c.kind) {
    case "coincident":
    case "midpoint":
    case "fixed":
      return 2;
    case "distance":
    case "horizontal":
    case "vertical":
    case "parallel":
    case "perpendicular":
    case "equal-length":
    case "angle":
    case "point-on-line":
    case "tangent":
      return 1;
    case "concentric":
      return 2;
  }
}

/** Evaluate the residual vector for the flattened point vector `v`. */
export function residuals(
  v: Float64Array,
  pts: SolverPoint[],
  cons: Constraint[],
): Float64Array {
  // Read points out of the flat vector.
  const P = pts.map((_, i) => ({ x: v[2 * i], y: v[2 * i + 1] }));
  const out: number[] = [];
  const px = (i: number) => P[i].x;
  const py = (i: number) => P[i].y;

  for (const c of cons) {
    const [a, b, cc, d] = c.pts;
    switch (c.kind) {
      case "coincident":
        out.push(px(a) - px(b), py(a) - py(b));
        break;
      case "distance": {
        const dx = px(b) - px(a);
        const dy = py(b) - py(a);
        const len = Math.hypot(dx, dy);
        // Signed residual via (len² − v²) keeps the Jacobian smooth at len=0.
        out.push(len * len - (c.value ?? 0) * (c.value ?? 0));
        break;
      }
      case "horizontal":
        if (b === undefined) out.push(0); // single-point form: no-op
        else out.push(py(a) - py(b));
        break;
      case "vertical":
        if (b === undefined) out.push(0);
        else out.push(px(a) - px(b));
        break;
      case "parallel": {
        const cross =
          (px(b) - px(a)) * (py(d) - py(cc)) -
          (py(b) - py(a)) * (px(d) - px(cc));
        // Normalise so residuals of different-length segments weigh equally.
        const n = Math.hypot(px(b) - px(a), py(b) - py(a)) *
          Math.hypot(px(d) - px(cc), py(d) - py(cc));
        out.push(n > EPS ? cross / n : 0);
        break;
      }
      case "perpendicular": {
        const dot =
          (px(b) - px(a)) * (px(d) - px(cc)) +
          (py(b) - py(a)) * (py(d) - py(cc));
        const n = Math.hypot(px(b) - px(a), py(b) - py(a)) *
          Math.hypot(px(d) - px(cc), py(d) - py(cc));
        out.push(n > EPS ? dot / n : 0);
        break;
      }
      case "equal-length": {
        const l1 = Math.hypot(px(b) - px(a), py(b) - py(a));
        const l2 = Math.hypot(px(d) - px(cc), py(d) - py(cc));
        out.push(l1 * l1 - l2 * l2);
        break;
      }
      case "angle": {
        const a1 = Math.atan2(py(b) - py(a), px(b) - px(a));
        const a2 = Math.atan2(py(d) - py(cc), px(d) - px(cc));
        let diff = a2 - a1 - (c.value ?? 0);
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        out.push(diff);
        break;
      }
      case "fixed":
        out.push(0, 0); // handled by immovable flag; keeps residual indexing stable
        break;
      case "point-on-line": {
        const abx = px(b) - px(a);
        const aby = py(b) - py(a);
        const cross = abx * (py(a) - py(cc ?? b)) - aby * (px(a) - px(cc ?? b));
        const n = Math.hypot(abx, aby);
        out.push(n > EPS ? cross / n : 0);
        break;
      }
      case "midpoint":
        out.push(px(a) - (px(b) + px(cc ?? b)) / 2, py(a) - (py(b) + py(cc ?? b)) / 2);
        break;
      case "tangent": {
        // Line ab; circle centre c; radius either fixed (`value`) or given
        // by a point r on the circle (pts[3]). Distance point-to-line via
        // the cross-product form — smooth wherever ab is non-degenerate.
        const abx = px(b) - px(a);
        const aby = py(b) - py(a);
        const n = Math.hypot(abx, aby);
        const dist = n > EPS
          ? Math.abs(abx * (py(a) - py(cc ?? b)) - aby * (px(a) - px(cc ?? b))) / n
          : 0;
        const radius = c.pts.length > 3
          ? Math.hypot(px(cc ?? b) - px(c.pts[3]), py(cc ?? b) - py(c.pts[3]))
          : (c.value ?? 0);
        out.push(dist - radius);
        break;
      }
      case "concentric":
        // Concentric = centres coincide (two scalar equations).
        out.push(px(a) - px(b ?? a), py(a) - py(b ?? a));
        break;
    }
  }
  return Float64Array.from(out);
}

/** Count scalar equations including fixed points (2 each). */
export function countEquations(pts: SolverPoint[], cons: Constraint[]): number {
  let n = pts.reduce((s, p) => s + (p.fixed ? 2 : 0), 0);
  for (const c of cons) n += equationsFor(c);
  return n;
}

/**
 * Solve the constraint system in place. `pts` are mutated to the solved
 * configuration on success; on failure they are left at the best attempt.
 */
export function solve(
  pts: SolverPoint[],
  cons: Constraint[],
  opts: { maxIterations?: number; tolerance?: number } = {},
): SolveResult {
  const t0 = now();
  const maxIt = opts.maxIterations ?? 200;
  const tol = opts.tolerance ?? 1e-10;

  const n = pts.length;
  const unknowns = 2 * n;
  const nEq = countEquations(pts, cons);
  const dof = unknowns - nEq;

  // Flatten; fixed points are simply never updated below.
  let v = Float64Array.from(pts.flatMap((p) => [p.x, p.y]));
  const movable = new Uint8Array(unknowns);
  for (let i = 0; i < n; i++) {
    if (!pts[i].fixed) {
      movable[2 * i] = 1;
      movable[2 * i + 1] = 1;
    }
  }

  // A system with no movable unknowns trivially resolves at its residual.
  let r = residuals(v, pts, cons);
  let maxR = maxAbs(r);
  if (!hasMovable(movable)) {
    return {
      status: maxR <= 1e-6 ? "converged" : "over-constrained",
      iterations: 0,
      maxResidual: maxR,
      dof,
      ms: now() - t0,
    };
  }
  if (maxR <= tol) {
    writeBack(pts, v);
    return { status: "converged", iterations: 0, maxResidual: maxR, dof, ms: now() - t0 };
  }

  const fd = 1e-7;
  let lambda = 1e-3;
  let it = 0;

  for (; it < maxIt; it++) {
    r = residuals(v, pts, cons);
    maxR = maxAbs(r);
    if (maxR <= tol) break;

    // Central-difference Jacobian (columns = movable unknowns).
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(unknowns).fill(0));
    for (let j = 0; j < unknowns; j++) {
      if (!movable[j]) continue;
      const saved = v[j];
      const step = fd * Math.max(1, Math.abs(saved));
      v[j] = saved + step;
      const rp = residuals(v, pts, cons);
      v[j] = saved - step;
      const rm = residuals(v, pts, cons);
      v[j] = saved;
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * step);
    }

    // Normal equations: A = JᵀJ + λ·diag(JᵀJ), g = Jᵀr.
    const A: number[][] = Array.from({ length: unknowns }, () => new Array(unknowns).fill(0));
    const g = new Array(unknowns).fill(0);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < unknowns; j++) {
        if (!movable[j]) continue;
        g[j] += J[i][j] * r[i];
        for (let k = j; k < unknowns; k++) {
          if (!movable[k]) continue;
          A[j][k] += J[i][j] * J[i][k];
        }
      }
    }
    for (let j = 0; j < unknowns; j++) {
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
      A[j][j] *= 1 + lambda;
      if (A[j][j] < 1e-14) A[j][j] = 1e-14; // keep singular systems solvable
    }

    const step = solveLinear(A, g, movable);
    if (!step) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }

    // Trial + backtracking: accept the first alpha that improves the residual.
    let best: Float64Array | null = null;
    let bestR = Infinity;
    let alpha = 1;
    for (let trial = 0; trial < 8; trial++) {
      const vt = Float64Array.from(v);
      for (let j = 0; j < unknowns; j++) {
        if (movable[j]) vt[j] = v[j] - alpha * step[j];
      }
      const rt = maxAbs(residuals(vt, pts, cons));
      if (rt < bestR) {
        bestR = rt;
        best = vt;
      }
      if (bestR < maxR) break;
      alpha *= 0.5;
    }
    if (best && bestR < maxR) {
      v = best;
      lambda = Math.max(lambda * 0.3, 1e-10);
      if (bestR <= tol) break;
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }

  r = residuals(v, pts, cons);
  maxR = maxAbs(r);
  writeBack(pts, v);
  const status: SolveResult["status"] =
    maxR <= Math.max(tol, 1e-8) ? "converged" : dof < 0 ? "over-constrained" : "unconverged";
  return { status, iterations: it, maxResidual: maxR, dof, ms: now() - t0 };
}

function hasMovable(m: Uint8Array): boolean {
  for (let i = 0; i < m.length; i++) if (m[i]) return true;
  return false;
}

function maxAbs(r: Float64Array): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = Math.abs(r[i]);
    if (a > s) s = a;
  }
  return s;
}

function writeBack(pts: SolverPoint[], v: Float64Array): void {
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].fixed) continue;
    pts[i].x = v[2 * i];
    pts[i].y = v[2 * i + 1];
  }
}

/** Dense symmetric solve (Gaussian elimination with partial pivoting). */
function solveLinear(A: number[][], b: number[], movable: Uint8Array): number[] | null {
  const n = A.length;
  const idx: number[] = [];
  for (let j = 0; j < n; j++) if (movable[j]) idx.push(j);
  const m = idx.length;
  if (m === 0) return [];
  // Restrict to the movable submatrix.
  const M: number[][] = idx.map((i) => idx.map((j) => A[i][j]));
  const rhs = idx.map((i) => b[i]);

  for (let col = 0; col < m; col++) {
    // Partial pivot.
    let piv = col;
    for (let r2 = col + 1; r2 < m; r2++) {
      if (Math.abs(M[r2][col]) > Math.abs(M[piv][col])) piv = r2;
    }
    if (Math.abs(M[piv][col]) < 1e-18) return null;
    if (piv !== col) {
      [M[piv], M[col]] = [M[col], M[piv]];
      [rhs[piv], rhs[col]] = [rhs[col], rhs[piv]];
    }
    for (let r2 = col + 1; r2 < m; r2++) {
      const f = M[r2][col] / M[col][col];
      if (f === 0) continue;
      for (let c2 = col; c2 < m; c2++) M[r2][c2] -= f * M[col][c2];
      rhs[r2] -= f * rhs[col];
    }
  }
  const x = new Array(m).fill(0);
  for (let r2 = m - 1; r2 >= 0; r2--) {
    let s = rhs[r2];
    for (let c2 = r2 + 1; c2 < m; c2++) s -= M[r2][c2] * x[c2];
    x[r2] = s / M[r2][r2];
  }
  const full = new Array(n).fill(0);
  idx.forEach((orig, k) => (full[orig] = x[k]));
  return full;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
