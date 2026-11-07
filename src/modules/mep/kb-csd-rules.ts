/**
 * KB-BIM Engineering Knowledge Engine.
 *
 * Rules are project-profile data, not universal hard-coded standards.
 * Every approved rule must retain a document/clause provenance reference.
 * All geometric values are metres. This module is deterministic and has no UI,
 * network, IFC or AI dependencies.
 */
import type { CsdPoint2, CsdRelationship, CsdSectionBoundary, CsdServiceItem } from "./csd-packing";

export const KB_BIM_RULE_SCHEMA_VERSION = 1 as const;

export type KbRuleSourceKind = "standard" | "project-specification" | "consultant-instruction" | "approved-rfi" | "engineering-decision";
export interface KbRuleSource {
  kind: KbRuleSourceKind;
  documentId: string;
  clause: string;
  revision?: string;
  url?: string;
}
export interface KbRuleBase {
  id: string;
  title: string;
  source: KbRuleSource;
  approval: "approved" | "draft";
  approvedBy?: string;
  approvedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}
export type KbCsdRule =
  | (KbRuleBase & { kind: "pair-clearance"; systems: [string, string]; value: number })
  | (KbRuleBase & { kind: "edge-clearance"; system: string; value: number })
  | (KbRuleBase & { kind: "preferred-side"; system: string; side: "top" | "bottom" | "left" | "right"; strength: number })
  | (KbRuleBase & { kind: "service-order"; upperSystem: string; lowerSystem: string; gap: number })
  | (KbRuleBase & { kind: "discipline-restriction"; discipline: string; allowedSystems?: string[]; prohibitedSystems?: string[] })
  | (KbRuleBase & { kind: "system-priority"; system: string; priority: number });

export interface KbCsdRuleProfile {
  schemaVersion: typeof KB_BIM_RULE_SCHEMA_VERSION;
  id: string;
  name: string;
  revision: string;
  jurisdiction: string;
  projectId?: string;
  rules: KbCsdRule[];
}
export interface KbCsdRuleContext {
  discipline: string;
  effectiveDate: string;
}
export interface KbRuleDiagnostic {
  code: string;
  message: string;
  ruleIds: string[];
  itemIds: string[];
  severity: "error" | "warning" | "info";
}
export interface KbCsdRuleCompilation {
  valid: boolean;
  profileId: string;
  profileRevision: string;
  items: CsdServiceItem[];
  relationships: CsdRelationship[];
  blockedItemIds: string[];
  appliedRuleIds: string[];
  diagnostics: KbRuleDiagnostic[];
}

const isFiniteNonNegative = (v: number): boolean => Number.isFinite(v) && v >= 0;
const validDate = (v: string | undefined): boolean => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(v + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
};
const normalized = (v: string): string => v.trim().toLowerCase();
const pairKey = (a: string, b: string): string => [normalized(a), normalized(b)].sort().join("|");
const hasText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function validateKbCsdRuleProfile(profile: KbCsdRuleProfile): KbRuleDiagnostic[] {
  const out: KbRuleDiagnostic[] = [];
  const add = (code: string, message: string, ruleIds: string[] = [], severity: KbRuleDiagnostic["severity"] = "error") =>
    out.push({ code, message, ruleIds, itemIds: [], severity });
  if (!profile || profile.schemaVersion !== KB_BIM_RULE_SCHEMA_VERSION) {
    add("PROFILE_SCHEMA_UNSUPPORTED", "Rule profile schema version is missing or unsupported.");
    return out;
  }
  if (!hasText(profile.id) || !hasText(profile.name) || !hasText(profile.revision) || !hasText(profile.jurisdiction))
    add("PROFILE_METADATA_MISSING", "Profile ID, name, revision and jurisdiction are required.");
  if (!Array.isArray(profile.rules)) {
    add("PROFILE_RULES_INVALID", "Profile rules must be an array.");
    return out;
  }
  const ids = new Set<string>();
  for (const rule of profile.rules) {
    if (!rule || !hasText(rule.id)) { add("RULE_ID_MISSING", "Every rule requires a stable non-empty ID."); continue; }
    if (ids.has(rule.id)) add("RULE_ID_DUPLICATE", "Duplicate rule ID: " + rule.id, [rule.id]);
    ids.add(rule.id);
    if (!hasText(rule.title)) add("RULE_TITLE_MISSING", "Rule " + rule.id + " requires a title.", [rule.id]);
    if (rule.approval !== "approved" && rule.approval !== "draft") add("RULE_APPROVAL_INVALID", "Rule " + rule.id + " has an invalid approval state.", [rule.id]);
    if (!rule.source || !hasText(rule.source.documentId) || !hasText(rule.source.clause) ||
        !["standard", "project-specification", "consultant-instruction", "approved-rfi", "engineering-decision"].includes(rule.source.kind))
      add("RULE_PROVENANCE_MISSING", "Rule " + rule.id + " requires a valid source kind, document ID and clause.", [rule.id]);
    if (rule.approval === "approved" && (!hasText(rule.approvedBy) || !validDate(rule.approvedAt)))
      add("RULE_APPROVAL_AUDIT_MISSING", "Approved rule " + rule.id + " requires approvedBy and an ISO date approvedAt.", [rule.id]);
    if (rule.effectiveFrom && !validDate(rule.effectiveFrom)) add("RULE_EFFECTIVE_FROM_INVALID", "Rule " + rule.id + " has an invalid effectiveFrom date.", [rule.id]);
    if (rule.effectiveTo && !validDate(rule.effectiveTo)) add("RULE_EFFECTIVE_TO_INVALID", "Rule " + rule.id + " has an invalid effectiveTo date.", [rule.id]);
    if (rule.effectiveFrom && rule.effectiveTo && validDate(rule.effectiveFrom) && validDate(rule.effectiveTo) && rule.effectiveFrom > rule.effectiveTo)
      add("RULE_EFFECTIVE_RANGE_INVALID", "Rule " + rule.id + " ends before it becomes effective.", [rule.id]);
    switch (rule.kind) {
      case "pair-clearance":
        if (!Array.isArray(rule.systems) || rule.systems.length !== 2 || !rule.systems.every(hasText) || normalized(rule.systems[0]) === normalized(rule.systems[1]))
          add("RULE_SYSTEM_PAIR_INVALID", "Pair-clearance rule " + rule.id + " requires two distinct system names.", [rule.id]);
        if (!isFiniteNonNegative(rule.value)) add("RULE_CLEARANCE_INVALID", "Pair-clearance rule " + rule.id + " requires a non-negative metre value.", [rule.id]);
        break;
      case "edge-clearance":
        if (!hasText(rule.system)) add("RULE_SYSTEM_MISSING", "Edge-clearance rule " + rule.id + " requires a system.", [rule.id]);
        if (!isFiniteNonNegative(rule.value)) add("RULE_CLEARANCE_INVALID", "Edge-clearance rule " + rule.id + " requires a non-negative metre value.", [rule.id]);
        break;
      case "preferred-side":
        if (!hasText(rule.system) || !["top", "bottom", "left", "right"].includes(rule.side))
          add("RULE_PREFERENCE_INVALID", "Preferred-side rule " + rule.id + " has an invalid system or side.", [rule.id]);
        if (!isFiniteNonNegative(rule.strength)) add("RULE_STRENGTH_INVALID", "Preferred-side strength must be non-negative.", [rule.id]);
        break;
      case "service-order":
        if (!hasText(rule.upperSystem) || !hasText(rule.lowerSystem) || normalized(rule.upperSystem) === normalized(rule.lowerSystem))
          add("RULE_ORDER_SYSTEMS_INVALID", "Service-order rule " + rule.id + " requires two distinct systems.", [rule.id]);
        if (!isFiniteNonNegative(rule.gap)) add("RULE_GAP_INVALID", "Service-order gap must be a non-negative metre value.", [rule.id]);
        break;
      case "discipline-restriction":
        if (!hasText(rule.discipline) || (!rule.allowedSystems?.length && !rule.prohibitedSystems?.length))
          add("RULE_RESTRICTION_INVALID", "Discipline restriction " + rule.id + " requires a discipline and allowed or prohibited systems.", [rule.id]);
        if ([...(rule.allowedSystems ?? []), ...(rule.prohibitedSystems ?? [])].some(s => !hasText(s)))
          add("RULE_RESTRICTION_SYSTEM_INVALID", "Discipline restriction " + rule.id + " contains an empty system name.", [rule.id]);
        break;
      case "system-priority":
        if (!hasText(rule.system) || !Number.isFinite(rule.priority))
          add("RULE_PRIORITY_INVALID", "System-priority rule " + rule.id + " requires a system and finite priority.", [rule.id]);
        break;
      default:
        add("RULE_KIND_UNSUPPORTED", "Rule " + rule.id + " has an unsupported kind.", [rule.id]);
    }
  }
  return out;
}

function isEffective(rule: KbCsdRule, date: string): boolean {
  return rule.approval === "approved" &&
    (!rule.effectiveFrom || rule.effectiveFrom <= date) &&
    (!rule.effectiveTo || rule.effectiveTo >= date);
}

/**
 * Compiles approved, in-force project rules into solver-ready constraints.
 * Hard restrictions are returned as blockedItemIds; callers must not pass a
 * blocked item set to the solver and must surface these diagnostics to users.
 * Pair-specific clearances remain pair-specific (not inflated onto all services).
 */
export function compileKbCsdRules(input: {
  profile: KbCsdRuleProfile;
  context: KbCsdRuleContext;
  boundary: CsdSectionBoundary;
  items: CsdServiceItem[];
  baseRelationships?: CsdRelationship[];
}): KbCsdRuleCompilation {
  const { profile, context, boundary } = input;
  const items = (input.items ?? []).map(item => ({ ...item, pairClearances: { ...(item.pairClearances ?? {}) } }));
  const relationships = [...(input.baseRelationships ?? [])];
  const diagnostics = validateKbCsdRuleProfile(profile);
  const result: KbCsdRuleCompilation = {
    valid: diagnostics.every(d => d.severity !== "error"),
    profileId: profile?.id ?? "",
    profileRevision: profile?.revision ?? "",
    items,
    relationships,
    blockedItemIds: [],
    appliedRuleIds: [],
    diagnostics,
  };
  if (!result.valid) return result;
  if (!validDate(context?.effectiveDate) || !hasText(context?.discipline) ||
      !boundary || !Number.isFinite(boundary.width) || !Number.isFinite(boundary.height) || boundary.width <= 0 || boundary.height <= 0) {
    result.valid = false;
    result.diagnostics.push({ code: "COMPILATION_CONTEXT_INVALID",
      message: "Compilation requires a discipline, valid effective date and positive section boundary.",
      ruleIds: [], itemIds: [], severity: "error" });
    return result;
  }

  const effectiveRules = profile.rules.filter(r => isEffective(r, context.effectiveDate));
  const active = effectiveRules.filter(r => r.kind !== "preferred-side").concat(
    effectiveRules.filter((r): r is Extract<KbCsdRule, { kind: "preferred-side" }> => r.kind === "preferred-side")
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id)),
  );
  const preferredSideByItem = new Map<string, string>();
  for (const draft of profile.rules.filter(r => r.approval !== "approved")) {
    result.diagnostics.push({ code: "RULE_DRAFT_IGNORED", message: "Draft rule " + draft.id + " was not applied.",
      ruleIds: [draft.id], itemIds: [], severity: "info" });
  }
  for (const expired of profile.rules.filter(r => r.approval === "approved" && !isEffective(r, context.effectiveDate))) {
    result.diagnostics.push({ code: "RULE_OUT_OF_DATE", message: "Rule " + expired.id + " is not effective on " + context.effectiveDate + ".",
      ruleIds: [expired.id], itemIds: [], severity: "info" });
  }

  const bySystem = (system: string) => items.filter(i => normalized(i.system) === normalized(system));
  const applyRule = (rule: KbCsdRule) => { if (!result.appliedRuleIds.includes(rule.id)) result.appliedRuleIds.push(rule.id); };

  for (const rule of active) {
    switch (rule.kind) {
      case "discipline-restriction": {
        if (normalized(rule.discipline) !== normalized(context.discipline)) break;
        const allowed = rule.allowedSystems?.map(normalized);
        const prohibited = new Set((rule.prohibitedSystems ?? []).map(normalized));
        for (const item of items) {
          const system = normalized(item.system);
          const denied = prohibited.has(system) || (!!allowed?.length && !allowed.includes(system));
          if (denied) {
            if (!result.blockedItemIds.includes(item.id)) result.blockedItemIds.push(item.id);
            result.diagnostics.push({ code: "DISCIPLINE_SYSTEM_BLOCKED",
              message: item.system + " is not permitted by discipline profile " + rule.discipline + ".",
              ruleIds: [rule.id], itemIds: [item.id], severity: "error" });
          }
        }
        applyRule(rule);
        break;
      }
      case "edge-clearance":
        for (const item of bySystem(rule.system)) {
          item.edgeClearance = Math.max(item.edgeClearance ?? 0, rule.value);
          applyRule(rule);
        }
        break;
      case "pair-clearance": {
        const [a, b] = rule.systems;
        const left = bySystem(a), right = bySystem(b);
        for (const ia of left) for (const ib of right) {
          if (ia.id === ib.id) continue;
          ia.pairClearances![ib.id] = Math.max(ia.pairClearances![ib.id] ?? 0, rule.value);
          ib.pairClearances![ia.id] = Math.max(ib.pairClearances![ia.id] ?? 0, rule.value);
          applyRule(rule);
        }
        break;
      }
      case "preferred-side":
        for (const item of bySystem(rule.system)) {
          if (item.fixed) {
            result.diagnostics.push({ code: "PREFERENCE_OVERRIDDEN_BY_FIXED_POSITION",
              message: "Fixed position for " + item.id + " overrides preferred side " + rule.side + ".",
              ruleIds: [rule.id], itemIds: [item.id], severity: "info" });
            continue;
          }
          const selectedSide = preferredSideByItem.get(item.id);
          if (selectedSide && selectedSide !== rule.side) {
            result.diagnostics.push({ code: "PREFERRED_SIDE_CONFLICT",
              message: "Conflicting preferred-side rule ignored for " + item.id + "; the strongest applicable rule was retained.",
              ruleIds: [rule.id], itemIds: [item.id], severity: "warning" });
            continue;
          }
          if (item.preferred && !selectedSide) {
            result.diagnostics.push({ code: "EXISTING_PREFERENCE_OVERRIDES_RULE",
              message: "Existing preferred position for " + item.id + " takes precedence over rule " + rule.id + ".",
              ruleIds: [rule.id], itemIds: [item.id], severity: "info" });
            continue;
          }
          if (!item.preferred) {
            const edge = Math.max(0, item.edgeClearance ?? 0);
            const x = rule.side === "left" ? edge : rule.side === "right" ? boundary.width - edge - item.width : (boundary.width - item.width) / 2;
            const y = rule.side === "bottom" ? edge : rule.side === "top" ? boundary.height - edge - item.height : (boundary.height - item.height) / 2;
            const preferred: CsdPoint2 = { x: Math.max(edge, x), y: Math.max(edge, y) };
            item.preferred = preferred;
          }
          preferredSideByItem.set(item.id, rule.side);
          applyRule(rule);
        }
        break;
      case "service-order": {
        const uppers = bySystem(rule.upperSystem), lowers = bySystem(rule.lowerSystem);
        for (const upper of uppers) for (const lower of lowers) {
          if (upper.id === lower.id) continue;
          relationships.push({ kind: "above", fromId: upper.id, toId: lower.id, gap: rule.gap });
          applyRule(rule);
        }
        break;
      }
      case "system-priority":
        for (const item of bySystem(rule.system)) {
          item.priority = item.priority === undefined ? rule.priority : Math.max(item.priority, rule.priority);
          applyRule(rule);
        }
        break;
    }
  }
  result.blockedItemIds.sort();
  result.appliedRuleIds.sort();
  return result;
}
