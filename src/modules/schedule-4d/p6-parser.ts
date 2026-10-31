/**
 * Primavera P6 schedule readers: XER (tab-delimited export) and PMXML (XML export).
 * Pure TypeScript, no DOM, tolerant: unreadable rows are skipped and reported in `warnings`.
 */
import type { ParsedSchedule, RelType, SchedTask } from "./types";
import { DAY_MS } from "./types";

/* ───────────────────────────── helpers ───────────────────────────── */

export function parseP6Date(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isFinite(t) ? t : null;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : d;
};

function relType(s: string | undefined): RelType {
  const t = String(s ?? "").toUpperCase().replace(/^PR_/, "").replace(/[^A-Z]/g, "");
  return t === "SS" || t === "FF" || t === "SF" ? t : "FS";
}

/* ───────────────────────────── XER ───────────────────────────── */

type Row = Record<string, string>;

/** Read every table of an XER file into rows keyed by lower-case field name. */
export function readXerTables(text: string): Map<string, Row[]> {
  const tables = new Map<string, Row[]>();
  let name = "";
  let fields: string[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!raw) continue;
    const cells = raw.split("\t");
    const tag = cells[0];
    if (tag === "%T") { name = (cells[1] ?? "").trim().toUpperCase(); fields = []; if (name && !tables.has(name)) tables.set(name, []); }
    else if (tag === "%F") fields = cells.slice(1).map((f) => f.trim().toLowerCase());
    else if (tag === "%R" && name) {
      const row: Row = {};
      for (let i = 0; i < fields.length; i++) row[fields[i]] = (cells[i + 1] ?? "").trim();
      tables.get(name)!.push(row);
    }
  }
  return tables;
}

export function parseXer(text: string): ParsedSchedule {
  const warnings: string[] = [];
  const T = readXerTables(text);
  const proj = T.get("PROJECT")?.[0];
  const wbsRows = T.get("PROJWBS") ?? [];
  const wbsById = new Map(wbsRows.map((w) => [w.wbs_id, w]));
  const wbsPath = (id: string): string => {
    const parts: string[] = [];
    let cur = wbsById.get(id), guard = 0;
    while (cur && guard++ < 32) {
      if (cur.wbs_short_name) parts.unshift(cur.wbs_short_name);
      cur = cur.parent_wbs_id ? wbsById.get(cur.parent_wbs_id) : undefined;
    }
    return parts.join(".");
  };

  const cost = new Map<string, number>();
  for (const r of T.get("TASKRSRC") ?? []) {
    cost.set(r.task_id, (cost.get(r.task_id) ?? 0) + num(r.target_cost, num(r.act_reg_cost, 0)));
  }
  const preds = new Map<string, SchedTask["predecessors"]>();
  for (const r of T.get("TASKPRED") ?? []) {
    const a = preds.get(r.task_id) ?? [];
    a.push({ key: r.pred_task_id, type: relType(r.pred_type), lagDays: num(r.lag_hr_cnt) / 8 });
    preds.set(r.task_id, a);
  }

  const tasks: SchedTask[] = [];
  for (const r of T.get("TASK") ?? []) {
    const start = parseP6Date(r.act_start_date) ?? parseP6Date(r.target_start_date) ?? parseP6Date(r.early_start_date) ?? parseP6Date(r.restart_date);
    const finish = parseP6Date(r.act_end_date) ?? parseP6Date(r.target_end_date) ?? parseP6Date(r.early_end_date) ?? parseP6Date(r.reend_date);
    if (start == null || finish == null) { warnings.push(`task ${r.task_code || r.task_id}: no usable dates, skipped`); continue; }
    const type = (r.task_type || "").toUpperCase();
    const status = (r.status_code || "").toUpperCase();
    const pct = status === "TK_COMPLETE" ? 100 : Math.max(0, Math.min(100, num(r.phys_complete_pct, num(r.complete_pct, 0))));
    tasks.push({
      id: r.task_code || r.task_id, key: r.task_id, name: r.task_name || r.task_code || r.task_id,
      wbs: wbsPath(r.wbs_id), wbsName: wbsById.get(r.wbs_id)?.wbs_name,
      start, finish: Math.max(start, finish),
      durationDays: Math.max(0, (Math.max(start, finish) - start) / DAY_MS),
      percent: pct, isMilestone: /MILE/.test(type) || start === finish,
      plannedCost: cost.get(r.task_id) ?? 0, predecessors: preds.get(r.task_id) ?? [],
    });
  }
  if (!tasks.length) warnings.push("no TASK table rows found - is this a P6 .xer file?");
  return { source: "xer", projectName: proj?.proj_short_name || proj?.proj_name || "P6 project", tasks, warnings };
}

/* ───────────────────────────── PMXML ───────────────────────────── */

const blocks = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  const out: string[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};
const field = (b: string, tag: string): string | undefined => {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(b);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim() : undefined;
};

export function parsePmxml(xml: string): ParsedSchedule {
  const warnings: string[] = [];
  const wbs = new Map<string, { code: string; name: string; parent?: string }>();
  for (const b of blocks(xml, "WBS")) {
    const id = field(b, "ObjectId"); if (!id) continue;
    wbs.set(id, { code: field(b, "Code") ?? "", name: field(b, "Name") ?? "", parent: field(b, "ParentObjectId") });
  }
  const wbsPath = (id: string | undefined): string => {
    const parts: string[] = []; let cur = id ? wbs.get(id) : undefined, g = 0;
    while (cur && g++ < 32) { if (cur.code) parts.unshift(cur.code); cur = cur.parent ? wbs.get(cur.parent) : undefined; }
    return parts.join(".");
  };
  const cost = new Map<string, number>();
  for (const b of blocks(xml, "ResourceAssignment")) {
    const a = field(b, "ActivityObjectId"); if (!a) continue;
    cost.set(a, (cost.get(a) ?? 0) + num(field(b, "PlannedCost"), num(field(b, "ActualCost"), 0)));
  }
  const preds = new Map<string, SchedTask["predecessors"]>();
  for (const b of blocks(xml, "Relationship")) {
    const p = field(b, "PredecessorActivityObjectId"), s = field(b, "SuccessorActivityObjectId");
    if (!p || !s) continue;
    const a = preds.get(s) ?? []; a.push({ key: p, type: relType(field(b, "Type")), lagDays: num(field(b, "Lag")) / 8 }); preds.set(s, a);
  }
  const tasks: SchedTask[] = [];
  for (const b of blocks(xml, "Activity")) {
    const key = field(b, "ObjectId") ?? field(b, "Id") ?? "";
    const id = field(b, "Id") ?? key;
    const start = parseP6Date(field(b, "ActualStartDate")) ?? parseP6Date(field(b, "StartDate")) ?? parseP6Date(field(b, "PlannedStartDate"));
    const finish = parseP6Date(field(b, "ActualFinishDate")) ?? parseP6Date(field(b, "FinishDate")) ?? parseP6Date(field(b, "PlannedFinishDate"));
    if (start == null || finish == null) { warnings.push(`activity ${id}: no usable dates, skipped`); continue; }
    const type = (field(b, "Type") ?? "").toLowerCase();
    const w = wbs.get(field(b, "WBSObjectId") ?? "");
    const status = (field(b, "Status") ?? "").toLowerCase();
    const pct = status === "completed" ? 100 : Math.max(0, Math.min(100, num(field(b, "PhysicalPercentComplete"), num(field(b, "PercentComplete"), 0))));
    tasks.push({
      id, key, name: field(b, "Name") ?? id, wbs: wbsPath(field(b, "WBSObjectId")), wbsName: w?.name,
      start, finish: Math.max(start, finish), durationDays: Math.max(0, (Math.max(start, finish) - start) / DAY_MS),
      percent: pct, isMilestone: /milestone/.test(type) || start === finish,
      plannedCost: cost.get(key) ?? 0, predecessors: preds.get(key) ?? [],
    });
  }
  if (!tasks.length) warnings.push("no Activity elements found - is this a P6 PMXML file?");
  const projName = field(blocks(xml, "Project")[0] ?? "", "Name") ?? "P6 project";
  return { source: "pmxml", projectName: projName, tasks, warnings };
}

/** Detect the format from content and parse. */
export function parseP6(text: string): ParsedSchedule {
  const head = text.slice(0, 2000);
  if (/^\s*</.test(head) || /<(?:\w+:)?APIBusinessObjects|<(?:\w+:)?Project\b/.test(head)) return parsePmxml(text);
  return parseXer(text);
}
