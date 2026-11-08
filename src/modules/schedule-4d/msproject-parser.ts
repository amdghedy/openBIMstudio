/**
 * Microsoft Project XML (MSPDI) reader. Pure TypeScript, no DOM, tolerant.
 * Summary tasks and the project-summary row (UID 0) are skipped; everything else becomes a SchedTask.
 *
 * Approximations (documented in docs/COMPATIBILITY.md):
 *  - lags are converted from tenths-of-a-minute to calendar days (24 h), not working time;
 *  - task cost is read as MSPDI stores it (hundredths of the currency unit) and divided by 100.
 */
import type { ParsedSchedule, RelType, SchedTask } from "./types";
import { DAY_MS } from "./types";
import { parseP6Date } from "./p6-parser";

const unescapeXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** First direct-ish child text of <tag>; nested blocks are removed first so `Name` of a link can't leak. */
function field(block: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(block);
  return m ? unescapeXml(m[1]).trim() : undefined;
}

/** ISO-8601 duration as MSP writes it (PT8H0M0S, P2DT4H). Returns hours. */
export function parseIsoDurationHours(s: string | undefined): number {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 24 + (+(m[2] ?? 0)) + (+(m[3] ?? 0)) / 60 + (+(m[4] ?? 0)) / 3600;
}

const MSP_LINK: Record<string, RelType> = { "0": "FF", "1": "FS", "2": "SF", "3": "SS" };

export function isMspdi(text: string): boolean {
  const head = text.slice(0, 4000);
  return /schemas\.microsoft\.com\/project/i.test(head) || (/<Project\b/.test(head) && /<Tasks>/.test(text.slice(0, 200000)) && !/APIBusinessObjects/.test(head));
}

export function parseMspdi(xml: string): ParsedSchedule {
  const warnings: string[] = [];
  const tasksXml = blocks(xml, "Task").filter((b) => /<(?:\w+:)?UID>/.test(b));
  const tasks: SchedTask[] = [];
  let skippedSummary = 0, skippedNoDate = 0;
  for (const b of tasksXml) {
    // Strip predecessor links so field() reads the task's own values.
    const own = b.replace(/<(?:\w+:)?PredecessorLink>[\s\S]*?<\/(?:\w+:)?PredecessorLink>/g, "");
    const uid = field(own, "UID");
    if (!uid || uid === "0") continue;
    if (field(own, "Summary") === "1") { skippedSummary++; continue; }
    const start = parseP6Date(field(own, "ActualStart")) ?? parseP6Date(field(own, "Start"));
    const finish = parseP6Date(field(own, "ActualFinish")) ?? parseP6Date(field(own, "Finish"));
    if (start == null || finish == null) { skippedNoDate++; continue; }
    const predecessors: SchedTask["predecessors"] = [];
    for (const l of blocks(b, "PredecessorLink")) {
      const pu = field(l, "PredecessorUID");
      if (!pu) continue;
      const lagTenthMin = Number(field(l, "LinkLag") ?? 0) || 0;
      predecessors.push({ key: pu, type: MSP_LINK[field(l, "Type") ?? "1"] ?? "FS", lagDays: lagTenthMin / 10 / 60 / 24 });
    }
    const milestone = field(own, "Milestone") === "1";
    const wbs = field(own, "WBS") ?? "";
    const cost = Number(field(own, "Cost") ?? 0);
    tasks.push({
      id: field(own, "ID") ?? uid, key: uid, name: field(own, "Name") ?? `Task ${uid}`, wbs,
      start, finish: Math.max(finish, start),
      durationDays: Math.max(0, (Math.max(finish, start) - start) / DAY_MS),
      percent: Math.max(0, Math.min(100, Number(field(own, "PercentComplete") ?? field(own, "PercentWorkComplete") ?? 0) || 0)),
      isMilestone: milestone || finish === start,
      plannedCost: Number.isFinite(cost) && cost > 0 ? cost / 100 : 0,
      predecessors,
    });
  }
  if (skippedSummary) warnings.push(`${skippedSummary} summary task(s) skipped (their children are imported).`);
  if (skippedNoDate) warnings.push(`${skippedNoDate} task(s) skipped: no start/finish date.`);
  const known = new Set(tasks.map((t) => t.key));
  let dropped = 0;
  for (const t of tasks) { const n = t.predecessors.length; t.predecessors = t.predecessors.filter((p) => known.has(p.key)); dropped += n - t.predecessors.length; }
  if (dropped) warnings.push(`${dropped} predecessor link(s) pointed at skipped tasks and were dropped.`);
  const projectName = field(xml.replace(/<(?:\w+:)?Tasks>[\s\S]*<\/(?:\w+:)?Tasks>/, ""), "Name") ?? field(xml.replace(/<(?:\w+:)?Tasks>[\s\S]*<\/(?:\w+:)?Tasks>/, ""), "Title") ?? "MS Project schedule";
  return { source: "mspdi", projectName, tasks, warnings };
}
