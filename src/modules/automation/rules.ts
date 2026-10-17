/**
 * Automation Rules Engine — rule-based AEC automation.
 *
 * Lightweight competitor to Dynamo / Grasshopper for common production tasks:
 * colour by parameter, isolate by category, assign phase, rename, tag, etc.
 */
import type { AutomationRule } from "../projects/types";

const uid = () =>
  (crypto as any).randomUUID?.() ?? `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let rules: AutomationRule[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function onRulesChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listRules(): AutomationRule[] {
  return rules.slice();
}

export function addRule(partial?: Partial<AutomationRule>): AutomationRule {
  const rule: AutomationRule = {
    id: uid(),
    name: partial?.name ?? "New rule",
    enabled: partial?.enabled ?? true,
    trigger: partial?.trigger ?? "manual",
    condition: partial?.condition,
    actions: partial?.actions ?? [{ type: "log", params: { message: "Rule fired" } }],
  };
  rules.push(rule);
  notify();
  return rule;
}

export function updateRule(id: string, patch: Partial<AutomationRule>) {
  const r = rules.find((x) => x.id === id);
  if (!r) return;
  Object.assign(r, patch);
  notify();
}

export function removeRule(id: string) {
  rules = rules.filter((r) => r.id !== id);
  notify();
}

export function ensureDefaultRules() {
  if (rules.length) return;
  addRule({
    name: "Colour walls by height > 3m",
    trigger: "manual",
    condition: "category=wall AND height>3",
    actions: [{ type: "set-color", params: { color: "#ef4444" } }],
  });
  addRule({
    name: "Isolate structural elements",
    trigger: "manual",
    condition: "category=column OR category=beam OR category=brace",
    actions: [{ type: "isolate", params: {} }],
  });
  addRule({
    name: "Assign selection to Foundations phase",
    trigger: "manual",
    condition: "category=footing OR category=strip",
    actions: [{ type: "assign-phase", params: { phaseName: "Foundations" } }],
  });
  addRule({
    name: "On import — run IDS check reminder",
    trigger: "on-import",
    actions: [{ type: "toast", params: { message: "Remember to run IDS validation on new models." } }],
  });
}

/** Execute a rule (best-effort — actions are extensible hooks). */
export async function runRule(id: string, context?: { selectionIds?: string[] }) {
  const rule = rules.find((r) => r.id === id);
  if (!rule || !rule.enabled) return { ok: false, message: "Rule not found or disabled" };

  const results: string[] = [];
  for (const action of rule.actions) {
    switch (action.type) {
      case "log":
        console.log(`[automation] ${action.params.message ?? rule.name}`);
        results.push("logged");
        break;
      case "toast":
        results.push(String(action.params.message ?? "Rule executed"));
        break;
      case "set-color":
        results.push(`set-color → ${action.params.color}`);
        // Hook point: authoring / fragment colour APIs can be called here
        break;
      case "isolate":
        results.push("isolate selection/filter");
        break;
      case "assign-phase":
        results.push(`assign-phase → ${action.params.phaseName}`);
        break;
      default:
        results.push(`unknown action: ${action.type}`);
    }
  }

  // Fire a custom event so UI / other modules can react
  window.dispatchEvent(
    new CustomEvent("obs-automation-run", {
      detail: { ruleId: id, ruleName: rule.name, results, context },
    }),
  );

  return { ok: true, message: results.join("; ") };
}

export function runRulesByTrigger(trigger: AutomationRule["trigger"]) {
  const matched = rules.filter((r) => r.enabled && r.trigger === trigger);
  return Promise.all(matched.map((r) => runRule(r.id)));
}

export function loadRulesFromProject(list: AutomationRule[] | undefined) {
  rules = list?.length ? list.map((r) => ({ ...r })) : [];
  if (!rules.length) ensureDefaultRules();
  notify();
}

export function getRulesForSave(): AutomationRule[] {
  return rules.map((r) => ({ ...r }));
}
