/**
 * Public re-exports for the standards subsystem.
 * All rule-related types live in `./rules/types` — this file only
 * re-exports them plus any standards-specific UI shapes.
 */

export type {
  Jurisdiction,
  Severity,
  Violation,
  RuleViolation,
  RuleCheckResult,
  RuleContext,
  Rule,
  RulePack,
  ProgressReporter,
} from "./rules/types";

export interface StandardsRunSummary {
  packCount: number;
  ruleCount: number;
  violations: number;
  errors: number;
  warnings: number;
  infos: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cancelled: boolean;
}

export interface StandardsRunResult {
  summary: StandardsRunSummary;
  violations: import("./rules/types").Violation[];
}