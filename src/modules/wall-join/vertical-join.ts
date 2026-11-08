/**
 * Vertical (stacked) wall joins — the horizontal counterpart in
 * `geometry/linear-join.ts` handles plan joins; this module handles walls
 * that continue vertically across level boundaries (Revit: a wall on L2
 * whose base sits on the top of the L1 wall, sharing the same plan line).
 *
 * Detected relationships:
 *   - stack pair: plan-coincident endpoint + vertically abutting spans
 *     (top of lower ≈ base of upper within tolerance);
 *   - stack chains: connected components of stack pairs (wall rising
 *     through 4 levels = chain of 4);
 *   - gap/overlap validation: a stack pair with |gap| > tol is flagged
 *     (Revit keeps the join but geometry-checker warns).
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

export interface StackWall {
  id: string;
  /** Plan start [x, z]. */
  start: [number, number];
  /** Plan end [x, z]. */
  end: [number, number];
  /** Base elevation (params.elevation). */
  baseZ: number;
  /** Wall height (params.height). */
  height: number;
  joinStatus?: string;
}

export interface StackPair {
  lowerId: string;
  upperId: string;
  /** Shared plan point. */
  at: [number, number];
  /** baseZ(upper) − top(lower); 0 for a perfect join. */
  gap: number;
  /** Collinear continuation (directions within angleTol) vs stacked offset. */
  collinear: boolean;
}

const DEFAULT_PLAN_TOL = 0.05; // m — matches endpoint snap feel
const DEFAULT_VERT_TOL = 0.01; // m — level-boundary precision
const DEFAULT_ANGLE_TOL = 2 * Math.PI / 180;

function dist2d(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function unit(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/**
 * All vertically-stacked wall pairs. A pair needs:
 *   1. a shared plan endpoint (within planTol);
 *   2. vertical abutment: baseZ(upper) ≈ top(lower) within vertTol.
 * `collinear` marks a true vertical continuation (same direction chain);
 * `false` means the walls merely touch in plan at different directions
 * (e.g. an L-corner wall whose top meets the next level's base) — still a
 * valid stack record for the checker, but not a "continuation".
 */
export function detectVerticalStacks(
  walls: StackWall[],
  opts: { planTol?: number; vertTol?: number; angleTol?: number } = {},
): StackPair[] {
  const planTol = opts.planTol ?? DEFAULT_PLAN_TOL;
  const vertTol = opts.vertTol ?? DEFAULT_VERT_TOL;
  const angleTol = opts.angleTol ?? DEFAULT_ANGLE_TOL;
  const out: StackPair[] = [];

  for (let i = 0; i < walls.length; i++) {
    const a = walls[i];
    if (a.height <= 0) continue;
    const aTop = a.baseZ + a.height;
    for (let j = 0; j < walls.length; j++) {
      if (i === j) continue;
      const b = walls[j];
      // b is the UPPER wall: its base must sit at a's top.
      if (Math.abs(b.baseZ - aTop) > vertTol) continue;
      // Shared plan endpoint within tolerance — one is enough per (a, b).
      const shared = dist2d(a.start, b.start) <= planTol
        ? a.start
        : dist2d(a.start, b.end) <= planTol
          ? a.start
          : dist2d(a.end, b.start) <= planTol
            ? a.end
            : dist2d(a.end, b.end) <= planTol
              ? a.end
              : null;
      if (!shared) continue;
      const ua = unit(a.start, a.end);
      const ub = unit(b.start, b.end);
      const cross = Math.abs(ua[0] * ub[1] - ua[1] * ub[0]);
      const dot = ua[0] * ub[0] + ua[1] * ub[1];
      const collinear = cross <= Math.sin(angleTol);
      // collinear continuation must run the SAME way (not folded back)
      const continuation = collinear && dot > 0;
      out.push({
        lowerId: a.id,
        upperId: b.id,
        at: [shared[0], shared[1]],
        gap: +(b.baseZ - aTop).toFixed(6),
        collinear: continuation,
      });
    }
  }
  return out;
}

/**
 * Connected components of stack pairs → "chains" (a wall rising across
 * 4 levels produces one chain of 4 ids). Pure union-find.
 */
export function stackChains(pairs: StackPair[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const p of pairs) {
    if (!parent.has(p.lowerId)) parent.set(p.lowerId, p.lowerId);
    if (!parent.has(p.upperId)) parent.set(p.upperId, p.upperId);
    union(p.lowerId, p.upperId);
  }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1 || pairs.some((p) => p.lowerId === g[0] || p.upperId === g[0]));
}

export interface StackIssue {
  kind: "gap" | "overlap" | "no-level-base" | "folded";
  lowerId: string;
  upperId: string;
  message: string;
}

/**
 * Validation for the model checker: non-zero gaps, vertical overlaps and
 * folded-back stacks (directions reversed — almost always a drawing error).
 */
export function validateStacks(
  walls: StackWall[],
  opts: { planTol?: number; vertTol?: number; angleTol?: number; gapTol?: number } = {},
): StackIssue[] {
  const pairs = detectVerticalStacks(walls, opts);
  const gapTol = opts.gapTol ?? DEFAULT_VERT_TOL; // reporting threshold ≠ detection tolerance
  const byId = new Map(walls.map((w) => [w.id, w] as const));
  const issues: StackIssue[] = [];
  for (const p of pairs) {
    if (Math.abs(p.gap) > gapTol) {
      issues.push({
        kind: p.gap > 0 ? "gap" : "overlap",
        lowerId: p.lowerId,
        upperId: p.upperId,
        message:
          p.gap > 0
            ? `stacked wall ${p.upperId} floats ${p.gap.toFixed(3)} m above ${p.lowerId}`
            : `stacked wall ${p.upperId} overlaps ${p.lowerId} by ${Math.abs(p.gap).toFixed(3)} m`,
      });
    }
    const upper = byId.get(p.upperId);
    const lower = byId.get(p.lowerId);
    if (upper && lower) {
      const ua = unit(lower.start, lower.end);
      const ub = unit(upper.start, upper.end);
      const cross = Math.abs(ua[0] * ub[1] - ua[1] * ub[0]);
      const dot = ua[0] * ub[0] + ua[1] * ub[1];
      if (cross <= Math.sin(opts.angleTol ?? DEFAULT_ANGLE_TOL) && dot < 0) {
        issues.push({
          kind: "folded",
          lowerId: p.lowerId,
          upperId: p.upperId,
          message: `stacked wall ${p.upperId} runs the opposite direction to ${p.lowerId} (folded join)`,
        });
      }
    }
  }
  return issues;
}
