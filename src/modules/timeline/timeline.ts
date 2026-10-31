/**
 * 4D Construction Simulation — core engine.
 *
 * Links model elements to construction phases and drives visibility /
 * colour over a timeline. Designed as a competitive alternative to
 * Navisworks TimeLiner for openBIM federated models.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import type { Phase, TimelineState } from "./types";
import { DEFAULT_PHASE_COLORS } from "./types";

const uid = () =>
  (crypto as any).randomUUID?.() ?? `ph-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let state: TimelineState = {
  phases: [],
  progress: 0,
  playing: false,
  speed: 0.15,
};

const listeners = new Set<() => void>();
let raf = 0;
let lastTs = 0;

/** Original material / visibility snapshots so we can restore. */
const original = new Map<string, { visible: boolean; color?: number; opacity?: number }>();

function notify() {
  for (const fn of listeners) fn();
}

export function onTimelineChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTimelineState(): Readonly<TimelineState> {
  return state;
}

export function listPhases(): Phase[] {
  return state.phases.slice().sort((a, b) => a.order - b.order);
}

export function addPhase(name?: string): Phase {
  const order = state.phases.length
    ? Math.max(...state.phases.map((p) => p.order)) + 1
    : 0;
  const color = DEFAULT_PHASE_COLORS[state.phases.length % DEFAULT_PHASE_COLORS.length];
  const phase: Phase = {
    id: uid(),
    name: name ?? `Phase ${order + 1}`,
    order,
    color,
    elementIds: [],
    beforeMode: "hidden",
    afterMode: "complete",
  };
  state.phases.push(phase);
  notify();
  return phase;
}

export function updatePhase(id: string, patch: Partial<Phase>) {
  const p = state.phases.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  applyProgress(state.progress);
  notify();
}

export function removePhase(id: string) {
  state.phases = state.phases.filter((p) => p.id !== id);
  applyProgress(state.progress);
  notify();
}

export function assignSelectionToPhase(phaseId: string, ids: string[]) {
  const p = state.phases.find((x) => x.id === phaseId);
  if (!p) return;
  const set = new Set(p.elementIds);
  for (const id of ids) set.add(id);
  p.elementIds = Array.from(set);
  // Remove from other phases
  for (const other of state.phases) {
    if (other.id === phaseId) continue;
    other.elementIds = other.elementIds.filter((x) => !set.has(x));
  }
  applyProgress(state.progress);
  notify();
}

export function clearPhaseElements(phaseId: string) {
  const p = state.phases.find((x) => x.id === phaseId);
  if (!p) return;
  p.elementIds = [];
  applyProgress(state.progress);
  notify();
}

export function setProgress(t: number) {
  state.progress = Math.max(0, Math.min(1, t));
  applyProgress(state.progress);
  notify();
}

export function setPlaying(on: boolean) {
  state.playing = on;
  if (on) {
    lastTs = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  } else if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  notify();
}

export function setSpeed(s: number) {
  state.speed = Math.max(0.01, Math.min(2, s));
  notify();
}

function tick(ts: number) {
  if (!state.playing) {
    raf = 0;
    return;
  }
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  const next = state.progress + dt * state.speed;
  if (next >= 1) {
    state.progress = 1;
    state.playing = false;
    applyProgress(1);
    notify();
    raf = 0;
    return;
  }
  state.progress = next;
  applyProgress(next);
  notify();
  raf = requestAnimationFrame(tick);
}

const isoMs = (s?: string): number | null => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/** Calendar range of the timeline when EVERY phase has start+end dates (P6-driven 4D), else null. */
export function phaseDateRange(): { start: number; end: number } | null {
  const ph = state.phases;
  if (!ph.length) return null;
  let a = Infinity, b = -Infinity;
  for (const p of ph) {
    const s = isoMs(p.startDate), e = isoMs(p.endDate);
    if (s == null || e == null) return null;
    if (s < a) a = s; if (e > b) b = e;
  }
  return b > a ? { start: a, end: b } : null;
}

/** Simulated calendar date (epoch ms) at the current progress, or null in index mode. */
export function simulationMs(): number | null {
  const r = phaseDateRange();
  return r ? r.start + state.progress * (r.end - r.start) : null;
}

/** Replace all phases (used by the schedule importer). */
export function replacePhases(phases: Phase[]) {
  state.phases = phases;
  applyProgress(state.progress);
  notify();
}

/** Map progress 0..1 onto phase index (or calendar date when phases are dated) and apply visibility/colour. */
function applyProgress(t: number) {
  const phases = listPhases();
  if (!phases.length) {
    restoreAll();
    return;
  }

  const range = phaseDateRange();
  if (range) {
    const now = range.start + t * (range.end - range.start);
    for (const ph of phases) {
      const s = isoMs(ph.startDate)!, e = isoMs(ph.endDate)!;
      const mode = now < s ? ph.beforeMode : now >= e ? ph.afterMode : "active";
      for (const eid of ph.elementIds) applyElementStyle(eid, mode, ph.color);
    }
    return;
  }

  // Which phase is "current" at progress t
  const idx = Math.min(phases.length - 1, Math.floor(t * phases.length));
  const active = new Set<string>();

  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i];
    const mode =
      i < idx ? ph.afterMode :
      i === idx ? "active" :
      ph.beforeMode;

    for (const eid of ph.elementIds) {
      active.add(eid);
      applyElementStyle(eid, mode, ph.color);
    }
  }

  // Elements not in any phase stay as-is (or we could force visible)
}

function applyElementStyle(
  id: string,
  mode: "hidden" | "ghost" | "visible" | "complete" | "active",
  phaseColor: string,
) {
  const isVisible = mode !== "hidden";

  // 1. Check if it's a locally authored element
  const auth = (window as any).__obsAuthoring;
  const el = auth?.getElementById?.(id);
  if (el) {
    if (auth.setElementVisibility) auth.setElementVisibility(id, isVisible);
    return;
  }

  // 2. Fragments / imported models (format: "modelId:localId")
  const parts = id.split(":");
  if (parts.length === 2) {
    const modelId = parts[0];
    const localId = Number(parts[1]);
    if (!isNaN(localId) && ctx.hider) {
      const map = { [modelId]: new Set([localId]) };
      if (isVisible) {
        (ctx.hider as any).set(map, true);
      } else {
        (ctx.hider as any).set(map, false);
      }
    }
  }
}

function restoreAll() {
  // 1. Restore Fragments (show everything)
  if (ctx.hider) {
    if (typeof (ctx.hider as any).showAll === 'function') {
      (ctx.hider as any).showAll();
    } else if (typeof (ctx.hider as any).set === 'function') {
      (ctx.hider as any).set(true);
    }
  }

  // 2. Restore authored elements
  const auth = (window as any).__obsAuthoring;
  if (auth?.getAuthoredGroup) {
    auth.getAuthoredGroup().traverse((obj: any) => {
      obj.visible = true;
    });
  }
  
  original.clear();
}
export function resetTimeline() {
  setPlaying(false);
  state.progress = 0;
  restoreAll();
  notify();
}

export function createDefaultPhases() {
  if (state.phases.length) return;
  const names = ["Site prep", "Foundations", "Structure", "Envelope", "MEP", "Finishes"];
  names.forEach((n) => addPhase(n));
}

/** The schedule importer registers these so the timeline file also carries the imported P6 schedule. */
let scheduleHooks: { snapshot?: () => unknown; restore?: (d: unknown) => void } = {};
export function setScheduleHooks(h: typeof scheduleHooks) { scheduleHooks = h; }

export function exportTimelineJson(): string {
  return JSON.stringify({ version: 2, phases: state.phases, schedule: scheduleHooks.snapshot?.() ?? null }, null, 2);
}

export function importTimelineJson(json: string) {
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data.phases)) {
      state.phases = data.phases;
      if (data.schedule) { try { scheduleHooks.restore?.(data.schedule); } catch (e) { console.warn("[timeline] schedule restore failed", e); } }
      applyProgress(state.progress);
      notify();
    }
  } catch (e) {
    console.warn("[timeline] import failed", e);
  }
}
