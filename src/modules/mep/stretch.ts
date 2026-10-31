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
