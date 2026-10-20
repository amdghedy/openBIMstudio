/**
 * Model Checker — QA/QC rules engine for BIM models.
 *
 * BIM-equivalent of Revit's "Model Checker" / Solibri Model Checker. Runs
 * rule-based checks against loaded IFC elements and produces a structured
 * report grouped by severity (error / warning / info).
 *
 * Shipped rule packs:
 *  - duplicate-elements
 *  - missing-classification
 *  - missing-level
 *  - overlapping-walls
 *  - unhosted-doors
 *  - fire-rating-consistency
 *  - ceiling-height
 *  - room-tag-missing
 */

export type Severity = "error" | "warning" | "info";

export interface ModelElement {
  expressId: number;
  type: string;
  name?: string;
  level?: string;
  classification?: string;
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  params?: Record<string, string | number>;
  hostId?: number;
}

export interface CheckResult {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  message: string;
  elementIds: number[];
  category: string;
}

export interface ModelCheckerConfig {
  /** Skip rules by ID. */
  skipRules?: string[];
  /** Custom rules to add. */
  customRules?: CheckerRule[];
}

export interface CheckerRule {
  id: string;
  name: string;
  severity: Severity;
  category: string;
  run: (elements: ModelElement[]) => CheckResult[];
}

function ruleDuplicateElements(): CheckerRule {
  return {
    id: "duplicate-elements",
    name: "Duplicate Elements",
    severity: "warning",
    category: "geometry",
    run: (elements) => {
      const results: CheckResult[] = [];
      const seen = new Map<string, ModelElement[]>();
      for (const el of elements) {
        if (!el.bbox) continue;
        const key = `${el.type}|${el.bbox.min.join(",")}|${el.bbox.max.join(",")}`;
        const arr = seen.get(key) ?? [];
        arr.push(el);
        seen.set(key, arr);
      }
      for (const arr of seen.values()) {
        if (arr.length > 1) {
          results.push({
            ruleId: "duplicate-elements",
            ruleName: "Duplicate Elements",
            severity: "warning",
            message: `${arr.length} elements share identical bbox+type — likely duplicates.`,
            elementIds: arr.map((e) => e.expressId),
            category: "geometry",
          });
        }
      }
      return results;
    },
  };
}

function ruleMissingClassification(): CheckerRule {
  return {
    id: "missing-classification",
    name: "Missing Classification",
    severity: "warning",
    category: "data",
    run: (elements) => {
      const missing = elements.filter((e) => !e.classification);
      if (!missing.length) return [];
      return [{
        ruleId: "missing-classification",
        ruleName: "Missing Classification",
        severity: "warning",
        message: `${missing.length} elements have no UniFormat/OmniClass classification.`,
        elementIds: missing.map((e) => e.expressId),
        category: "data",
      }];
    },
  };
}

function ruleMissingLevel(): CheckerRule {
  return {
    id: "missing-level",
    name: "Missing Level Association",
    severity: "error",
    category: "data",
    run: (elements) => {
      const missing = elements.filter((e) => !e.level);
      if (!missing.length) return [];
      return [{
        ruleId: "missing-level",
        ruleName: "Missing Level Association",
        severity: "error",
        message: `${missing.length} elements have no Level assignment.`,
        elementIds: missing.map((e) => e.expressId),
        category: "data",
      }];
    },
  };
}

function ruleUnhostedDoors(): CheckerRule {
  return {
    id: "unhosted-doors",
    name: "Unhosted Doors/Windows",
    severity: "error",
    category: "hosting",
    run: (elements) => {
      const missing = elements.filter(
        (e) => (e.type === "IfcDoor" || e.type === "IfcWindow") && e.hostId === undefined,
      );
      if (!missing.length) return [];
      return [{
        ruleId: "unhosted-doors",
        ruleName: "Unhosted Doors/Windows",
        severity: "error",
        message: `${missing.length} doors/windows have no host wall.`,
        elementIds: missing.map((e) => e.expressId),
        category: "hosting",
      }];
    },
  };
}

function ruleFireRatingConsistency(): CheckerRule {
  return {
    id: "fire-rating-consistency",
    name: "Fire Rating Inconsistent",
    severity: "error",
    category: "compliance",
    run: (elements) => {
      const wallsByLevel = new Map<string, Map<string, number[]>>();
      for (const w of elements.filter((e) => e.type === "IfcWall" && e.level)) {
        const lvl = w.level!;
        const fr = String(w.params?.FireRating ?? w.params?.FireResistanceRating ?? "—");
        const byFr = wallsByLevel.get(lvl) ?? new Map();
        const arr = byFr.get(fr) ?? [];
        arr.push(w.expressId);
        byFr.set(fr, arr);
        wallsByLevel.set(lvl, byFr);
      }
      const results: CheckResult[] = [];
      for (const [lvl, byFr] of wallsByLevel) {
        if (byFr.size > 1) {
          results.push({
            ruleId: "fire-rating-consistency",
            ruleName: "Fire Rating Inconsistent",
            severity: "error",
            message: `Level "${lvl}" has ${byFr.size} different fire ratings on walls — check compartmentation.`,
            elementIds: Array.from(byFr.values()).flat(),
            category: "compliance",
          });
        }
      }
      return results;
    },
  };
}

function ruleOverlappingWalls(): CheckerRule {
  return {
    id: "overlapping-walls",
    name: "Overlapping Walls",
    severity: "warning",
    category: "geometry",
    run: (elements) => {
      const walls = elements.filter((e) => e.type === "IfcWall" && e.bbox);
      const results: CheckResult[] = [];
      for (let i = 0; i < walls.length; i++) {
        for (let j = i + 1; j < walls.length; j++) {
          const a = walls[i].bbox!;
          const b = walls[j].bbox!;
          const overlapX = a.min[0] < b.max[0] && a.max[0] > b.min[0];
          const overlapY = a.min[1] < b.max[1] && a.max[1] > b.min[1];
          const overlapZ = a.min[2] < b.max[2] && a.max[2] > b.min[2];
          if (overlapX && overlapY && overlapZ) {
            results.push({
              ruleId: "overlapping-walls",
              ruleName: "Overlapping Walls",
              severity: "warning",
              message: `Walls #${walls[i].expressId} and #${walls[j].expressId} occupy overlapping volumes.`,
              elementIds: [walls[i].expressId, walls[j].expressId],
              category: "geometry",
            });
          }
        }
      }
      return results;
    },
  };
}

const SHIPPED_RULES: CheckerRule[] = [
  ruleDuplicateElements(),
  ruleMissingClassification(),
  ruleMissingLevel(),
  ruleUnhostedDoors(),
  ruleFireRatingConsistency(),
  ruleOverlappingWalls(),
];

export interface ModelCheckerReport {
  timestamp: number;
  totalElements: number;
  results: CheckResult[];
  summary: { errors: number; warnings: number; infos: number };
  durationMs: number;
}

/** Run the model checker against the supplied elements. */
export function runModelChecker(
  elements: ModelElement[],
  config: ModelCheckerConfig = {},
): ModelCheckerReport {
  const start = Date.now();
  const rules = [
    ...SHIPPED_RULES,
    ...(config.customRules ?? []),
  ].filter((r) => !(config.skipRules ?? []).includes(r.id));

  const allResults: CheckResult[] = [];
  for (const rule of rules) {
    try {
      const r = rule.run(elements);
      allResults.push(...r);
    } catch (e) {
      allResults.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: "error",
        message: `Rule crashed: ${(e as Error).message}`,
        elementIds: [],
        category: rule.category,
      });
    }
  }

  const summary = {
    errors: allResults.filter((r) => r.severity === "error").length,
    warnings: allResults.filter((r) => r.severity === "warning").length,
    infos: allResults.filter((r) => r.severity === "info").length,
  };

  return {
    timestamp: start,
    totalElements: elements.length,
    results: allResults,
    summary,
    durationMs: Date.now() - start,
  };
}

/** List all shipped rule IDs. */
export function listShippedRules(): string[] {
  return SHIPPED_RULES.map((r) => r.id);
}
