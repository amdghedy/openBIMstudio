/**
 * Dimensional constraint graph for parametric families.
 *
 * Supports the constraint kinds that drive most BIM family behaviour:
 *   - equality:     a = b
 *   - offset:       a = b + delta
 *   - ratio:        a = b * k
 *   - sum:          a = b + c + ...
 *   - difference:   a = b - c
 *   - fixed:        a = constant
 *   - distance:     |a - b| = d  (keeps a or b fixed based on priority)
 *
 * Solver is iterative Gauss-Seidel over a dependency-ordered constraint list.
 * Cycles that cannot be reduced produce errors rather than infinite loops.
 */

export type Constraint =
  | { kind: "equality"; a: string; b: string; priority?: number }
  | { kind: "offset"; a: string; b: string; delta: number; priority?: number }
  | { kind: "ratio"; a: string; b: string; k: number; priority?: number }
  | { kind: "sum"; a: string; terms: string[]; priority?: number }
  | { kind: "difference"; a: string; b: string; c: string; priority?: number }
  | { kind: "fixed"; a: string; value: number; priority?: number }
  | {
      kind: "distance";
      a: string;
      b: string;
      distance: number;
      /** Which variable is driven (default "a"). */
      drive?: "a" | "b";
      priority?: number;
    };

export interface ConstraintResult {
  values: Record<string, any>;
  errors: string[];
  applied: number;
  iterations: number;
}

const MAX_ITER = 32;
const TOL = 1e-9;

function num(v: any): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function applyOne(
  c: Constraint,
  values: Record<string, any>,
): boolean {
  switch (c.kind) {
    case "fixed": {
      const before = num(values[c.a]);
      values[c.a] = c.value;
      return Math.abs(before - c.value) > TOL;
    }
    case "equality": {
      const bv = num(values[c.b]);
      const before = num(values[c.a]);
      values[c.a] = bv;
      return Math.abs(before - bv) > TOL;
    }
    case "offset": {
      const target = num(values[c.b]) + c.delta;
      const before = num(values[c.a]);
      values[c.a] = target;
      return Math.abs(before - target) > TOL;
    }
    case "ratio": {
      const target = num(values[c.b]) * c.k;
      const before = num(values[c.a]);
      values[c.a] = target;
      return Math.abs(before - target) > TOL;
    }
    case "sum": {
      let total = 0;
      for (const t of c.terms) total += num(values[t]);
      const before = num(values[c.a]);
      values[c.a] = total;
      return Math.abs(before - total) > TOL;
    }
    case "difference": {
      const target = num(values[c.b]) - num(values[c.c]);
      const before = num(values[c.a]);
      values[c.a] = target;
      return Math.abs(before - target) > TOL;
    }
    case "distance": {
      const av = num(values[c.a]);
      const bv = num(values[c.b]);
      const drive = c.drive ?? "a";
      if (drive === "a") {
        // Keep sign of (a - b)
        const sign = av >= bv ? 1 : -1;
        const target = bv + sign * c.distance;
        values[c.a] = target;
        return Math.abs(av - target) > TOL;
      } else {
        const sign = bv >= av ? 1 : -1;
        const target = av + sign * c.distance;
        values[c.b] = target;
        return Math.abs(bv - target) > TOL;
      }
    }
    default:
      return false;
  }
}

/**
 * Sort constraints by priority (higher first), then stable declaration order.
 */
function sortConstraints(list: Constraint[]): Constraint[] {
  return [...list].sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));
}

/**
 * Solve a set of dimensional constraints against a mutable value map.
 * Returns a new values object; does not mutate the input.
 */
export function solveConstraints(
  seed: Record<string, any>,
  constraints: Constraint[],
): ConstraintResult {
  const values: Record<string, any> = { ...seed };
  const errors: string[] = [];
  if (!constraints.length) {
    return { values, errors, applied: 0, iterations: 0 };
  }

  const ordered = sortConstraints(constraints);
  let applied = 0;
  let iter = 0;

  for (; iter < MAX_ITER; iter++) {
    let changed = false;
    for (const c of ordered) {
      try {
        if (applyOne(c, values)) {
          changed = true;
          applied++;
        }
      } catch (err) {
        errors.push(
          `${c.kind}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!changed) break;
  }

  if (iter >= MAX_ITER) {
    errors.push("Constraint solver hit iteration limit (possible under-constrained cycle)");
  }

  return { values, errors, applied, iterations: iter + 1 };
}

/**
 * Validate that every constraint references known parameter names.
 */
export function validateConstraints(
  constraints: Constraint[],
  paramNames: Set<string>,
): string[] {
  const errors: string[] = [];
  const check = (name: string, ctx: string) => {
    if (!paramNames.has(name)) {
      errors.push(`${ctx}: unknown parameter '${name}'`);
    }
  };
  for (const c of constraints) {
    switch (c.kind) {
      case "fixed":
        check(c.a, "fixed");
        break;
      case "equality":
      case "offset":
      case "ratio":
      case "distance":
        check(c.a, c.kind);
        check(c.b, c.kind);
        break;
      case "sum":
        check(c.a, "sum");
        for (const t of c.terms) check(t, "sum");
        break;
      case "difference":
        check(c.a, "difference");
        check(c.b, "difference");
        check(c.c, "difference");
        break;
    }
  }
  return errors;
}
