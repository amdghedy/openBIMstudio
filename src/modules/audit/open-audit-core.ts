/**
 * Open-standards audit — pure core (differentiation item 5).
 *
 * No DOM, no ctx, no engine imports: this file converts IDS results into
 * BCF standards violations and shapes the audit report, so it is unit
 * tested in Node against the real IDS parser and the real clash core.
 * The browser orchestration (running the engines, the panel, the palette
 * command) lives in ./open-audit.ts.
 */
import type { IdsCheckResult, IdsDocument, IdsRunReport } from "../../features/ids";
import type { BcfStandardsViolation } from "../export/bcf21";
import type { ElementClash } from "../../features/clash-engine";
import type { ClashGroup } from "../clash/grouping";

export type AuditFindingSource = "ids" | "clash";
export type AuditSeverity = "error" | "warning" | "info";

export interface AuditFinding {
  source: AuditFindingSource;
  severity: AuditSeverity;
  title: string;
  detail: string;
  modelId?: string;
  elementId?: string | number;
}

export interface AuditIdsSection {
  status: "run" | "skipped";
  reason?: string;
  documentTitle?: string;
  specifications?: number;
  elementsChecked?: number;
  passed?: number;
  failed?: number;
  unsupported?: number;
}

export interface AuditClashSection {
  status: "run" | "skipped";
  reason?: string;
  /** Models (fragments + the authored set) fed to the engine. */
  modelsChecked?: number;
  found?: number;
  groups?: number;
  byKind?: Record<string, number>;
}

export interface AuditBcfSection {
  topicCount: number;
  filename?: string;
  /** Byte size of the built .bcfzip, when the BCF was built. */
  bytes?: number;
}

export interface OpenAuditReport {
  startedAt: number;
  finishedAt: number;
  ids: AuditIdsSection;
  clash: AuditClashSection;
  bcf: AuditBcfSection;
  findings: AuditFinding[];
}

/**
 * One failed IDS check → one BCF standards violation.
 * Only "fail" becomes a topic. "pass" is not an issue, and "warning" /
 * "unsupported" are the engine's way of saying a check could not be
 * evaluated (the only warning checkRequirement emits is "Cannot read
 * properties for this element — check skipped") — issuing a BCF topic
 * for an unevaluated check would be a fake finding. Warnings are still
 * listed in the report findings; they just never become BCF topics.
 */
export function idsCheckToViolation(
  result: IdsCheckResult,
  doc: IdsDocument,
): BcfStandardsViolation | null {
  if (result.severity !== "fail") return null;
  return {
    ruleId: result.specificationId,
    ruleName: result.specificationName,
    standard: "IDS",
    jurisdiction: doc.title ? `${doc.title}${doc.version ? ` v${doc.version}` : ""}` : "Untitled IDS",
    severity: "error",
    category: result.facet,
    elementId: result.localId,
    elementName: result.elementName,
    elementCategory: result.facet,
    message: result.message,
    actual: result.actual,
    required: result.facet,
    modelId: result.modelId,
  };
}

/** Every failed IDS check in a run, as BCF violations. */
export function idsReportToViolations(report: IdsRunReport): BcfStandardsViolation[] {
  const out: BcfStandardsViolation[] = [];
  for (const r of report.results) {
    const v = idsCheckToViolation(r, report.document);
    if (v) out.push(v);
  }
  return out;
}

/** Unified findings list: IDS failures first (errors before warnings), then clashes. */
export function buildAuditFindings(
  idsReport: IdsRunReport | null,
  clashes: readonly ElementClash[],
  groups: readonly ClashGroup[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (idsReport) {
    for (const r of idsReport.results) {
      if (r.severity === "pass" || r.severity === "unsupported") continue;
      findings.push({
        source: "ids",
        severity: r.severity === "fail" ? "error" : "warning",
        title: `${r.specificationName} — ${r.elementName}`,
        detail: `${r.facet}: ${r.message}${r.actual ? ` (actual: ${r.actual})` : ""}`,
        modelId: r.modelId,
        elementId: r.localId,
      });
    }
  }
  for (const g of groups) {
    const head = g.members[0];
    if (!head) continue;
    findings.push({
      source: "clash",
      severity: head.kind === "intersect" ? "error" : "warning",
      title: `[${head.kind.toUpperCase()}] ${head.a.name} × ${head.b.name}`,
      detail: g.members.length > 1
        ? `${g.members.length} clashes on the same elements — showing the first`
        : `${head.a.name} [${head.a.cat}] × ${head.b.name} [${head.b.cat}]`,
      modelId: head.a.modelId,
      elementId: head.a.localId,
    });
  }
  // Any clash outside the groups (should not happen — groupClashes covers
  // every clash — but never silently drop one from the report).
  const grouped = new Set(groups.flatMap((g) => g.members));
  for (const c of clashes) {
    if (grouped.has(c)) continue;
    findings.push({
      source: "clash",
      severity: c.kind === "intersect" ? "error" : "warning",
      title: `[${c.kind.toUpperCase()}] ${c.a.name} × ${c.b.name}`,
      detail: `${c.a.name} [${c.a.cat}] × ${c.b.name} [${c.b.cat}]`,
      modelId: c.a.modelId,
      elementId: c.a.localId,
    });
  }
  return findings;
}

export function summarizeIdsSection(report: IdsRunReport): AuditIdsSection {
  const failed = report.summary.reduce((n, s) => n + s.failed, 0);
  const passed = report.summary.reduce((n, s) => n + s.passed, 0);
  const unsupported = report.summary.reduce((n, s) => n + s.unsupported, 0);
  return {
    status: "run",
    documentTitle: report.document.title ?? "Untitled IDS",
    specifications: report.document.specifications.length,
    elementsChecked: report.elementsChecked,
    passed,
    failed,
    unsupported,
  };
}

export function summarizeClashSection(
  clashes: readonly ElementClash[],
  groups: readonly ClashGroup[],
  modelsChecked: number,
): AuditClashSection {
  const byKind: Record<string, number> = {};
  for (const c of clashes) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  return {
    status: "run",
    modelsChecked,
    found: clashes.length,
    groups: groups.length,
    byKind,
  };
}
