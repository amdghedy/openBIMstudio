/**
 * Declarative (JSON) standards packs: data only, never code, so a regional expert can contribute a rule set
 * without TypeScript and a pack file cannot run anything on the user's machine.
 *
 * Format "openbimstudio-standards-pack" v1, documented in docs/STANDARDS-PACK-SCHEMA.md and
 * docs/schemas/standards-pack.schema.json. The schema file is for editors/contributors; validation at run time is
 * done by validatePackJson() below (no ajv dependency, see the doc for why).
 */
import { firstProp, firstPropNumber, firstPropString } from "../framework";
import type { Rule, RuleCheckResult, RulePack, Severity } from "./types";

export const PACK_FORMAT = "openbimstudio-standards-pack";
export const PACK_FORMAT_VERSION = 1;
const MAX_RULES = 2000, MAX_DEPTH = 6, MAX_TEXT = 1000, MAX_REGEX = 200, MAX_SUBJECT = 2000;

export type NumOp = "gte" | "gt" | "lte" | "lt" | "eq" | "ne";
export type StrOp = "equals" | "notEquals" | "contains" | "notContains" | "matches" | "in";
export type Unit = "m" | "cm" | "mm" | "ft" | "in";
export type Condition =
  | { property: string | string[]; op: NumOp; value: number; unit?: Unit }
  | { property: string | string[]; op: "between"; value: [number, number]; unit?: Unit }
  | { property: string | string[]; op: StrOp; value: string | string[] }
  | { property: string | string[]; op: "exists" | "notExists" }
  | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export interface JsonRule {
  id: string; name: string; description?: string; standard?: string; jurisdiction?: string;
  severity: Severity; category?: string; appliesTo?: string[];
  /** Rule only applies to elements matching this; non-matching elements pass. */
  when?: Condition;
  /** What a compliant element satisfies. */
  require: Condition;
  /** Text for a violation. {actual} and {required} are replaced. */
  message?: string;
  /** What to do when the property is not recorded: "pass" (default), "info" or "fail". */
  missing?: "pass" | "info" | "fail";
}
export interface JsonPack { format: typeof PACK_FORMAT; formatVersion: 1; id: string; name: string; description: string; version: string; jurisdiction?: string; rules: JsonRule[] }

type Leaf = { property: string | string[]; op: string; value?: any; unit?: Unit };
const TO_M: Record<Unit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
const NUM_OPS = new Set(["gte", "gt", "lte", "lt", "eq", "ne"]);
const STR_OPS = new Set(["equals", "notEquals", "contains", "notContains", "matches", "in"]);

/* ───────────── validation ───────────── */

const isStr = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function checkCondition(c: unknown, path: string, errors: string[], depth: number): void {
  if (depth > MAX_DEPTH) { errors.push(`${path}: conditions are nested deeper than ${MAX_DEPTH}`); return; }
  if (!isObj(c)) { errors.push(`${path}: must be an object`); return; }
  if ("all" in c || "any" in c) {
    const key = "all" in c ? "all" : "any";
    const list = c[key];
    if (!Array.isArray(list) || !list.length || list.length > 50) { errors.push(`${path}.${key}: needs 1–50 conditions`); return; }
    list.forEach((x, i) => checkCondition(x, `${path}.${key}[${i}]`, errors, depth + 1));
    return;
  }
  if ("not" in c) { checkCondition(c.not, `${path}.not`, errors, depth + 1); return; }
  const prop = c.property;
  if (!(isStr(prop, 200) || (Array.isArray(prop) && prop.length > 0 && prop.length <= 20 && prop.every((p) => isStr(p, 200))))) errors.push(`${path}.property: a property name or a list of 1–20 names`);
  const op = c.op;
  if (op === "exists" || op === "notExists") return;
  if (typeof op === "string" && NUM_OPS.has(op)) {
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) errors.push(`${path}.value: must be a finite number for "${op}"`);
  } else if (op === "between") {
    const v = c.value;
    if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "number" || !Number.isFinite(x)) || (v[0] as number) > (v[1] as number)) errors.push(`${path}.value: must be [min, max] numbers with min <= max`);
  } else if (typeof op === "string" && STR_OPS.has(op)) {
    if (op === "in") { if (!Array.isArray(c.value) || !c.value.length || c.value.length > 200 || !c.value.every((x) => isStr(x, 200))) errors.push(`${path}.value: must be a list of 1–200 strings for "in"`); }
    else if (!isStr(c.value, op === "matches" ? MAX_REGEX : 200)) errors.push(`${path}.value: must be a non-empty string${op === "matches" ? ` of at most ${MAX_REGEX} characters` : ""}`);
    else if (op === "matches") {
      try { new RegExp(c.value as string, "i"); } catch { errors.push(`${path}.value: not a valid regular expression`); }
      // Catastrophic-backtracking guard: a quantified group that itself contains a quantifier, e.g. (a+)+ or (a*)*.
      if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(c.value as string)) errors.push(`${path}.value: nested quantifiers such as (a+)+ are not allowed`);
    }
  } else errors.push(`${path}.op: unknown operator ${JSON.stringify(op)}`);
  if (c.unit !== undefined && !(typeof c.unit === "string" && c.unit in TO_M)) errors.push(`${path}.unit: one of ${Object.keys(TO_M).join(", ")}`);
}

export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }

export function validatePackJson(input: unknown): ValidationResult {
  const errors: string[] = [], warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["The file must contain a JSON object."], warnings };
  if (input.format !== PACK_FORMAT) errors.push(`format: must be "${PACK_FORMAT}"`);
  if (input.formatVersion !== PACK_FORMAT_VERSION) errors.push(`formatVersion: this version reads ${PACK_FORMAT_VERSION}, the file says ${JSON.stringify(input.formatVersion)}`);
  for (const k of ["id", "name", "description", "version"] as const) if (!isStr(input[k], k === "description" ? 4000 : 200)) errors.push(`${k}: required text`);
  if (isStr(input.id, 200) && !/^[a-z0-9][a-z0-9._-]*$/i.test(input.id)) errors.push("id: letters, digits, dot, dash and underscore only");
  if (!Array.isArray(input.rules) || !input.rules.length) errors.push("rules: at least one rule is required");
  else if (input.rules.length > MAX_RULES) errors.push(`rules: at most ${MAX_RULES}`);
  else {
    const ids = new Set<string>();
    input.rules.forEach((r, i) => {
      const p = `rules[${i}]`;
      if (!isObj(r)) { errors.push(`${p}: must be an object`); return; }
      if (!isStr(r.id, 200)) errors.push(`${p}.id: required text`); else if (ids.has(r.id)) errors.push(`${p}.id: duplicate "${r.id}"`); else ids.add(r.id);
      if (!isStr(r.name, 300)) errors.push(`${p}.name: required text`);
      if (!(r.severity === "info" || r.severity === "warning" || r.severity === "error")) errors.push(`${p}.severity: "info", "warning" or "error"`);
      if (r.appliesTo !== undefined && !(Array.isArray(r.appliesTo) && r.appliesTo.length <= 100 && r.appliesTo.every((x) => isStr(x, 100)))) errors.push(`${p}.appliesTo: list of IFC class names`);
      else if (r.appliesTo === undefined) warnings.push(`${p}: no appliesTo, so it is evaluated on every element`);
      if (r.missing !== undefined && !(r.missing === "pass" || r.missing === "info" || r.missing === "fail")) errors.push(`${p}.missing: "pass", "info" or "fail"`);
      for (const k of ["description", "standard", "jurisdiction", "category", "message"] as const) if (r[k] !== undefined && !isStr(r[k], MAX_TEXT)) errors.push(`${p}.${k}: text up to ${MAX_TEXT} characters`);
      if (r.when !== undefined) checkCondition(r.when, `${p}.when`, errors, 0);
      if (r.require === undefined) errors.push(`${p}.require: required`); else checkCondition(r.require, `${p}.require`, errors, 0);
    });
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 50), warnings: warnings.slice(0, 20) };
}

/* ───────────── evaluation ───────────── */

/** true = satisfied, false = violated, undefined = the property is not recorded. */
export function evalCondition(c: Condition, props: Record<string, any> | undefined): boolean | undefined {
  if ("all" in c) { let unknown = false; for (const x of c.all) { const r = evalCondition(x, props); if (r === false) return false; if (r === undefined) unknown = true; } return unknown ? undefined : true; }
  if ("any" in c) { let unknown = false; for (const x of c.any) { const r = evalCondition(x, props); if (r === true) return true; if (r === undefined) unknown = true; } return unknown ? undefined : false; }
  if ("not" in c) { const r = evalCondition(c.not, props); return r === undefined ? undefined : !r; }
  const l = c as Leaf;
  const keys = Array.isArray(l.property) ? l.property : [l.property];
  if (l.op === "exists") return firstProp(props, keys) !== undefined;
  if (l.op === "notExists") return firstProp(props, keys) === undefined;
  if (l.op === "between" || NUM_OPS.has(l.op)) {
    const n = firstPropNumber(props, keys);
    if (n === undefined) return undefined;
    const k = TO_M[l.unit ?? "m"] ?? 1;
    // The unit converts the threshold to metres; a property recorded without a unit suffix is compared as-is.
    if (l.op === "between") { const [a, b] = l.value as [number, number]; return n >= a * k - 1e-9 && n <= b * k + 1e-9; }
    const v = (l.value as number) * (l.unit ? k : 1);
    switch (l.op) { case "gte": return n >= v - 1e-9; case "gt": return n > v; case "lte": return n <= v + 1e-9; case "lt": return n < v; case "eq": return Math.abs(n - v) < 1e-9; default: return Math.abs(n - v) >= 1e-9; }
  }
  const s = firstPropString(props, keys);
  if (s === undefined) return undefined;
  const subj = s.slice(0, MAX_SUBJECT).toLowerCase();
  switch (l.op) {
    case "equals": return subj === (l.value as string).toLowerCase();
    case "notEquals": return subj !== (l.value as string).toLowerCase();
    case "contains": return subj.includes((l.value as string).toLowerCase());
    case "notContains": return !subj.includes((l.value as string).toLowerCase());
    case "in": return (l.value as string[]).some((x) => x.toLowerCase() === subj);
    case "matches": try { return new RegExp(l.value as string, "i").test(subj); } catch { return undefined; }
  }
  return undefined;
}

function describe(c: Condition): string {
  if ("all" in c) return c.all.map(describe).join(" and ");
  if ("any" in c) return "(" + c.any.map(describe).join(" or ") + ")";
  if ("not" in c) return "not " + describe(c.not);
  const l = c as Leaf;
  const p = Array.isArray(l.property) ? l.property[0] : l.property;
  const sym: Record<string, string> = { gte: "≥", gt: ">", lte: "≤", lt: "<", eq: "=", ne: "≠" };
  if (l.op === "exists" || l.op === "notExists") return `${p} ${l.op === "exists" ? "is recorded" : "is not recorded"}`;
  const u = l.unit ? " " + l.unit : "";
  if (l.op === "between") return `${p} between ${(l.value as number[]).join(" and ")}${u}`;
  return `${p} ${sym[l.op] ?? l.op} ${Array.isArray(l.value) ? l.value.join("/") : l.value}${u}`;
}

export function compilePack(pack: JsonPack): RulePack {
  const rules: Rule[] = pack.rules.map((r) => ({
    id: `${pack.id}:${r.id}`,
    name: r.name,
    description: r.description,
    standard: r.standard ?? pack.name,
    jurisdiction: r.jurisdiction ?? pack.jurisdiction,
    severity: r.severity,
    category: r.category,
    appliesTo: r.appliesTo,
    check(ctx): RuleCheckResult {
      const props = ctx.props;
      if (r.when) { const w = evalCondition(r.when, props); if (w !== true) return { pass: true }; }
      const res = evalCondition(r.require, props);
      if (res === true) return { pass: true };
      const required = describe(r.require);
      if (res === undefined) {
        const policy = r.missing ?? "pass";
        if (policy === "pass") return { pass: true, message: "Property not recorded" };
        const message = `Property needed for this check is not recorded (${required})`;
        if (policy === "fail") return { pass: false, message, actual: "not recorded", required };
        // "info": reported as an information-level note regardless of the rule's own severity.
        return {
          pass: false,
          violations: [{
            ruleId: `${pack.id}:${r.id}`, ruleName: r.name, standard: r.standard ?? pack.name, jurisdiction: r.jurisdiction ?? pack.jurisdiction,
            severity: "info", category: r.category ?? "", elementId: ctx.elementId ?? 0, elementName: ctx.elementName ?? "",
            elementCategory: ctx.elementCategory ?? "", message, actual: "not recorded", required,
          }],
        };
      }
      const rq = r.require as Leaf;
      const keys = "property" in rq ? (Array.isArray(rq.property) ? rq.property : [rq.property]) : [];
      const actual = keys.length ? String(firstProp(props, keys) ?? "") : "";
      const msg = (r.message ?? "Requirement not met: {required}").replace(/\{required\}/g, required).replace(/\{actual\}/g, actual);
      return { pass: false, message: msg, actual: actual || undefined, required };
    },
  }));
  return { id: pack.id, name: pack.name, description: pack.description, jurisdiction: pack.jurisdiction, version: pack.version, rules };
}

/** Parse text → validate → compile. Never throws; returns the reasons when it cannot load. */
export function loadPackText(text: string): { pack?: RulePack; errors: string[]; warnings: string[] } {
  if (text.length > 5_000_000) return { errors: ["The file is larger than 5 MB."], warnings: [] };
  let json: unknown;
  try { json = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { return { errors: ["Not valid JSON: " + (e instanceof Error ? e.message : String(e))], warnings: [] }; }
  const v = validatePackJson(json);
  if (!v.ok) return { errors: v.errors, warnings: v.warnings };
  return { pack: compilePack(json as JsonPack), errors: [], warnings: v.warnings };
}
