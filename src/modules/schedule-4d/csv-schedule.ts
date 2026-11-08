/**
 * Plain CSV task schedule reader (Excel / Navisworks TimeLiner / hand-made exports). Pure TypeScript.
 * Recognised columns (case-insensitive, first match wins): id, name, wbs, start, finish, duration (days),
 * percent complete, cost, predecessors ("A1;A2FS+2d;A3SS-1d"), milestone.
 */
import type { ParsedSchedule, RelType, SchedTask } from "./types";
import { DAY_MS } from "./types";

export function splitCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  let q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  const delim = (Object.keys(counts) as string[]).sort((a, b) => counts[b] - counts[a])[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const HEADERS: Record<string, RegExp> = {
  id: /^(task |activity )?(id|code|no\.?|#)$|^activity id$|^task id$/i,
  name: /^(task |activity )?(name|description|title)$|^(task|activity)$/i,
  wbs: /^wbs( code| path)?$/i,
  start: /^(planned |baseline |actual )?start( date)?$|^begin$/i,
  finish: /^(planned |baseline |actual )?(finish|end)( date)?$/i,
  duration: /^duration( \(?days?\)?)?$|^days$/i,
  percent: /^(%|percent|pct)( complete| done)?$|^% ?complete$|^progress$/i,
  cost: /^(planned |budget(ed)? |total )?cost$|^budget$/i,
  pred: /^predecessors?$|^depends on$/i,
  milestone: /^milestone$/i,
};

/** Returns epoch ms or null. Ambiguous a/b/yyyy is read day-first (flagged by the caller). */
export function parseCsvDate(s: string, ambiguous?: { hit: boolean }): number | null {
  const v = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(v);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ](\d{1,2}):(\d{2}))?/.exec(v);
  if (m) {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    else if (d <= 12 && mo <= 12 && d !== mo && ambiguous) ambiguous.hit = true;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(+m[3], mo - 1, d, +(m[4] ?? 0), +(m[5] ?? 0));
  }
  return null;
}

function parsePred(s: string): Array<{ id: string; type: RelType; lagDays: number }> {
  const out: Array<{ id: string; type: RelType; lagDays: number }> = [];
  for (const part of s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.*?)(?:\s*(FS|SS|FF|SF))?(?:\s*([+-]\s*\d+(?:\.\d+)?)\s*(d|w|h)?)?$/i.exec(part);
    if (!m || !m[1].trim()) continue;
    const unit = (m[4] ?? "d").toLowerCase();
    const lag = m[3] ? Number(m[3].replace(/\s/g, "")) * (unit === "w" ? 7 : unit === "h" ? 1 / 24 : 1) : 0;
    out.push({ id: m[1].trim(), type: ((m[2] ?? "FS").toUpperCase() as RelType), lagDays: lag });
  }
  return out;
}

export function parseCsvSchedule(text: string): ParsedSchedule {
  const warnings: string[] = [];
  const rows = splitCsv(text);
  if (rows.length < 2) return { source: "csv", projectName: "CSV schedule", tasks: [], warnings: ["The file has no data rows."] };
  const head = rows[0].map((h) => h.trim());
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (const k of Object.keys(HEADERS) as Array<keyof typeof HEADERS>) {
    const i = head.findIndex((h, idx) => HEADERS[k].test(h) && !Object.values(col).includes(idx));
    if (i >= 0) col[k] = i;
  }
  if (col.name == null) return { source: "csv", projectName: "CSV schedule", tasks: [], warnings: [`No task-name column found. Headers seen: ${head.join(", ") || "(none)"}.`] };
  if (col.start == null) return { source: "csv", projectName: "CSV schedule", tasks: [], warnings: ["No start-date column found."] };
  if (col.finish == null && col.duration == null) return { source: "csv", projectName: "CSV schedule", tasks: [], warnings: ["Need a finish-date or a duration column."] };
  const amb = { hit: false };
  const tasks: SchedTask[] = [];
  const predRaw: string[] = [];
  let bad = 0;
  rows.slice(1).forEach((r, i) => {
    const g = (k: keyof typeof HEADERS) => (col[k] == null ? "" : (r[col[k]!] ?? "").trim());
    const name = g("name");
    const start = parseCsvDate(g("start"), amb);
    let finish = col.finish != null ? parseCsvDate(g("finish"), amb) : null;
    if (finish == null && col.duration != null) { const d = Number(g("duration").replace(/[^\d.\-]/g, "")); if (Number.isFinite(d) && g("duration")) finish = (start ?? NaN) + d * DAY_MS; }
    if (!name || start == null || finish == null || !Number.isFinite(finish)) { bad++; return; }
    const id = g("id") || String(i + 1);
    const cost = Number(g("cost").replace(/[^\d.\-]/g, ""));
    const pct = Number(g("percent").replace(/[^\d.\-]/g, ""));
    const ms = /^(1|y|yes|true|x)$/i.test(g("milestone"));
    const f = Math.max(finish, start);
    tasks.push({ id, key: id, name, wbs: g("wbs"), start, finish: f, durationDays: (f - start) / DAY_MS,
      percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0, isMilestone: ms || f === start,
      plannedCost: Number.isFinite(cost) && cost > 0 ? cost : 0, predecessors: [] });
    predRaw.push(g("pred"));
  });
  if (bad) warnings.push(`${bad} row(s) skipped: missing name or unreadable dates (use yyyy-mm-dd).`);
  if (amb.hit) warnings.push("Some dates looked like dd/mm/yyyy or mm/dd/yyyy; they were read day-first. Use yyyy-mm-dd to be safe.");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let unknown = 0;
  tasks.forEach((t, i) => {
    for (const p of parsePred(predRaw[i])) { if (byId.has(p.id)) t.predecessors.push({ key: p.id, type: p.type, lagDays: p.lagDays }); else unknown++; }
  });
  if (unknown) warnings.push(`${unknown} predecessor reference(s) matched no task id and were ignored.`);
  return { source: "csv", projectName: "CSV schedule", tasks, warnings };
}
