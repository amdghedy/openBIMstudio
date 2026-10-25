/**
 * Project North / True North.
 *
 * Project north is the model's own "up" on the plan (world +Z). True north is the real compass north.
 * `trueNorthAngle` is how many degrees true north lies CLOCKWISE from project north when looking at the plan
 * (positive = the building is rotated counter-clockwise relative to the compass).
 *
 * Plan views can be shown in either orientation; the setting is saved with the project.
 */
export type PlanOrientation = "project" | "true";

export interface NorthState {
  /** Degrees clockwise from project north to true north, normalised to (-180, 180]. */
  trueNorthAngle: number;
  /** How plan views are oriented on screen. */
  planOrientation: PlanOrientation;
}

export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-9 ? 0 : Math.round(a * 1e6) / 1e6;
}

/** Clockwise screen rotation (degrees) to apply to a plan so the chosen north points up. */
export function planRotationDeg(s: NorthState): number {
  return s.planOrientation === "true" ? normalizeAngle(-s.trueNorthAngle) : 0;
}

/** Compass bearing (0..360, clockwise from true north) of a direction given as world (x, z) on the plan. */
export function bearingOfDirection(dx: number, dz: number, trueNorthAngle: number): number {
  // project-north bearing: 0 = +Z, increasing clockwise on the plan (+X to the right = 90)
  const projBearing = (Math.atan2(dx, dz) * 180) / Math.PI;
  return ((projBearing - trueNorthAngle) % 360 + 360) % 360;
}

/** Parse "12.5", "12.5 E", "12.5 W": E = true north is east of project north (clockwise), W = west. */
export function parseNorthInput(raw: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EeWw])?\s*$/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  return normalizeAngle(m[2] && /w/i.test(m[2]) ? -v : v);
}

export function formatNorthAngle(a: number): string {
  const n = normalizeAngle(a);
  if (n === 0) return "0°";
  return `${Math.abs(n).toFixed(n % 1 ? 2 : 0)}° ${n > 0 ? "E" : "W"}`;
}

const DEFAULT_STATE: NorthState = { trueNorthAngle: 0, planOrientation: "project" };
let state: NorthState = { ...DEFAULT_STATE };
const listeners = new Set<(s: NorthState) => void>();

export function getNorthState(): NorthState { return { ...state }; }
export function onNorthChanged(cb: (s: NorthState) => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }

function emit(): void {
  const snap = getNorthState();
  for (const l of listeners) { try { l(snap); } catch { /* */ } }
}

export function setNorthState(patch: Partial<NorthState>, silent = false): void {
  const next: NorthState = {
    trueNorthAngle: patch.trueNorthAngle != null ? normalizeAngle(patch.trueNorthAngle) : state.trueNorthAngle,
    planOrientation: patch.planOrientation === "true" || patch.planOrientation === "project" ? patch.planOrientation : state.planOrientation,
  };
  if (next.trueNorthAngle === state.trueNorthAngle && next.planOrientation === state.planOrientation) return;
  state = next;
  if (!silent) emit();
}

export function resetNorth(): void { state = { ...DEFAULT_STATE }; emit(); }

/** Accept whatever was stored in a project file (older files have nothing). */
export function loadNorth(raw: unknown): void {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<NorthState>;
  state = {
    trueNorthAngle: typeof r.trueNorthAngle === "number" ? normalizeAngle(r.trueNorthAngle) : 0,
    planOrientation: r.planOrientation === "true" ? "true" : "project",
  };
  emit();
}
