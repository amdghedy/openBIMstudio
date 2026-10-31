/** Time-based queries over a parsed schedule. Pure. */
import type { SchedTask } from "./types";

export type TaskStatus = "notStarted" | "inProgress" | "complete";

export function scheduleRange(tasks: SchedTask[]): { start: number; finish: number } | null {
  if (!tasks.length) return null;
  let s = Infinity, f = -Infinity;
  for (const t of tasks) { if (t.start < s) s = t.start; if (t.finish > f) f = t.finish; }
  return { start: s, finish: f };
}

/** Planned progress of a task at time `t`: 0 before start, 1 at/after finish, linear in between. */
export function plannedFraction(task: SchedTask, t: number): number {
  if (t < task.start) return 0;
  if (t >= task.finish) return 1;
  const span = task.finish - task.start;
  return span <= 0 ? 1 : (t - task.start) / span;
}

export function taskStatusAt(task: SchedTask, t: number): { status: TaskStatus; fraction: number } {
  const fraction = plannedFraction(task, t);
  return { status: fraction <= 0 ? "notStarted" : fraction >= 1 ? "complete" : "inProgress", fraction };
}

/** Longest dependency chain (critical path by dates): tasks whose finish drives the project finish via FS links. */
export function criticalTaskIds(tasks: SchedTask[]): Set<string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const range = scheduleRange(tasks);
  const crit = new Set<string>();
  if (!range) return crit;
  const walk = (t: SchedTask, depth: number) => {
    if (depth > 500 || crit.has(t.id)) return;
    crit.add(t.id);
    let best: SchedTask | null = null;
    for (const p of t.predecessors) {
      const pt = byKey.get(p.key);
      if (pt && (!best || pt.finish > best.finish)) best = pt;
    }
    if (best) walk(best, depth + 1);
  };
  for (const t of tasks) if (t.finish === range.finish) walk(t, 0);
  return crit;
}

/** Check logic: predecessor relationships whose dates violate their type. */
export function logicViolations(tasks: SchedTask[]): Array<{ task: string; pred: string; type: string }> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out: Array<{ task: string; pred: string; type: string }> = [];
  const lagMs = (d: number) => d * 86_400_000;
  for (const t of tasks) for (const p of t.predecessors) {
    const pt = byKey.get(p.key); if (!pt) continue;
    const lag = lagMs(p.lagDays);
    const bad =
      p.type === "FS" ? t.start < pt.finish + lag - 86_400_000 :
      p.type === "SS" ? t.start < pt.start + lag - 86_400_000 :
      p.type === "FF" ? t.finish < pt.finish + lag - 86_400_000 :
      t.finish < pt.start + lag - 86_400_000;
    if (bad) out.push({ task: t.id, pred: pt.id, type: p.type });
  }
  return out;
}
