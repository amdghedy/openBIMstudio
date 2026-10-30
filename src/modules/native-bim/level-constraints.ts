/**
 * Revit-style level constraints for vertical elements (walls, columns).
 *   base elevation = baseLevel.elevation + baseOffset
 *   top            = topLevel.elevation  + topOffset   (or "Unconnected": height is a free value)
 * Pure; the authoring layer applies the result through its normal validated param path.
 */
export interface LevelRow { id: string; name: string; elevation: number }
export interface LevelConstraintParams {
  baseLevelId?: string; baseOffset?: number; topLevelId?: string; topOffset?: number;
}
export type Resolved = { ok: true; elevation: number; height: number } | { ok: false; reason: string };

export const MIN_CONSTRAINED_HEIGHT = 0.01;

export function isConstrained(p: LevelConstraintParams): boolean {
  return !!(p.baseLevelId || p.topLevelId);
}

export function resolveVertical(
  p: LevelConstraintParams, levels: LevelRow[], current: { elevation: number; height: number },
): Resolved {
  let elevation = current.elevation, height = current.height;
  if (p.baseLevelId) {
    const b = levels.find((l) => l.id === p.baseLevelId);
    if (!b) return { ok: false, reason: "base level not found" };
    elevation = b.elevation + (Number(p.baseOffset) || 0);
  }
  if (p.topLevelId) {
    const t = levels.find((l) => l.id === p.topLevelId);
    if (!t) return { ok: false, reason: "top level not found" };
    height = t.elevation + (Number(p.topOffset) || 0) - elevation;
    if (!(height >= MIN_CONSTRAINED_HEIGHT)) {
      return { ok: false, reason: `top constraint would make the height ${height.toFixed(3)} m (must be > 0)` };
    }
  }
  return { ok: true, elevation, height };
}

/** Infer the base constraint of an unconstrained element: nearest level at or below, plus offset. */
export function inferBase(elevation: number, levels: LevelRow[]): { baseLevelId: string; baseOffset: number } | null {
  const below = levels.filter((l) => l.elevation <= elevation + 0.005).sort((a, b) => b.elevation - a.elevation)[0];
  return below ? { baseLevelId: below.id, baseOffset: +(elevation - below.elevation).toFixed(6) } : null;
}

export interface ConstraintUpdate { id: string; elevation: number; height: number }

/** After levels change: the elements whose resolved elevation/height differ from what they currently have. */
export function levelChangeUpdates(
  elements: Array<{ id: string; params: LevelConstraintParams & { elevation: number; height: number } }>,
  levels: LevelRow[],
): { updates: ConstraintUpdate[]; failures: Array<{ id: string; reason: string }> } {
  const updates: ConstraintUpdate[] = [], failures: Array<{ id: string; reason: string }> = [];
  for (const e of elements) {
    if (!isConstrained(e.params)) continue;
    const r = resolveVertical(e.params, levels, { elevation: e.params.elevation, height: e.params.height });
    if (!r.ok) { failures.push({ id: e.id, reason: r.reason }); continue; }
    if (Math.abs(r.elevation - e.params.elevation) > 1e-9 || Math.abs(r.height - e.params.height) > 1e-9) {
      updates.push({ id: e.id, elevation: r.elevation, height: r.height });
    }
  }
  return { updates, failures };
}
