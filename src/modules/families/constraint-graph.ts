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
    }
  | {
      /** a and b stay symmetric about centre: a + b = 2·centre. */
      kind: "symmetric";
      a: string;
      b: string;
      center: string;
      priority?: number;
    };

export interface ConstraintResult {
  values: Record<string, any>;
  errors: string[];
  applied: number;
  iterations: number;
  /** Seed parameters no constraint reads or writes (diagnostics). */
  unconstrained: string[];
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
    case "symmetric": {
      // Gauss-Seidel semantics: `a` mirrors `b` about the centre. Driving
      // BOTH sides in one constraint makes the map an involution that
      // oscillates forever, so only `a` is written; the symmetric property
      // a + b = 2·centre holds after the pass.
      const cv = num(values[c.center]);
      const bv = num(values[c.b]);
      const target = 2 * cv - bv;
      const before = num(values[c.a]);
      values[c.a] = target;
      return Math.abs(before - target) > TOL;
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

/** Variables a constraint reads (dependencies). */
function readsOf(c: Constraint): string[] {
  switch (c.kind) {
    case "fixed":
      return [];
    case "equality":
    case "offset":
    case "ratio":
      return [c.b];
    case "sum":
      return [...c.terms];
    case "difference":
      return [c.b, c.c];
    case "distance":
      return [c.a, c.b];
    case "symmetric":
      return [c.a, c.b, c.center];
  }
}

/** Variables a constraint writes (drives). */
function writesOf(c: Constraint): string[] {
  switch (c.kind) {
    case "fixed":
    case "equality":
    case "offset":
    case "ratio":
    case "sum":
    case "difference":
      return [c.a];
    case "distance":
      return [c.drive ?? "a"];
    case "symmetric":
      return [c.a, c.b];
  }
}

/**
 * Detect dependency cycles among constraint variables BEFORE solving,
 * mirroring the formula engine's cycle diagnostics. Uses Tarjan SCC over
 * read→write edges; any SCC larger than one member (or a self-loop) is a
 * cycle. Returns cycles as ordered "a → b → a" strings.
 */
export function findConstraintCycles(constraints: Constraint[]): string[] {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return; // self-loops handled by the write∩read check below
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  for (const c of constraints) {
    // A symmetric constraint is a joint mirror relation, not a sequencing
    // dependency — counting its read/write pairs as graph edges reports
    // every symmetry as a false cycle.
    if (c.kind === "symmetric") continue;
    const writes = writesOf(c);
    const reads = readsOf(c);
    for (const w of writes) {
      for (const r of reads) {
        // written var depends on read var
        if (w === r) {
          // A var both written and read by the same constraint is not a
          // cycle by itself (distance does this legitimately).
          continue;
        }
        addEdge(w, r);
      }
    }
  }

  // Tarjan SCC (iterative).
  const nodes = [...edges.keys()];
  for (const s of [...edges.values()]) nodes.push(...s);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const call: { node: string; pi: number; ei: number }[] = [
      { node: root, pi: -1, ei: 0 },
    ];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = call[call.length - 1];
      if (frame.ei === 0) {
        index.set(frame.node, counter);
        low.set(frame.node, counter);
        counter++;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const succ = [...(edges.get(frame.node) ?? [])];
      if (frame.ei < succ.length) {
        const next = succ[frame.ei];
        frame.ei++;
        if (!index.has(next)) {
          call.push({ node: next, pi: call.length - 1, ei: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
      } else {
        if (low.get(frame.node) === index.get(frame.node)) {
          const comp: string[] = [];
          let n: string;
          do {
            n = stack.pop()!;
            onStack.delete(n);
            comp.push(n);
          } while (n !== frame.node);
          if (comp.length > 1) sccs.push(comp);
        }
        if (frame.pi >= 0) {
          const parent = call[frame.pi];
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
        call.pop();
        if (!call.length) break;
      }
    }
  }

  return sccs.map((comp) => [...comp, comp[0]].join(" → "));
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
    return { values, errors, applied: 0, iterations: 0, unconstrained: Object.keys(seed) };
  }

  // Cycle pre-detection: name the parameters instead of relying on the
  // iteration-limit error, so family authors see which vars to fix.
  for (const cyc of findConstraintCycles(constraints)) {
    errors.push(`cyclic constraint dependency: ${cyc}`);
  }

  const referenced = new Set<string>();
  for (const c of constraints) {
    for (const v of writesOf(c)) referenced.add(v);
    for (const v of readsOf(c)) referenced.add(v);
  }
  const unconstrained = Object.keys(seed).filter((k) => !referenced.has(k));

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

  return { values, errors, applied, iterations: iter + 1, unconstrained };
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
      case "symmetric":
        check(c.a, "symmetric");
        check(c.b, "symmetric");
        check(c.center, "symmetric");
        break;
    }
  }
  return errors;
}
