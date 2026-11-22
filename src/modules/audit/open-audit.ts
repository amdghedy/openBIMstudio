/**
 * Open-standards audit — one-click IDS + clash + BCF pass (differentiation item 5).
 *
 * The three engines already exist and are real; what was missing was the
 * single audited pass that runs them together and hands every finding
 * back as a BCF issue. This module is that pass:
 *
 *   1. IDS — validates the currently loaded IDS document (IDS panel) over
 *      every imported IFC model. No document loaded → the section is
 *      SKIPPED with the reason stated, never silently passed. Authored
 *      (native) elements are not covered: runIdsValidation reads
 *      ctx.fragments only, so the report says so instead of pretending.
 *   2. Clash — all-vs-all over every imported model plus every authored
 *      element, with the live clash rules (tolerance/clearance/method)
 *      from the clash service when available.
 *   3. BCF — every clash and every FAILED IDS check becomes a
 *      BCF 2.1 topic through the shared writers (clashToTopic,
 *      standardsViolationToTopic, buildBcf21). Warnings/unverifiable
 *      checks are listed in the report, never issued as topics — a
 *      topic must mean a violation that was actually established.
 *
 * Everything runs locally in the browser: no server, no key, no upload.
 */
import { ctx } from "../../core/context";
import { services } from "../../core/services";
import { registerCommand } from "../../features/command-palette";
import { escapeHtml } from "../../core/html-escape";
import { notify } from "../../core/notify";
import {
  runIdsValidation,
  parseIdsXml,
  type IdsDocument,
  type IdsRunReport,
} from "../../features/ids";
import { getCurrentIdsDocument } from "../../features/ids-panel";
import { runClashOffThread } from "../../features/clash-worker-client";
import type { ClashInput } from "../../features/clash-engine";
import { groupClashes } from "../clash/grouping";
import {
  clashToTopic,
  standardsViolationToTopic,
  buildBcf21,
  type BcfTopic,
} from "../export/bcf21";
import {
  buildAuditFindings,
  idsReportToViolations,
  summarizeClashSection,
  summarizeIdsSection,
  type OpenAuditReport,
} from "./open-audit-core";

export type { OpenAuditReport };

let lastReport: OpenAuditReport | null = null;
let lastBcfBlob: Blob | null = null;
let lastBcfFilename = "coordination.bcfzip";

export function getLastAuditReport(): OpenAuditReport | null {
  return lastReport;
}

export interface RunOpenAuditOptions {
  /** IDS XML to validate. When omitted, the IDS panel's loaded document is used. */
  idsXml?: string;
  /** Override the clash rules (default: the live clash service rules). */
  tolerance?: number;
  clearance?: number;
  onProgress?: (phase: string, current: number, total: number) => void;
}

export async function runOpenAudit(opts: RunOpenAuditOptions = {}): Promise<OpenAuditReport> {
  const startedAt = Date.now();
  const progress = opts.onProgress ?? (() => {});

  /* ── 1. IDS ─────────────────────────────────────────────────────── */
  let idsReport: IdsRunReport | null = null;
  let idsDoc: IdsDocument | null = null;
  let idsSkippedReason: string | undefined;
  try {
    if (opts.idsXml) {
      idsDoc = parseIdsXml(opts.idsXml);
    } else {
      idsDoc = getCurrentIdsDocument();
    }
    if (!idsDoc) {
      idsSkippedReason = "No IDS document loaded — open the IDS panel and load an .ids file to check rules.";
    } else if (!ctx.fragments.list.size) {
      idsSkippedReason = "No imported IFC model to check — IDS validation reads imported models only; authored elements are not covered.";
    } else {
      progress("ids", 0, 3);
      idsReport = await runIdsValidation(idsDoc);
    }
  } catch (e) {
    idsSkippedReason = `IDS validation failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  /* ── 2. Clash, all-vs-all ───────────────────────────────────────── */
  const fragmentModels = Array.from(ctx.fragments.list.entries()) as Array<[string, any]>;
  const authoredEls: Array<{ id: string }> =
    (ctx.features as any).authoring?.getElements?.() ?? [];
  let clashes: Awaited<ReturnType<typeof runClashOffThread>> = [];
  let clashSkippedReason: string | undefined;
  let modelsChecked = 0;
  try {
    if (!fragmentModels.length && !authoredEls.length) {
      clashSkippedReason = "Nothing to clash — load a model or model something first.";
    } else {
      const inputs: ClashInput[] = fragmentModels.map(([modelId, model]) => ({
        modelId,
        model,
        allowedIds: "ALL",
      }));
      const clashSvc = services.tryUse("clash");
      const rules = {
        tolerance: opts.tolerance ?? clashSvc?.getRules?.().tolerance ?? 0,
        clearance: opts.clearance ?? clashSvc?.getRules?.().clearance ?? 0,
      };
      const method = clashSvc?.getMethod?.() ?? "hard-triangle";
      const authored = authoredEls.length ? { allowed: "ALL" as const } : null;
      modelsChecked = inputs.length + (authored ? 1 : 0);
      progress("clash", 1, 3);
      clashes = await runClashOffThread(inputs, {
        rules,
        method,
        allowSelfPairs: true,
        useSides: false,
        authored,
        onProgress: (p) => progress("clash", 1, 3 + Math.max(0, p.total)),
      });
    }
  } catch (e) {
    clashSkippedReason = `Clash run failed: ${e instanceof Error ? e.message : String(e)}`;
    clashes = [];
  }

  /* ── 3. BCF — one topic per finding ─────────────────────────────── */
  const groups = groupClashes(clashes, { preferLargerHead: false });
  const violations = idsReport ? idsReportToViolations(idsReport) : [];
  const topics: BcfTopic[] = [];
  clashes.forEach((c, i) => topics.push(clashToTopic(c, i, {})));
  violations.forEach((v, i) => topics.push(standardsViolationToTopic(v, i, {})));
  let bcfBytes: number | undefined;
  let bcfFilename: string | undefined;
  if (topics.length) {
    progress("bcf", 2, 3);
    const built = await buildBcf21(topics, { projectName: "Open-standards audit" });
    lastBcfBlob = built.blob;
    lastBcfFilename = built.filename;
    bcfBytes = built.blob.size;
    bcfFilename = built.filename;
  } else {
    lastBcfBlob = null;
  }

  const report: OpenAuditReport = {
    startedAt,
    finishedAt: Date.now(),
    ids: idsReport
      ? summarizeIdsSection(idsReport)
      : { status: "skipped", reason: idsSkippedReason ?? "IDS did not run." },
    clash: clashSkippedReason
      ? { status: "skipped", reason: clashSkippedReason }
      : summarizeClashSection(clashes, groups, modelsChecked),
    bcf: { topicCount: topics.length, bytes: bcfBytes, filename: bcfFilename },
    findings: buildAuditFindings(idsReport, clashes, groups),
  };
  lastReport = report;
  return report;
}

/* ── Report panel ─────────────────────────────────────────────────── */

let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;

function ensurePanel(): void {
  if (panelEl && bodyEl) return;
  panelEl = document.createElement("div");
  panelEl.id = "obs-open-audit";
  panelEl.style.cssText =
    "position:absolute;left:400px;top:90px;right:14px;bottom:60px;z-index:34;display:none;flex-direction:column;background:var(--bg-surface,#12141b);border:1px solid var(--border-default,#2a2e3a);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0);overflow:hidden";
  panelEl.addEventListener("mousedown", (e) => e.stopPropagation());
  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23)";
  header.innerHTML =
    `<b>Open-standards audit</b><span style="opacity:.6">IDS + clash → BCF, entirely local</span>` +
    `<span style="flex:1"></span><button data-x style="cursor:pointer">✕</button>`;
  header.querySelector("[data-x]")?.addEventListener("click", () => { if (panelEl) panelEl.style.display = "none"; });
  bodyEl = document.createElement("div");
  bodyEl.style.cssText = "flex:1;overflow:auto;padding:12px";
  panelEl.append(header, bodyEl);
  document.body.appendChild(panelEl);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function showAuditReport(report: OpenAuditReport): void {
  ensurePanel();
  if (!panelEl || !bodyEl) return;
  const secs = ((report.finishedAt - report.startedAt) / 1000).toFixed(1);
  const ids = report.ids;
  const clash = report.clash;
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.filter((f) => f.severity === "warning").length;
  const shown = report.findings.slice(0, 100);
  bodyEl.innerHTML =
    `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">` +
    `<div><b>IDS</b><br>${ids.status === "run"
      ? `${escapeHtml(ids.documentTitle ?? "")} · ${ids.specifications} spec(s) · ${ids.elementsChecked} element(s) — <span style="color:#86efac">${ids.passed} passed</span> · <span style="color:#fca5a5">${ids.failed} failed</span> · ${ids.unsupported} unverifiable`
      : `<span style="color:#fbbf24">Skipped</span> — ${escapeHtml(ids.reason ?? "")}`}</div>` +
    `<div><b>Clash</b><br>${clash.status === "run"
      ? `${clash.modelsChecked} model(s) · <span style="color:${(clash.found ?? 0) ? "#fca5a5" : "#86efac"}">${clash.found} clash(es)</span> in ${clash.groups} group(s)` +
        (clash.byKind ? ` (${Object.entries(clash.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})` : "")
      : `<span style="color:#fbbf24">Skipped</span> — ${escapeHtml(clash.reason ?? "")}`}</div>` +
    `<div><b>BCF</b><br>${report.bcf.topicCount} topic(s)${report.bcf.bytes ? ` · ${(report.bcf.bytes / 1024).toFixed(1)} KB` : ""}</div>` +
    `<div><b>Result</b><br>${errors} error(s) · ${warnings} warning(s) · ${secs}s</div>` +
    `</div>` +
    `<div style="display:flex;gap:8px;margin-bottom:10px">` +
    `<button data-bcf ${report.bcf.topicCount ? "" : "disabled"} style="cursor:pointer">Download BCF (.bcfzip)</button>` +
    `<button data-json style="cursor:pointer">Download report (.json)</button>` +
    `</div>` +
    (report.findings.length
      ? `<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:start;padding:4px;border-bottom:1px solid #2a2e3a">Severity</th><th style="text-align:start;padding:4px;border-bottom:1px solid #2a2e3a">Source</th><th style="text-align:start;padding:4px;border-bottom:1px solid #2a2e3a">Finding</th><th style="text-align:start;padding:4px;border-bottom:1px solid #2a2e3a">Detail</th></tr></thead><tbody>` +
        shown.map((f) =>
          `<tr><td style="padding:4px;color:${f.severity === "error" ? "#fca5a5" : "#fbbf24"}">${f.severity}</td><td style="padding:4px">${f.source}</td><td style="padding:4px">${escapeHtml(f.title)}</td><td style="padding:4px;opacity:.8">${escapeHtml(f.detail)}</td></tr>`).join("") +
        `</tbody></table>` +
        (report.findings.length > 100 ? `<div style="margin-top:8px;opacity:.55">Showing 100 of ${report.findings.length} findings. Download the JSON report for the full list.</div>` : "")
      : `<div style="opacity:.7">No findings — the model passed everything the audit could check. (Sections marked "Skipped" were not checked; see above.)</div>`);
  bodyEl.querySelector("[data-bcf]")?.addEventListener("click", () => {
    if (lastBcfBlob) downloadBlob(lastBcfBlob, lastBcfFilename);
  });
  bodyEl.querySelector("[data-json]")?.addEventListener("click", () => {
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), "open-standards-audit.json");
  });
  panelEl.style.display = "flex";
}

export function showAuditRunning(phase: string): void {
  ensurePanel();
  if (!panelEl || !bodyEl) return;
  bodyEl.innerHTML = `<div style="padding:24px;opacity:.8">Running open-standards audit… ${escapeHtml(phase)}</div>`;
  panelEl.style.display = "flex";
}

/* ── Setup ────────────────────────────────────────────────────────── */

export function setupOpenAudit(): void {
  registerCommand({
    id: "audit-open-standards",
    label: "Audit: run open-standards audit (IDS + clash → BCF)",
    category: "Audit",
    run: async () => {
      showAuditRunning("starting…");
      try {
        const report = await runOpenAudit({
          onProgress: (phase) => showAuditRunning(phase === "ids" ? "checking IDS rules…" : phase === "clash" ? "running clash detection…" : "building BCF issues…"),
        });
        showAuditReport(report);
        notify("info", `Audit done: ${report.findings.length} finding(s), ${report.bcf.topicCount} BCF topic(s).`);
      } catch (e) {
        notify("error", `Audit failed: ${e instanceof Error ? e.message : String(e)}`);
        if (panelEl) panelEl.style.display = "none";
      }
    },
  });
  (ctx.features as any).openAudit = {
    runOpenAudit,
    getLastAuditReport,
    showAuditReport,
  };
}
