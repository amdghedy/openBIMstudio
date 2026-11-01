/** Linear-element follow (pure): walls, beams and strips that share an end point with a moved
 *  element of the same kind stay connected. Their touching end follows the move (the element
 *  stretches/shrinks, its far end stays). Moved elements are translated by the caller. */
export type Vec2 = [number, number];
export interface LinearLike {
  id: string; type: string; properties?: Record<string, unknown>;
  params: { start?: Vec2; end?: Vec2; elevation?: number; endElevation?: number };
}
export const FOLLOW_LINEAR = new Set(["wall", "beam", "strip"]);
export interface FollowUpdate { id: string; patch: Record<string, unknown> }
const TOL = 0.06; // plan distance (m) for two ends to count as joined
const TOL_Y = 0.1;

const hasElevationPerEnd = (t: string) => t === "beam"; // walls/strips have one base elevation

export function planLinearFollow(elements: LinearLike[], movedIds: Iterable<string>, dx: number, dz: number, dy = 0): FollowUpdate[] {
  const M = new Set<string>();
  for (const id of movedIds) { const e = elements.find((x) => x.id === id); if (e && !e.properties?.pinned && FOLLOW_LINEAR.has(e.type)) M.add(id); }
  if (!M.size || (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9 && Math.abs(dy) < 1e-9)) return [];
  const moved = elements.filter((e) => M.has(e.id) && e.params.start && e.params.end);
  const out = new Map<string, Record<string, unknown>>();
  for (const r of elements) {
    if (M.has(r.id) || r.properties?.pinned || !FOLLOW_LINEAR.has(r.type) || !r.params.start || !r.params.end) continue;
    const e0 = r.params.elevation ?? 0, e1 = r.params.endElevation ?? e0;
    const ends: Array<{ p: Vec2; y: number }> = [{ p: r.params.start, y: e0 }, { p: r.params.end, y: e1 }];
    const patch: Record<string, unknown> = {};
    for (let k = 0; k < 2; k++) {
      const hit = moved.some((m) => {
        if (m.type !== r.type) return false;
        const me0 = m.params.elevation ?? 0, me1 = m.params.endElevation ?? me0;
        return [[m.params.start!, me0], [m.params.end!, me1]].some(([q, y]) =>
          Math.hypot((q as Vec2)[0] - ends[k].p[0], (q as Vec2)[1] - ends[k].p[1]) <= TOL &&
          (r.type !== "beam" || Math.abs((y as number) - ends[k].y) <= TOL_Y));
      });
      if (!hit) continue;
      const np: Vec2 = [ends[k].p[0] + dx, ends[k].p[1] + dz];
      if (k === 0) { patch.start = np; if (dy && hasElevationPerEnd(r.type)) patch.elevation = e0 + dy; }
      else { patch.end = np; if (dy && hasElevationPerEnd(r.type)) patch.endElevation = e1 + dy; }
    }
    if (Object.keys(patch).length) out.set(r.id, patch);
  }
  return [...out].map(([id, patch]) => ({ id, patch }));
}
