/**
 * Elbow connection planner (pure). Works out where each MEP run must END so it meets its elbow
 * at the tangent point (T1 inlet / T2 outlet) instead of running on to the corner.
 * Direction aware (run may be drawn either way round) and idempotent.
 */
import { clampBendRadius, defaultBendRadius, elbowGeometry, tangentLength, turnAngle, type P } from "./elbow-geometry";

export interface ConnRun { id: string; type: string; start: P; end: P; elevation?: number; endElevation?: number }
export interface ConnElbow {
  id: string; parentType: string; point: P; angleIn: number; angleOut: number;
  thickness: number; height?: number; bendRadius?: number; elevation?: number;
}
export interface RunTrim { runId: string; which: "start" | "end"; to: P; elevation?: number }
export interface ElbowPlan { elbowId: string; bendRadius: number; trims: RunTrim[] }

const PERP_TOL = 0.03;
const ANGLE_TOL = 0.02;
const END_TOL = 0.002;

function dist(a: P, b: P): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
interface Cand { run: ConnRun; which: "start" | "end"; near: P; far: P; s: number; len: number }

export function planElbowConnections(elbows: ConnElbow[], runs: ConnRun[]): ElbowPlan[] {
  const plans: ElbowPlan[] = [];
  for (const f of elbows) {
    const isRound = f.parentType === "pipe" || f.parentType === "conduit";
    const width = Math.max(isRound ? f.thickness : Math.max(f.thickness, f.height ?? f.thickness), 0.05);
    const stored = Number(f.bendRadius);
    const r0 = Number.isFinite(stored) && stored > 0 ? stored : defaultBendRadius(width);
    const C = f.point;
    const uIn: P = [Math.cos(f.angleIn), Math.sin(f.angleIn)];
    const uOut: P = [Math.cos(f.angleOut), Math.sin(f.angleOut)];
    const turn = turnAngle(f.angleIn, f.angleOut);
    if (!elbowGeometry(C, f.angleIn, f.angleOut, r0)) continue;
    const window0 = Math.max(3 * tangentLength(r0, f.angleIn, f.angleOut), 0.6);

    let inc: Cand | null = null, out: Cand | null = null;
    for (const run of runs) {
      if (run.type !== f.parentType) continue;
      if (f.elevation != null) {
        const e0 = run.elevation ?? f.elevation, e1 = run.endElevation ?? e0;
        if (Math.min(Math.abs(e0 - f.elevation), Math.abs(e1 - f.elevation)) > 0.35) continue;
      }
      for (const which of ["start", "end"] as const) {
        const near = which === "start" ? run.start : run.end;
        const far = which === "start" ? run.end : run.start;
        const len = dist(near, far);
        if (len < 1e-4) continue;
        const toNear: P = [(near[0] - far[0]) / len, (near[1] - far[1]) / len];
        if (Math.abs(turnAngle(Math.atan2(toNear[1], toNear[0]), f.angleIn)) < ANGLE_TOL) {
          const perp = Math.abs((C[0] - far[0]) * uIn[1] - (C[1] - far[1]) * uIn[0]);
          const s = (near[0] - C[0]) * uIn[0] + (near[1] - C[1]) * uIn[1];
          if (perp < PERP_TOL && s <= PERP_TOL && s >= -window0 && (!inc || Math.abs(s) < Math.abs(inc.s))) inc = { run, which, near, far, s, len };
        }
        if (Math.abs(turnAngle(Math.atan2(-toNear[1], -toNear[0]), f.angleOut)) < ANGLE_TOL) {
          const perp = Math.abs((C[0] - far[0]) * uOut[1] - (C[1] - far[1]) * uOut[0]);
          const s = (near[0] - C[0]) * uOut[0] + (near[1] - C[1]) * uOut[1];
          if (perp < PERP_TOL && s >= -PERP_TOL && s <= window0 && (!out || Math.abs(s) < Math.abs(out.s))) out = { run, which, near, far, s, len };
        }
      }
    }
    if (!inc && !out) continue;

    const geo0 = elbowGeometry(C, f.angleIn, f.angleOut, r0)!;
    const off = (inc ? dist(inc.near, geo0.T1) : 0) > END_TOL || (out ? dist(out.near, geo0.T2) : 0) > END_TOL;
    const prevLen = inc ? (C[0] - inc.far[0]) * uIn[0] + (C[1] - inc.far[1]) * uIn[1] : Infinity;
    const nextLen = out ? (out.far[0] - C[0]) * uOut[0] + (out.far[1] - C[1]) * uOut[1] : Infinity;
    const r = off ? clampBendRadius(r0, turn, prevLen, nextLen) : r0;
    const eg = elbowGeometry(C, f.angleIn, f.angleOut, r);
    if (!eg) continue;

    const trims: RunTrim[] = [];
    const addTrim = (c: Cand | null, to: P) => {
      if (!c || dist(c.near, to) <= END_TOL) return;
      const run = c.run;
      let elevation: number | undefined;
      if (run.endElevation != null && run.elevation != null && Math.abs(run.endElevation - run.elevation) > 1e-9) {
        const L2 = Math.pow(dist(run.start, run.end), 2) || 1;
        const t = ((to[0] - run.start[0]) * (run.end[0] - run.start[0]) + (to[1] - run.start[1]) * (run.end[1] - run.start[1])) / L2;
        elevation = run.elevation + (run.endElevation - run.elevation) * t;
      }
      trims.push({ runId: run.id, which: c.which, to: [to[0], to[1]], elevation });
    };
    addTrim(inc, eg.T1);
    addTrim(out, eg.T2);

    const radiusChanged = !(Number.isFinite(stored) && stored > 0) || Math.abs(stored - r) > 1e-6;
    if (trims.length || radiusChanged) plans.push({ elbowId: f.id, bendRadius: Math.round(r * 1e6) / 1e6, trims });
  }
  return plans;
}