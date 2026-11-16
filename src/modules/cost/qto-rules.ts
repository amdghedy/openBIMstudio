/**
 * 5D QTO rules engine.
 *
 * Turns the raw element-parameter takeoff (quantities.ts) into work-item
 * quantities: a rule filters takeoff rows, derives a quantity through a
 * safe compiled formula over the row's base quantities, applies a waste
 * factor, optionally rolls up by classification code and prices the result
 * against the cost rate book (cost.ts items).
 *
 * The formula language is the SAME safe AST evaluator the schedules use
 * (../schedules/schedule-formula.ts) — no eval, no Function constructor.
 * Variables available per matched row:
 *   Count · Length · Area · Volume
 * (Length/Area/Volume are the net geometric takeoff — walls already
 * deduct openings; see quantities.ts authoredRows.)
 *
 * A rule that fails to compile or throws at runtime is captured in the
 * run's errors and never aborts the batch: one bad rule cannot take the
 * whole estimate down.
 */

import type { CostUnit, TakeoffRow } from "./types";
import { compileFormula, validateFormula, type CompiledFormula } from "../schedules/schedule-formula";

// ══════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════

export interface QtoRuleFilter {
  /** Restrict to authored and/or IFC rows. Absent = both. */
  sources?: Array<"authored" | "ifc">;
  /** Case-insensitive substrings — every one must appear in the row's
   *  label + detail (e.g. ["wall"] matches "Wall 001", "IFCWALLSTANDARDCASE"). */
  matchAll?: string[];
  /** Case-insensitive substrings — at least one must appear. */
  matchAny?: string[];
  /** Case-sensitive substring the label must NOT contain (exclusions). */
  excludeAny?: string[];
}

export interface QtoRule {
  id: string;
  name: string;
  description?: string;
  /** Classification / assembly code the result rolls up under
   *  (e.g. "03 30 00 Cast-in-place concrete"). Absent = rule name. */
  classification?: string;
  filter: QtoRuleFilter;
  /** Formula over Count/Length/Area/Volume, e.g. "Volume * 100" (kg rebar). */
  formula: string;
  unit: CostUnit;
  /** Waste / additional factor as a percentage — 5 means ×1.05. */
  wasteFactorPct?: number;
  /** Rate-book link: CostItem.code to price the computed quantity. */
  costCode?: string;
}

export interface QtoRuleLine {
  rowKey: string;
  label: string;
  /** Raw formula value for this row. */
  quantity: number;
}

export interface QtoRuleResult {
  ruleId: string;
  ruleName: string;
  classification: string;
  unit: CostUnit;
  wasteFactorPct: number;
  matchedRows: number;
  /** Sum of the formula over matched rows, before waste factor. */
  netQuantity: number;
  /** netQuantity × (1 + wasteFactorPct / 100). */
  quantity: number;
  lines: QtoRuleLine[];
  /** Present when the rule carries a costCode AND the rate book has it. */
  cost?: { code: string; name: string; rate: number; total: number };
}

export interface QtoRuleError {
  ruleId: string;
  ruleName: string;
  error: string;
}

export interface QtoRun {
  results: QtoRuleResult[];
  errors: QtoRuleError[];
  /** Total computed quantity per unit across all successful rules. */
  byUnit: Record<CostUnit, number>;
  /** Classification roll-up — one entry per (classification, unit) pair. */
  byClassification: Array<{
    classification: string;
    unit: CostUnit;
    quantity: number;
    ruleIds: string[];
  }>;
  /** Sum of every priced rule's total. Rules without a resolvable
   *  costCode contribute quantity but not cost. */
  costTotal: number;
  evaluatedAt: number;
}

export interface QtoRateEntry {
  code: string;
  name: string;
  unit: CostUnit;
  rate: number;
}

export interface EvaluateQtoOptions {
  /** Rate book keyed by CostItem.code — enables rule pricing. */
  rates?: Record<string, QtoRateEntry>;
}

// ══════════════════════════════════════════════════════════════════════════
// Matching
// ══════════════════════════════════════════════════════════════════════════

function rowMatches(row: TakeoffRow, filter: QtoRuleFilter): boolean {
  if (filter.sources && !filter.sources.includes(row.source)) return false;
  const haystack = `${row.label} ${row.detail}`.toLowerCase();
  if (filter.matchAll?.length) {
    for (const token of filter.matchAll) {
      if (!haystack.includes(token.toLowerCase())) return false;
    }
  }
  if (filter.matchAny?.length) {
    const hit = filter.matchAny.some((t) => haystack.includes(t.toLowerCase()));
    if (!hit) return false;
  }
  if (filter.excludeAny?.length) {
    for (const token of filter.excludeAny) {
      if (row.label.toLowerCase().includes(token.toLowerCase())) return false;
    }
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// Evaluation
// ══════════════════════════════════════════════════════════════════════════

const ALL_UNITS: CostUnit[] = ["m", "m2", "m3", "pcs", "kg"];

function emptyByUnit(): Record<CostUnit, number> {
  return { m: 0, m2: 0, m3: 0, pcs: 0, kg: 0 };
}

/**
 * Evaluate a batch of rules over takeoff rows. Batch-resilient: a rule
 * with an invalid formula or a runtime evaluation error lands in
 * run.errors and the remaining rules still produce results.
 */
export function evaluateQtoRules(
  rows: TakeoffRow[],
  rules: QtoRule[],
  opts: EvaluateQtoOptions = {},
): QtoRun {
  const results: QtoRuleResult[] = [];
  const errors: QtoRuleError[] = [];
  const byUnit = emptyByUnit();
  let costTotal = 0;

  for (const rule of rules) {
    const source = rule.formula?.trim() ? rule.formula : "";
    if (!source) {
      errors.push({ ruleId: rule.id, ruleName: rule.name, error: "empty formula" });
      continue;
    }
    const validation = validateFormula(source);
    if (!validation.ok) {
      errors.push({
        ruleId: rule.id,
        ruleName: rule.name,
        error: `invalid formula: ${validation.error}`,
      });
      continue;
    }

    let fn: CompiledFormula;
    try {
      fn = compileFormula(source);
    } catch (err) {
      errors.push({
        ruleId: rule.id,
        ruleName: rule.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const lines: QtoRuleLine[] = [];
    let net = 0;
    let runtimeError: string | undefined;
    for (const row of rows) {
      if (!rowMatches(row, rule.filter)) continue;
      let q = 0;
      try {
        q = fn({
          values: {
            Count: row.count,
            Length: row.length,
            Area: row.area,
            Volume: row.volume,
          },
        });
      } catch (err) {
        runtimeError = err instanceof Error ? err.message : String(err);
        break;
      }
      if (Number.isFinite(q) && q !== 0) {
        lines.push({ rowKey: row.key, label: row.label, quantity: q });
        net += q;
      }
    }

    if (runtimeError) {
      errors.push({ ruleId: rule.id, ruleName: rule.name, error: runtimeError });
      continue;
    }

    const waste = Math.max(0, Number(rule.wasteFactorPct ?? 0) || 0);
    const quantity = net * (1 + waste / 100);

    const result: QtoRuleResult = {
      ruleId: rule.id,
      ruleName: rule.name,
      classification: rule.classification?.trim() || rule.name,
      unit: rule.unit,
      wasteFactorPct: waste,
      matchedRows: lines.length,
      netQuantity: net,
      quantity,
      lines,
    };

    if (rule.costCode && opts.rates) {
      const entry = opts.rates[rule.costCode];
      if (entry) {
        if (entry.unit !== rule.unit) {
          errors.push({
            ruleId: rule.id,
            ruleName: rule.name,
            error: `unit mismatch with rate ${entry.code}: rule ${rule.unit} vs rate ${entry.unit}`,
          });
        } else {
          result.cost = {
            code: entry.code,
            name: entry.name,
            rate: entry.rate,
            total: quantity * (entry.rate || 0),
          };
        }
      }
      // Unknown costCode is not an error — the rule still yields quantity.
    }

    results.push(result);
    byUnit[rule.unit] = (byUnit[rule.unit] ?? 0) + quantity;
    if (result.cost) costTotal += result.cost.total;
  }

  return {
    results,
    errors,
    byUnit,
    byClassification: rollupByClassification(results),
    costTotal,
    evaluatedAt: Date.now(),
  };
}

/** Group successful rule results by (classification, unit). */
export function rollupByClassification(
  results: QtoRuleResult[],
): QtoRun["byClassification"] {
  const map = new Map<string, { classification: string; unit: CostUnit; quantity: number; ruleIds: string[] }>();
  for (const r of results) {
    const key = `${r.classification}\u0000${r.unit}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { classification: r.classification, unit: r.unit, quantity: 0, ruleIds: [] };
      map.set(key, entry);
    }
    entry.quantity += r.quantity;
    entry.ruleIds.push(r.ruleId);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.classification.localeCompare(b.classification) ||
      ALL_UNITS.indexOf(a.unit) - ALL_UNITS.indexOf(b.unit),
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Custom rules — persisted in localStorage, edited via API (rule editor UI
// is future scope). Invalid rules are rejected with a reason.
// ══════════════════════════════════════════════════════════════════════════

const CUSTOM_KEY = "obs.qto.customRules";

export function getCustomQtoRules(): QtoRule[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QtoRule[]) : [];
  } catch {
    return [];
  }
}

/** Persist custom rules. Returns the rejected rules with reasons. */
export function setCustomQtoRules(rules: QtoRule[]): { rejected: Array<{ rule: QtoRule; reason: string }> } {
  const rejected: Array<{ rule: QtoRule; reason: string }> = [];
  const ok: QtoRule[] = [];
  const seen = new Set<string>();
  for (const r of rules ?? []) {
    if (!r?.id || !r?.name) { rejected.push({ rule: r, reason: "missing id or name" }); continue; }
    if (seen.has(r.id)) { rejected.push({ rule: r, reason: `duplicate id ${r.id}` }); continue; }
    seen.add(r.id);
    const v = validateFormula(r.formula ?? "");
    if (!v.ok) { rejected.push({ rule: r, reason: `invalid formula: ${v.error}` }); continue; }
    if (!ALL_UNITS.includes(r.unit)) { rejected.push({ rule: r, reason: `unknown unit ${String(r.unit)}` }); continue; }
    ok.push(r);
  }
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(ok));
  } catch {
    /* storage full or unavailable — rules stay session-only */
  }
  return { rejected };
}

/** Built-ins first, then user customs. */
export function getActiveQtoRules(): QtoRule[] {
  return [...BUILT_IN_QTO_RULES, ...getCustomQtoRules()];
}

// ══════════════════════════════════════════════════════════════════════════
// Built-in rule library
//
// Documented assumptions (they matter for honest 5D):
//   • Wall Area = BOTH faces, net of openings (quantities.ts recuts hosts);
//     Volume = net volume. So one-face quantities derive with Area / 2.
//   • Rebar uses a generic 100 kg/m³ ratio — a project must override this
//     per element type for real estimates (that's what custom rules are for).
//   • No unit-price escalation, no location/level dimension — cost is a
//     flat rate × computed quantity.
// ══════════════════════════════════════════════════════════════════════════

export const BUILT_IN_QTO_RULES: QtoRule[] = [
  {
    id: "qto-wall-concrete",
    name: "Wall concrete (net of openings)",
    description: "Net wall volume from the geometric takeoff — openings already deducted.",
    classification: "03 30 00 Cast-in-place concrete",
    filter: { matchAll: ["wall"] },
    formula: "Volume",
    unit: "m3",
    costCode: "C-CONC",
  },
  {
    id: "qto-wall-formwork",
    name: "Wall formwork (both faces)",
    description: "Wall area = both faces net of openings; formwork is placed on both faces.",
    classification: "03 11 00 Concrete formwork",
    filter: { matchAll: ["wall"] },
    formula: "Area",
    unit: "m2",
  },
  {
    id: "qto-wall-paint",
    name: "Wall paint (both faces)",
    description: "Both faces, net of openings, plus 5% waste for overlaps.",
    classification: "09 90 00 Painting and coating",
    filter: { matchAll: ["wall"] },
    formula: "Area",
    unit: "m2",
    wasteFactorPct: 5,
  },
  {
    id: "qto-wall-rebar",
    name: "Rebar estimate — walls (100 kg/m³)",
    description: "Generic ratio: 100 kg of reinforcement per m³ of net wall concrete. Override per project.",
    classification: "03 20 00 Reinforcement",
    filter: { matchAll: ["wall"] },
    formula: "Volume * 100",
    unit: "kg",
    wasteFactorPct: 3,
    costCode: "C-REBAR",
  },
  {
    id: "qto-slab-concrete",
    name: "Slab concrete",
    description: "Slab footprint area × thickness, from the geometric takeoff.",
    classification: "03 30 00 Cast-in-place concrete",
    filter: { matchAll: ["slab"] },
    formula: "Volume",
    unit: "m3",
    costCode: "C-CONC",
  },
  {
    id: "qto-slab-finish",
    name: "Slab finish (floor covering)",
    description: "Top-face finish area; footprint area excludes soffit formwork.",
    classification: "09 65 00 Resilient flooring",
    filter: { matchAll: ["slab"] },
    formula: "Area",
    unit: "m2",
    wasteFactorPct: 8,
  },
  {
    id: "qto-beam-concrete",
    name: "Beam concrete",
    description: "Beam volume from the geometric takeoff.",
    classification: "03 30 00 Cast-in-place concrete",
    filter: { matchAll: ["beam"] },
    formula: "Volume",
    unit: "m3",
    costCode: "C-CONC",
  },
  {
    id: "qto-column-concrete",
    name: "Column concrete",
    description: "Column volume from the geometric takeoff.",
    classification: "03 30 00 Cast-in-place concrete",
    filter: { matchAll: ["column"] },
    formula: "Volume",
    unit: "m3",
    costCode: "C-CONC",
  },
  {
    id: "qto-footing-concrete",
    name: "Footing concrete",
    description: "Footing volume from the geometric takeoff.",
    classification: "03 30 00 Cast-in-place concrete",
    filter: { matchAll: ["footing"] },
    formula: "Volume",
    unit: "m3",
    costCode: "C-CONC",
  },
  {
    id: "qto-door-count",
    name: "Door count",
    description: "Doors counted by the piece.",
    classification: "08 10 00 Doors and frames",
    filter: { matchAll: ["door"], excludeAny: ["window"] },
    formula: "Count",
    unit: "pcs",
    costCode: "C-DOOR",
  },
  {
    id: "qto-window-count",
    name: "Window count",
    description: "Windows counted by the piece.",
    classification: "08 50 00 Windows",
    filter: { matchAll: ["window"] },
    formula: "Count",
    unit: "pcs",
    costCode: "C-WINDOW",
  },
  {
    id: "qto-wall-length",
    name: "Wall centreline length",
    description: "Wall length for layout / layout-marking pricing.",
    classification: "01 51 00 Temporary utilities and construction aids",
    filter: { matchAll: ["wall"] },
    formula: "Length",
    unit: "m",
  },
];
