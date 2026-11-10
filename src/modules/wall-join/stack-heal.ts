/**
 * Stacked (multi-level) wall join HEALING — the enforcement half of
 * `vertical-join.ts`. Detection/validation there reports gaps and overlaps
 * between vertically stacked walls (a wall rising across 4 levels = a chain
 * of 4); this module closes them.
 *
 * Tolerances (distinct roles, all metres):
 *   - vertTol (0.01): what "already perfect" means — pairs tighter than this
 *     are left alone.
 *   - scanTol (0.25): how far a boundary may be mismatched and still count as
 *     a healable stacked pair (construction-tolerance scale: one wall
 *     thickness + finishes). Mismatches beyond it are simply not a stacked
 *     join — reported as nothing, never guessed at.
 *   - planTol (0.05): shared plan endpoint, inherited from vertical-join.
 *
 * Semantics (RVT-style "heal" for stacked walls):
 *   - gap    (upper floats above lower): extend the LOWER wall's height up to
 *            the upper wall's base — the lower wall is the one that usually
 *            carries a level-based top constraint, so it grows.
 *   - overlap (upper base digs into the lower wall): shrink the LOWER wall's
 *            height down to the upper wall's base (never below MIN_HEAL_HEIGHT).
 *   - same-base walls are NEVER a stack pair (base-order guard) — two coplanar
 *            walls on one line are an overlap error, not a vertical join.
 *   - folded / reversed walls are NOT healed — reported untouched (healing a
 *            reversed wall would be guessing).
 *
 * Deterministic: pairs are processed in id order, the working copy is
 * re-scanned after every patch (bounded by maxPatches), and the result
 * carries the exact per-wall patches for the caller to apply.
 *
 * Pure module: no DOM, no THREE — safe to unit-test in Node.
 */

import { detectVerticalStacks, stackChains, validateStacks, type StackWall } from "./vertical-join";

export const MIN_HEAL_HEIGHT = 0.05; // m — matches level-constraints MIN_CONSTRAINED_HEIGHT
const DEFAULT_VERT_TOL = 0.01; // m — exact-abutment threshold (matches vertical-join)
const DEFAULT_SCAN_TOL = 0.25; // m — max boundary mismatch treated as a healable stack (wall thickness + finishes)
const DEFAULT_MAX_PATCHES = 64; // convergence guard, not a design limit

export interface StackPatch {
  id: string;
  heightBefore: number;
  heightAfter: number;
  /** Signed vertical distance that was closed (positive = gap, negative = overlap). */
  closed: number;
  reason: string;
}

export interface StackHealIssue {
  kind: string;
  lowerId: string;
  upperId: string;
  message: string;
}

export interface StackHealResult {
  patches: StackPatch[];
  remaining: StackHealIssue[];
  /** Walls rising cleanly across levels (exact-abutment chains, descending by base). */
  chains: string[][];
  pairsExamined: number;
  report: string[];
}

export interface HealOptions {
  /** Exact-abutment threshold (default 0.01 m). */
  vertTol?: number;
  planTol?: number;
  angleTol?: number;
  /** Max boundary mismatch treated as a healable stack (m). Default 0.25. */
  scanTol?: number;
  maxPatches?: number;
}

function clone(walls: StackWall[]): StackWall[] {
  return walls.map((w) => ({ ...w, start: [...w.start] as [number, number], end: [...w.end] as [number, number] }));
}

/**
 * Close all healable gaps/overlaps between stacked walls. Returns per-wall
 * height patches (cumulative — one entry per changed wall, `heightAfter` is
 * the final height) plus whatever issues could not be healed safely.
 */
export function healStacks(walls: StackWall[], opts: HealOptions = {}): StackHealResult {
  const vertTol = opts.vertTol ?? DEFAULT_VERT_TOL;
  const scanTol = Math.max(opts.scanTol ?? DEFAULT_SCAN_TOL, vertTol * 2);
  const scanOpts = { vertTol: scanTol, planTol: opts.planTol, angleTol: opts.angleTol };
  const work = clone(walls);
  const byId = new Map(work.map((w) => [w.id, w] as const));
  const patchByWall = new Map<string, StackPatch>();
  const report: string[] = [];
  let pairsExamined = 0;
  let applied = 0;

  while (applied < (opts.maxPatches ?? DEFAULT_MAX_PATCHES)) {
    const pairs = detectVerticalStacks(work, scanOpts)
      .slice()
      .sort((a, b) => (a.lowerId + a.upperId).localeCompare(b.lowerId + b.upperId));
    pairsExamined += pairs.length;
    const fixable = pairs.filter((p) => {
      if (Math.abs(p.gap) <= vertTol) return false;
      const lo = byId.get(p.lowerId);
      const up = byId.get(p.upperId);
      // Base-order guard: the "upper" wall must actually sit above the lower one.
      return !!lo && !!up && up.baseZ > lo.baseZ + vertTol;
    });
    if (!fixable.length) break;

    let changed = false;
    for (const p of fixable) {
      if (applied >= (opts.maxPatches ?? DEFAULT_MAX_PATCHES)) break;
      const lower = byId.get(p.lowerId)!;
      const prev = patchByWall.get(lower.id);
      const delta = Math.abs(p.gap);
      const before = lower.height;
      if (p.gap > 0) {
        // Upper floats — grow the lower wall up to the upper base.
        lower.height = before + p.gap;
        patchByWall.set(lower.id, {
          id: lower.id,
          heightBefore: prev?.heightBefore ?? before,
          heightAfter: lower.height,
          closed: +((prev?.closed ?? 0) + p.gap).toFixed(6),
          reason: `extended up to base of ${p.upperId}`,
        });
        report.push(`healed ${lower.id}: height ${before.toFixed(3)} → ${lower.height.toFixed(3)} m (closed ${p.gap.toFixed(3)} m gap to ${p.upperId})`);
      } else {
        // Overlap — shrink the lower wall down to the upper base.
        const target = before + p.gap; // p.gap < 0
        if (target < MIN_HEAL_HEIGHT) {
          report.push(`skipped ${p.lowerId} → ${p.upperId}: overlap ${delta.toFixed(3)} m would leave ${target.toFixed(3)} m (< ${MIN_HEAL_HEIGHT} m)`);
          continue;
        }
        lower.height = target;
        patchByWall.set(lower.id, {
          id: lower.id,
          heightBefore: prev?.heightBefore ?? before,
          heightAfter: lower.height,
          closed: +((prev?.closed ?? 0) + p.gap).toFixed(6),
          reason: `trimmed to base of ${p.upperId}`,
        });
        report.push(`healed ${lower.id}: height ${before.toFixed(3)} → ${lower.height.toFixed(3)} m (trimmed ${delta.toFixed(3)} m overlap with ${p.upperId})`);
      }
      applied++;
      changed = true;
    }
    if (!changed) break;
  }

  // Chains: only walls that now abut EXACTLY count as "rising cleanly across levels".
  const exactPairs = detectVerticalStacks(work, { vertTol, planTol: opts.planTol, angleTol: opts.angleTol });
  const healedIds = new Set<string>();
  for (const p of exactPairs) {
    healedIds.add(p.lowerId);
    healedIds.add(p.upperId);
  }
  const chains = stackChains(exactPairs)
    .map((chain) => chain.filter((id) => healedIds.has(id)))
    .filter((chain) => chain.length > 1)
    .map((chain) =>
      chain
        .slice()
        .sort((a, b) => (byId.get(a)?.baseZ ?? 0) - (byId.get(b)?.baseZ ?? 0)),
    );

  // Remaining: validate at scan tolerance so unresolved mismatches stay visible.
  const remaining = validateStacks(work, scanOpts).map((i) => ({
    kind: i.kind,
    lowerId: i.lowerId,
    upperId: i.upperId,
    message: i.message,
  }));

  return {
    patches: [...patchByWall.values()],
    remaining,
    chains,
    pairsExamined,
    report,
  };
}
