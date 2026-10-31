/**
 * Glue between the pure schedule engine (P6 parser, linking, 5D/6D curves) and the live app:
 * authored elements, the cost take-off (5D) and the 4D timeline phases.
 */
import { parseP6 } from "./p6-parser";
import { linkTasksToElements, type LinkElement, type LinkResult } from "./task-linking";
import { buildCostItems, buildCarbonItems, valueAt, total, curve, authoredQuantity, elementCarbon, type SpreadItem, type CarbonFactor } from "./curves";
import { scheduleRange, taskStatusAt } from "./schedule-model";
import type { ParsedSchedule, SchedTask } from "./types";
import { DEFAULT_PHASE_COLORS, type Phase } from "../timeline/types";
import { replacePhases, setScheduleHooks, simulationMs, setProgress, getTimelineState } from "../timeline/timeline";

interface State {
  schedule: ParsedSchedule | null;
  links: LinkResult | null;
  costItems: SpreadItem[];
  carbonItems: SpreadItem[];
  carbonOverrides: Record<string, CarbonFactor>;
  fileName: string;
}
const st: State = { schedule: null, links: null, costItems: [], carbonItems: [], carbonOverrides: {}, fileName: "" };
const listeners = new Set<() => void>();
const notify = () => { for (const f of listeners) f(); };
export const onScheduleChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getScheduleState = (): Readonly<State> => st;

const auth = (): any => (window as any).__obsAuthoring;

function linkElements(): LinkElement[] {
  const a = auth();
  const els: any[] = a?.getElements?.() ?? [];
  const lv: any[] = a?.getLevels?.() ?? [];
  return els
    .filter((e) => e.type !== "grid" && e.type !== "level" && e.type !== "room" && e.type !== "area")
    .map((e) => ({
      id: e.id, type: e.type, name: e.name,
      level: lv.find((l) => l.id === (e.levelId ?? e.params?.baseLevelId))?.name,
      activityId: e.properties?.activityId, wbs: e.properties?.wbs,
    }));
}

async function elementCostMap(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const [{ computeTakeoff }, { computeLine }] = await Promise.all([import("../cost/quantities"), import("../cost/cost")]);
    for (const row of await computeTakeoff()) {
      if (row.source === "authored" && row.key.startsWith("authored:")) out.set(row.key.slice(9), computeLine(row).lineCost);
    }
  } catch { /* cost module optional */ }
  return out;
}

function elementCarbonMap(): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of (auth()?.getElements?.() ?? []) as any[]) {
    const kg = elementCarbon(e.type, authoredQuantity(e), st.carbonOverrides);
    if (kg > 0) out.set(e.id, kg);
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Rebuild links, 5D/6D items and the 4D phases from the current schedule + model. */
export async function relinkSchedule(): Promise<void> {
  if (!st.schedule) return;
  st.links = linkTasksToElements(st.schedule.tasks, linkElements());
  st.costItems = buildCostItems(st.schedule.tasks, st.links, await elementCostMap());
  st.carbonItems = buildCarbonItems(st.schedule.tasks, st.links, elementCarbonMap());
  const phases: Phase[] = [];
  let order = 0;
  for (const t of [...st.schedule.tasks].sort((a, b) => a.start - b.start || a.finish - b.finish)) {
    const ids = st.links.byTask.get(t.id) ?? [];
    if (!ids.length) continue; // phases only for activities that drive geometry
    phases.push({
      id: `p6:${t.id}`, name: `${t.id} ${t.name}`, order: order++,
      startDate: iso(t.start), endDate: iso(Math.max(t.finish, t.start + 3_600_000)),
      color: DEFAULT_PHASE_COLORS[phases.length % DEFAULT_PHASE_COLORS.length],
      elementIds: ids, beforeMode: "hidden", afterMode: "complete",
    });
  }
  replacePhases(phases);
  notify();
}

export async function importScheduleText(text: string, fileName = ""): Promise<{ tasks: number; linked: number; warnings: string[] }> {
  const parsed = parseP6(text);
  st.schedule = parsed; st.fileName = fileName;
  await relinkSchedule();
  setProgress(0);
  return { tasks: parsed.tasks.length, linked: st.links?.byTask.size ?? 0, warnings: parsed.warnings };
}

export function setCarbonOverrides(o: Record<string, CarbonFactor>) { st.carbonOverrides = o; void relinkSchedule(); }

export interface ScheduleSummary {
  dateMs: number | null;
  tasksTotal: number; tasksDone: number; tasksActive: number;
  cost: number; costTotal: number; costSource: { p6: number; model: number };
  carbonKg: number; carbonTotalKg: number;
  costCurve: Array<{ t: number; value: number }>; carbonCurve: Array<{ t: number; value: number }>;
  range: { start: number; finish: number } | null;
  linkedTasks: number; unlinkedTasks: number;
}

export function summaryNow(): ScheduleSummary | null {
  if (!st.schedule) return null;
  const range = scheduleRange(st.schedule.tasks);
  const t = simulationMs() ?? range?.start ?? 0;
  let done = 0, active = 0;
  for (const k of st.schedule.tasks) { const s = taskStatusAt(k, t).status; if (s === "complete") done++; else if (s === "inProgress") active++; }
  const src = { p6: 0, model: 0 };
  for (const i of st.costItems) src[i.source === "p6" ? "p6" : "model"] += i.value;
  return {
    dateMs: simulationMs(), tasksTotal: st.schedule.tasks.length, tasksDone: done, tasksActive: active,
    cost: valueAt(st.costItems, t), costTotal: total(st.costItems), costSource: src,
    carbonKg: valueAt(st.carbonItems, t), carbonTotalKg: total(st.carbonItems),
    costCurve: range ? curve(st.costItems, range.start, range.finish, 40) : [],
    carbonCurve: range ? curve(st.carbonItems, range.start, range.finish, 40) : [],
    range, linkedTasks: st.links?.byTask.size ?? 0, unlinkedTasks: st.links?.unlinkedTasks.length ?? 0,
  };
}

export function setupSchedule4d() {
  setScheduleHooks({
    snapshot: () => (st.schedule ? { schedule: st.schedule, fileName: st.fileName, carbonOverrides: st.carbonOverrides } : null),
    restore: (d: any) => {
      if (!d?.schedule?.tasks) return;
      st.schedule = d.schedule as ParsedSchedule; st.fileName = d.fileName ?? ""; st.carbonOverrides = d.carbonOverrides ?? {};
      // keep the imported phases (they were saved with their element ids); only rebuild cost/carbon items
      void (async () => {
        st.links = linkTasksToElements(st.schedule!.tasks, linkElements());
        st.costItems = buildCostItems(st.schedule!.tasks, st.links, await elementCostMap());
        st.carbonItems = buildCarbonItems(st.schedule!.tasks, st.links, elementCarbonMap());
        notify();
      })();
    },
  });
}
export type { SchedTask };
