/** Stretch propagation (pure). When a duct/pipe/tray/conduit end moves, every fitting attached
 *  to that end moves with it and the other runs on that fitting follow by stretching/shrinking.
 *  Elbows also re-aim their angles at the new geometry. Nothing else in the network moves. */
import { LINEAR_MEP, linearEnds, pointTouches, type MepLike, type Pt3 } from "./connectivity";

export interface StretchUpdate { id: string; patch: Record<string, unknown> }
export interface StretchNext { start?: [number, number]; end?: [number, number]; elevation?: number; endElevation?: number }

const EPS = 1e-6;
const TWO_PI = Math.PI * 2;
const turn = (a: number, b: number) => { let d = (b - a) % TWO_PI; if (d > Math.PI) d -= TWO_PI; if (d < -Math.PI) d += TWO_PI; return d; };

export function planMepStretch(elements: MepLike[], runId: string, next: StretchNext): StretchUpdate[] {
  const run = elements.find((e) => e.id === runId);
  if (!run || !LINEAR_MEP.has(run.type) || run.properties?.pinned) return [];
  const oldEnds = linearEnds(run);
  if (!oldEnds) return [];
  const newStart = next.start ?? run.params.start!, newEnd = next.end ?? run.params.end!;
  const e0 = next.elevation ?? run.params.elevation;
  const e1 = next.endElevation ?? run.params.endElevation ?? e0;
  const newEnds: [Pt3, Pt3] = [{ x: newStart[0], y: e0, z: newStart[1] }, { x: newEnd[0], y: e1, z: newEnd[1] }];

  const patches = new Map<string, Record<string, unknown>>();
  const put = (id: string, patch: Record<string, unknown>) => patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
  const fittings = elements.filter((e) => e.type === "fitting" && e.params.point && !e.properties?.pinned);
  const runs = elements.filter((e) => LINEAR_MEP.has(e.type) && e.id !== runId && !e.properties?.pinned);
  const handled = new Set<string>();

  for (let i = 0; i < 2; i++) {
    const o = oldEnds[i], n = newEnds[i];
    const d = { x: n.x - o.x, y: n.y - o.y, z: n.z - o.z };
    if (Math.abs(d.x) < EPS && Math.abs(d.y) < EPS && Math.abs(d.z) < EPS) continue;
    const far = oldEnds[1 - i];
    for (const f of fittings) {
      if (handled.has(f.id) || !pointTouches(o, f)) continue;
      handled.add(f.id);
      const [cx, cz] = f.params.point!;
      const nc: [number, number] = [cx + d.x, cz + d.z];
      const fp: Record<string, unknown> = { point: nc, elevation: f.params.elevation + d.y };
      const isElbow = (f.params.fittingKind ?? "elbow") === "elbow";
      // angle bookkeeping for elbows: far point of the inbound / outbound run
      let farIn: [number, number] | null = null, farOut: [number, number] | null = null;
      const aIn = f.params.angleIn ?? 0, aOut = f.params.angleOut ?? Math.PI / 2;
      const classify = (F: [number, number]) => {
        const toC = Math.atan2(cz - F[1], cx - F[0]);
        const fromC = Math.atan2(F[1] - cz, F[0] - cx);
        return Math.abs(turn(toC, aIn)) <= Math.abs(turn(fromC, aOut)) ? "in" : "out";
      };
      if (isElbow) {
        if (classify([far.x, far.z]) === "in") farIn = [far.x, far.z]; else farOut = [far.x, far.z];
      }
      for (const r of runs) {
        const ends = linearEnds(r)!;
        const touching = [0, 1].filter((k) => pointTouches(ends[k], f));
        if (!touching.length) continue;
        const k = touching.length === 2
          ? (Math.hypot(ends[0].x - cx, ends[0].z - cz) <= Math.hypot(ends[1].x - cx, ends[1].z - cz) ? 0 : 1)
          : touching[0];
        const oe = ends[k], ofar = ends[1 - k];
        const ny = oe.y + d.y;
        const np: [number, number] = isElbow ? nc : [oe.x + d.x, oe.z + d.z];
        if (k === 0) put(r.id, { start: np, elevation: ny });
        else put(r.id, { end: np, endElevation: ny });
        if (isElbow) { if (classify([ofar.x, ofar.z]) === "in") farIn = [ofar.x, ofar.z]; else farOut = [ofar.x, ofar.z]; }
      }
      if (isElbow) {
        if (farIn && Math.hypot(nc[0] - farIn[0], nc[1] - farIn[1]) > EPS) fp.angleIn = Math.atan2(nc[1] - farIn[1], nc[0] - farIn[0]);
        if (farOut && Math.hypot(farOut[0] - nc[0], farOut[1] - nc[1]) > EPS) fp.angleOut = Math.atan2(farOut[1] - nc[1], farOut[0] - nc[0]);
      }
      put(f.id, fp);
    }
  }
  return [...patches].map(([id, patch]) => ({ id, patch }));
}

/**
 * Revit-style move (pure). The selected parts move rigidly; the parts attached to them FOLLOW
 * instead of the whole network being dragged: a fitting at a moved end moves with it, and the
 * other runs on that fitting stretch/shrink (their far ends stay). Equipment never follows.
 * Returns patches for the parts that did NOT move, plus angle patches for moved elbows whose
 * neighbours stayed behind. The caller translates the moved parts itself.
 */
export function planMepMove(elements: MepLike[], movedIds: Iterable<string>, dx: number, dz: number, dy = 0): StretchUpdate[] {
  const M = new Set<string>();
  for (const id of movedIds) { const e = elements.find((x) => x.id === id); if (e && !e.properties?.pinned) M.add(id); }
  if (!M.size || (Math.abs(dx) < EPS && Math.abs(dz) < EPS && Math.abs(dy) < EPS)) return [];
  const mep = elements.filter((e) => (LINEAR_MEP.has(e.type) || e.type === "fitting") && (e.params.point || e.params.start));
  const movedParts = mep.filter((e) => M.has(e.id));
  const patches = new Map<string, Record<string, unknown>>();
  const put = (id: string, patch: Record<string, unknown>) => patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
  const touchesEnd = (e: MepLike, k: number, part: MepLike) => { const ends = linearEnds(e)!; return pointTouches(ends[k], part); };

  // 1. fittings that were NOT selected but sit on a moved part follow it
  const FM = new Set<string>();
  const follow = (e: MepLike) => !M.has(e.id) && !e.properties?.pinned;
  for (const f of mep) {
    if (f.type !== "fitting" || !follow(f)) continue;
    const attached = movedParts.some((y) => {
      if (LINEAR_MEP.has(y.type)) { const ends = linearEnds(y)!; return pointTouches(ends[0], f) || pointTouches(ends[1], f); }
      return areConnectedLoose(y, f);
    });
    if (attached) { FM.add(f.id); put(f.id, { point: [f.params.point![0] + dx, f.params.point![1] + dz], elevation: f.params.elevation + dy }); }
  }
  const newCentre = (f: MepLike): [number, number] => M.has(f.id) || FM.has(f.id) ? [f.params.point![0] + dx, f.params.point![1] + dz] : f.params.point!;

  // 2. runs that stayed: the end sitting on a moved run / moved fitting is carried along
  const carriers = mep.filter((e) => M.has(e.id) || FM.has(e.id));
  const newEnd = new Map<string, { k: number; to: [number, number]; y: number }>();
  for (const r of mep) {
    if (!LINEAR_MEP.has(r.type) || !follow(r)) continue;
    const ends = linearEnds(r)!;
    for (const c of carriers) {
      if (c.id === r.id) continue;
      const touching = [0, 1].filter((k) => touchesEnd(r, k, c) || (LINEAR_MEP.has(c.type) && pointTouches(linearEnds(c)![0], r) && k === nearestEnd(ends, linearEnds(c)![0]) ) || (LINEAR_MEP.has(c.type) && pointTouches(linearEnds(c)![1], r) && k === nearestEnd(ends, linearEnds(c)![1])));
      if (!touching.length) continue;
      const cxz = c.type === "fitting" ? c.params.point! : null;
      const k = touching.length === 2 && cxz
        ? (Math.hypot(ends[0].x - cxz[0], ends[0].z - cxz[1]) <= Math.hypot(ends[1].x - cxz[0], ends[1].z - cxz[1]) ? 0 : 1)
        : touching[0];
      const oe = ends[k];
      const isElbow = c.type === "fitting" && (c.params.fittingKind ?? "elbow") === "elbow";
      const to: [number, number] = isElbow ? newCentre(c) : [oe.x + dx, oe.z + dz];
      newEnd.set(r.id, { k, to, y: oe.y + dy });
      break;
    }
  }
  for (const [id, v] of newEnd) put(id, v.k === 0 ? { start: v.to, elevation: v.y } : { end: v.to, endElevation: v.y });

  // 3. re-aim elbows (moved or following) whose runs did not all move together
  const newRunEnds = (r: MepLike): [Pt3, Pt3] => {
    const ends = linearEnds(r)!;
    const out: [Pt3, Pt3] = [{ ...ends[0] }, { ...ends[1] }];
    if (M.has(r.id)) for (const q of out) { q.x += dx; q.z += dz; q.y += dy; }
    const ne = newEnd.get(r.id);
    if (ne) { out[ne.k].x = ne.to[0]; out[ne.k].z = ne.to[1]; out[ne.k].y = ne.y; }
    return out;
  };
  for (const f of mep) {
    if (f.type !== "fitting" || (f.params.fittingKind ?? "elbow") !== "elbow" || !(M.has(f.id) || FM.has(f.id))) continue;
    const [cx, cz] = f.params.point!;
    const nc = newCentre(f);
    const aIn = f.params.angleIn ?? 0, aOut = f.params.angleOut ?? Math.PI / 2;
    let farIn: [number, number] | null = null, farOut: [number, number] | null = null;
    for (const r of mep) {
      if (!LINEAR_MEP.has(r.type)) continue;
      const ends = linearEnds(r)!;
      const t = [0, 1].filter((k) => pointTouches(ends[k], f));
      if (!t.length) continue;
      const k = t.length === 2 ? (Math.hypot(ends[0].x - cx, ends[0].z - cz) <= Math.hypot(ends[1].x - cx, ends[1].z - cz) ? 0 : 1) : t[0];
      const farOld = ends[1 - k], farNew = newRunEnds(r)[1 - k];
      const toC = Math.atan2(cz - farOld.z, cx - farOld.x), fromC = Math.atan2(farOld.z - cz, farOld.x - cx);
      if (Math.abs(turn(toC, aIn)) <= Math.abs(turn(fromC, aOut))) farIn = [farNew.x, farNew.z]; else farOut = [farNew.x, farNew.z];
    }
    const p: Record<string, unknown> = {};
    if (farIn && Math.hypot(nc[0] - farIn[0], nc[1] - farIn[1]) > EPS) { const a = Math.atan2(nc[1] - farIn[1], nc[0] - farIn[0]); if (Math.abs(turn(a, aIn)) > 1e-9) p.angleIn = a; }
    if (farOut && Math.hypot(farOut[0] - nc[0], farOut[1] - nc[1]) > EPS) { const a = Math.atan2(farOut[1] - nc[1], farOut[0] - nc[0]); if (Math.abs(turn(a, aOut)) > 1e-9) p.angleOut = a; }
    if (Object.keys(p).length) put(f.id, p);
  }
  return [...patches].map(([id, patch]) => ({ id, patch }));
}

function nearestEnd(ends: [Pt3, Pt3], pt: Pt3): number {
  return Math.hypot(ends[0].x - pt.x, ends[0].z - pt.z) <= Math.hypot(ends[1].x - pt.x, ends[1].z - pt.z) ? 0 : 1;
}
function areConnectedLoose(a: MepLike, b: MepLike): boolean {
  const pa = a.params.point, pb = b.params.point;
  return !!pa && !!pb && Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 0.25;
}
