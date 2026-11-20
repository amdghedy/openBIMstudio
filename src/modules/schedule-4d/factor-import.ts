/** Import / export of carbon factors (EPD values) as CSV or JSON. Pure. */
import type { CarbonFactor, FactorUnit } from "./curves";

export interface FactorImport { factors: Record<string, CarbonFactor>; errors: string[] }

/**
 * Bounds for a carbon-factor import (issue #90). Factors are small reference
 * data; a multi-MB file is a mistake or hostile, and an unbounded row count
 * would merge an unbounded override map into project state. Oversize input
 * is reported in `errors` with no factors merged — the caller (controller
 * importCarbonFactorsText) only merges when factors were produced.
 */
export const FACTORS_MAX_BYTES = 5 * 1024 * 1024;
export const FACTORS_MAX_ROWS = 50_000;

const UNITS = new Set<FactorUnit>(["m3", "m2", "m"]);
const normUnit = (u: string): FactorUnit | null => {
  const s = u.trim().toLowerCase().replace(/[²]/g, "2").replace(/[³]/g, "3").replace(/^kgco2e?\s*\/\s*/, "").replace(/^per\s+/, "");
  const x = s === "m^3" || s === "cum" ? "m3" : s === "m^2" || s === "sqm" ? "m2" : s === "lm" || s === "rm" ? "m" : s;
  return UNITS.has(x as FactorUnit) ? (x as FactorUnit) : null;
};
const key = (t: string) => t.trim().toLowerCase().replace(/^ifc/, "").replace(/\s+/g, "-");

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseFactors(text: string): FactorImport {
  const factors: Record<string, CarbonFactor> = {}, errors: string[] = [];
  if (new TextEncoder().encode(text).byteLength > FACTORS_MAX_BYTES) {
    errors.push(`Factor file exceeds the ${FACTORS_MAX_BYTES / 1024 / 1024} MB import limit.`);
    return { factors, errors };
  }
  const t = text.replace(/^﻿/, "").trim();
  const add = (type: unknown, unit: unknown, kg: unknown, note: unknown, where: string) => {
    const k = key(String(type ?? "")), u = normUnit(String(unit ?? "")), v = Number(String(kg ?? "").replace(/,/g, ""));
    if (!k) { errors.push(`${where}: missing element type`); return; }
    if (!u) { errors.push(`${where}: unit "${unit}" must be m3, m2 or m`); return; }
    if (!Number.isFinite(v) || v < 0) { errors.push(`${where}: factor "${kg}" is not a non-negative number`); return; }
    factors[k] = { unit: u, kgCO2ePerUnit: v, note: String(note ?? "imported") || "imported" };
  };
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t);
      const rows = Array.isArray(j) ? j : Object.entries<any>(j);
      if (rows.length > FACTORS_MAX_ROWS) {
        errors.push(`Factor file has more than ${FACTORS_MAX_ROWS.toLocaleString()} entries.`);
        return { factors, errors };
      }
      if (Array.isArray(j)) j.forEach((r, i) => add(r?.type, r?.unit, r?.kgCO2ePerUnit ?? r?.factor ?? r?.kg, r?.note, `item ${i + 1}`));
      else for (const [k, r] of Object.entries<any>(j)) add(k, r?.unit, r?.kgCO2ePerUnit ?? r?.factor ?? r?.kg, r?.note, `"${k}"`);
    } catch (e) { errors.push("invalid JSON: " + (e instanceof Error ? e.message : String(e))); }
    return { factors, errors };
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > FACTORS_MAX_ROWS) {
    errors.push(`Factor file has more than ${FACTORS_MAX_ROWS.toLocaleString()} rows.`);
    return { factors, errors };
  }
  lines.forEach((l, i) => {
    const c = splitCsvLine(l);
    if (i === 0 && /type|element|category/i.test(c[0]) && !Number.isFinite(Number(c[2]))) return; // header
    add(c[0], c[1], c[2], c[3], `line ${i + 1}`);
  });
  if (!Object.keys(factors).length && !errors.length) errors.push("no factor rows found");
  return { factors, errors };
}

export function factorsCsv(rows: Array<{ type: string; unit: string; kg: number; note: string }>): string {
  const q = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  return ["type,unit,kgCO2e_per_unit,note", ...rows.map((r) => [r.type, r.unit, r.kg, r.note].map(q).join(","))].join("\r\n");
}
