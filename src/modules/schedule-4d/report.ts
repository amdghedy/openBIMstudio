/** Per-activity 4D/5D/6D report rows and CSV export. Pure. */
import type { SchedTask } from "./types";
import type { LinkResult } from "./task-linking";
import type { SpreadItem } from "./curves";

export interface ReportRow {
  id: string; name: string; wbs: string; start: string; finish: string; percent: number;
  linkedElements: number; cost: number; costSource: string; carbonKg: number;
}

const d10 = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function reportRows(tasks: SchedTask[], links: LinkResult | null, cost: SpreadItem[], carbon: SpreadItem[]): ReportRow[] {
  const c = new Map(cost.map((i) => [i.id, i])), k = new Map(carbon.map((i) => [i.id, i]));
  return tasks.map((t) => ({
    id: t.id, name: t.name, wbs: t.wbs, start: d10(t.start), finish: d10(t.finish), percent: t.percent,
    linkedElements: links?.byTask.get(t.id)?.length ?? 0,
    cost: c.get(t.id)?.value ?? 0, costSource: c.get(t.id)?.source ?? "", carbonKg: k.get(t.id)?.value ?? 0,
  }));
}

const q = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reportCsv(rows: ReportRow[]): string {
  const head = ["Activity ID", "Name", "WBS", "Start", "Finish", "% complete", "Linked elements", "Cost (5D)", "Cost source", "Carbon kgCO2e (6D)"];
  const lines = [head.join(",")];
  for (const r of rows) lines.push([r.id, r.name, r.wbs, r.start, r.finish, r.percent, r.linkedElements, r.cost.toFixed(2), r.costSource, r.carbonKg.toFixed(1)].map(q).join(","));
  return lines.join("\r\n");
}
