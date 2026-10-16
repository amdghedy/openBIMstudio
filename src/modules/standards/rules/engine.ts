/**
 * Standards rule engine.
 *
 * Runs one or more rule packs against a loaded fragment model. Handles:
 *   • Bounded concurrency (rules within a pack run sequentially; packs run
 *     one at a time to avoid starving the render loop)
 *   • Progress + cancellation
 *   • Deduplication across overlapping packs
 *   • Categorising violations by severity for the UI
 */
import { ctx } from "../../../core/context";
import { i18n } from "../../../core/i18n";
import { units } from "../../../core/units";
import { diagnostics } from "../../../core/diagnostics";
import { listPacks, getPack, listRules, getRule } from "./registry";
import type {
  Rule, RuleContext, RulePack, RuleViolation, RunOptions, RunSummary,
} from "./types";

export interface RunResult {
  summary: RunSummary;
  violations: RuleViolation[];
  errorsByRule: Map<string, string>;
}

export async function runRules(opts: RunOptions = {}): Promise<RunResult> {
  const start = Date.now();
  const signal = opts.signal;
  const progress = opts.onProgress ?? (() => {});

  const modelId =
    opts.modelId ??
    (ctx.fragments.list.size ? [...ctx.fragments.list.keys()][0] : null);
  if (!modelId) {
    return emptyResult(start, "No model loaded");
  }
  const model = ctx.fragments.list.get(modelId);
  if (!model) {
    return emptyResult(start, `Model "${modelId}" not loaded`);
  }

  // Determine the set of rules to run.
  let rules: Rule[] = [];
  if (opts.ruleIds?.length) {
    rules = opts.ruleIds.map((id) => getRule(id)).filter((r): r is Rule => !!r);
  } else if (opts.packIds?.length) {
    for (const pid of opts.packIds) {
      const p = getPack(pid);
      if (p) rules.push(...p.rules);
    }
  } else {
    rules = listRules();
  }

  // De-duplicate by rule id (a rule may be shared by multiple packs).
  const seen = new Set<string>();
  rules = rules.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  if (!rules.length) {
    return emptyResult(start, "No rules selected");
  }

  // Model category catalogue for early exit filtering.
  let allCats: string[] = [];
  try {
    const cats = await model.getItemsOfCategories([/.+/]);
    allCats = Object.keys(cats);
  } catch { /* */ }

  const violations: RuleViolation[] = [];
  const errorsByRule = new Map<string, string>();
  const ruleCtx: RuleContext = {
    model,
    modelId,
    locale: i18n.getLocale(),
    unitSystem: units.getSystem(),
    progress: (done: number, total: number, note?: string) => progress(done, total, note),
    isCancelled: () => signal?.cancelled === true,
  };

  let ruleIndex = 0;
  for (const rule of rules) {
    if (signal?.cancelled) break;
    ruleIndex++;
    progress(ruleIndex, rules.length, rule.name);

    if (rule.requiresCategories && !rule.requiresCategories(allCats)) {
      continue;
    }

    try {
      const found = await rule.check(ruleCtx);
      if (Array.isArray(found)) {
        if (found.length) violations.push(...found);
      } else if (found.violations?.length) {
        violations.push(...found.violations);
      } else if (!found.pass) {
        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          standard: rule.standard ?? "Standard",
          jurisdiction: rule.jurisdiction ?? "intl",
          severity: rule.severity,
          category: rule.category ?? "General",
          elementId: 0,
          elementName: "",
          elementCategory: "",
          message: found.message ?? "Rule violation",
          actual: found.actual,
          required: found.required,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorsByRule.set(rule.id, msg);
      diagnostics.warn("standards.rules", `rule "${rule.id}" threw: ${msg}`, err);
    }

    // Yield to the render loop between rules.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  const finishedAt = Date.now();
  let errors = 0, warnings = 0, infos = 0;
  for (const v of violations) {
    if (v.severity === "error") errors++;
    else if (v.severity === "warning") warnings++;
    else infos++;
  }

  const summary: RunSummary = {
    packCount: opts.packIds?.length ?? listPacks().length,
    ruleCount: rules.length,
    violations: violations.length,
    errors, warnings, infos,
    startedAt: start,
    finishedAt,
    durationMs: finishedAt - start,
    cancelled: signal?.cancelled === true,
  };

  console.log(
    `[standards] ran ${rules.length} rule(s) in ${summary.durationMs} ms · ` +
    `${violations.length} violation(s) · ${errorsByRule.size} rule error(s)`,
  );

  return { summary, violations, errorsByRule };
}

function emptyResult(start: number, reason: string): RunResult {
  console.warn("[standards]", reason);
  const now = Date.now();
  return {
    summary: {
      packCount: 0, ruleCount: 0, violations: 0,
      errors: 0, warnings: 0, infos: 0,
      startedAt: start, finishedAt: now, durationMs: now - start, cancelled: false,
    },
    violations: [],
    errorsByRule: new Map([[reason, reason]]),
  };
}