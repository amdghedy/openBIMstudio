/**
 * MEP joint healer: keeps every duct / pipe / cable-tray / conduit run connected to its elbow at
 * the tangent points. Idempotent, one undo step for interactive edits, silent on a fresh project,
 * and paused briefly after undo/redo so it never fights the history.
 */
import { getElements, onAuthoringChange, rebuildAuthored } from "./authoring";
import { history } from "./history";
import { planElbowConnections, type ConnElbow, type ConnRun, type ElbowPlan } from "../modules/mep/elbow-connect";

const MEP = new Set(["duct", "pipe", "cable-tray", "conduit"]);
let installed = false;
let timer: number | null = null;
let pausedUntil = 0;
let busy = false;

type Snap = { id: string; start?: [number, number]; end?: [number, number]; elevation?: number; endElevation?: number; bendRadius?: number | undefined };

export function healMepElbows(): number {
  if (busy) return 0;
  const els = getElements();
  const elbows: ConnElbow[] = [];
  const runs: ConnRun[] = [];
  for (const e of els) {
    const p: any = e.params;
    if (e.type === "fitting") {
      const kind = String(p.fittingKind ?? "elbow");
      const parent = String(p.parentType ?? "duct");
      if (kind === "elbow" && MEP.has(parent) && p.point) {
        elbows.push({
          id: e.id, parentType: parent, point: [p.point[0], p.point[1]],
          angleIn: Number(p.angleIn ?? 0), angleOut: Number(p.angleOut ?? Math.PI / 2),
          thickness: Number(p.thickness ?? 0.3), height: Number(p.height ?? p.thickness ?? 0.3),
          bendRadius: p.bendRadius, elevation: p.elevation,
        });
      }
    } else if (MEP.has(e.type) && p.start && p.end) {
      runs.push({ id: e.id, type: e.type, start: [p.start[0], p.start[1]], end: [p.end[0], p.end[1]], elevation: p.elevation, endElevation: p.endElevation });
    }
  }
  if (!elbows.length || !runs.length) return 0;
  const plans: ElbowPlan[] = planElbowConnections(elbows, runs);
  if (!plans.length) return 0;

  const byId = new Map(els.map((e) => [e.id, e]));
  const before = new Map<string, Snap>();
  const after = new Map<string, Snap>();
  const snap = (id: string): Snap | null => {
    const e: any = byId.get(id);
    if (!e) return null;
    return {
      id, start: e.params.start ? [...e.params.start] : undefined, end: e.params.end ? [...e.params.end] : undefined,
      elevation: e.params.elevation, endElevation: e.params.endElevation, bendRadius: e.params.bendRadius,
    };
  };
  for (const pl of plans) {
    for (const id of [pl.elbowId, ...pl.trims.map((t) => t.runId)]) {
      if (before.has(id)) continue;
      const s = snap(id);
      if (s) before.set(id, s);
    }
  }
  const apply = (s: Snap) => {
    const e: any = byId.get(s.id);
    if (!e) return;
    if (s.start) e.params.start = [...s.start];
    if (s.end) e.params.end = [...s.end];
    if (s.elevation !== undefined) e.params.elevation = s.elevation;
    if (s.endElevation !== undefined) e.params.endElevation = s.endElevation;
    if (e.type === "fitting") e.params.bendRadius = s.bendRadius;
  };

  busy = true;
  try {
    for (const pl of plans) {
      const f: any = byId.get(pl.elbowId);
      if (f) f.params.bendRadius = pl.bendRadius;
      for (const t of pl.trims) {
        const run: any = byId.get(t.runId);
        if (!run) continue;
        if (t.which === "end") { run.params.end = [t.to[0], t.to[1]]; if (t.elevation != null) run.params.endElevation = t.elevation; }
        else { run.params.start = [t.to[0], t.to[1]]; if (t.elevation != null) run.params.elevation = t.elevation; }
      }
    }
    for (const id of before.keys()) { const s = snap(id); if (s) after.set(id, s); }
    if (history.depth().undo > 0) {
      history.push({
        label: "Connect MEP elbows",
        apply: () => { for (const s of after.values()) apply(s); rebuildAuthored(); },
        revert: () => { for (const s of before.values()) apply(s); rebuildAuthored(); },
      });
    }
    rebuildAuthored();
  } finally {
    busy = false;
  }
  return plans.length;
}

function schedule(): void {
  if (busy || Date.now() < pausedUntil) return;
  if (timer != null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    if (Date.now() < pausedUntil) return;
    try { healMepElbows(); } catch (e) { console.warn("[mep-joint-healer] failed", e); }
  }, 30);
}

export function setupMepJointHealer(): void {
  if (installed) return;
  installed = true;
  onAuthoringChange(schedule);
  window.addEventListener("obs-history", () => { pausedUntil = Date.now() + 400; });
  (window as any).__obsHealMepElbows = healMepElbows;
  schedule();
}