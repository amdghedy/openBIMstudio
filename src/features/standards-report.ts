/**
 * Combined coordination report: Clashes + Standards compliance.
 *
 * The report is a single self-contained HTML file with three tabs —
 * Summary, Clashes, Standards — so it can be emailed, embedded in a CDE,
 * or printed.
 */
import {
  listClashes,
  getClashState,
  testNameInput,
  type ClashStatus,
} from "./clash";
import { services, tryUse } from "../core/services";
import { getCurrentProject } from "../modules/projects/projects";

interface StandardsViolation {
  ruleId: string;
  ruleName: string;
  standard: string;
  jurisdiction: string;
  severity: "info" | "warning" | "error";
  category: string;
  elementId: number;
  elementName: string;
  elementCategory: string;
  message: string;
  actual?: string;
  required?: string;
}

interface StandardsSummary {
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

interface StandardsResult {
  summary: StandardsSummary;
  violations: StandardsViolation[];
}

const STATUS_COLOR: Record<ClashStatus, string> = {
  new: "#38bdf8",
  active: "#f59e0b",
  reviewed: "#c084fc",
  approved: "#22c55e",
  resolved: "#6b7280",
};

const KIND_COLOR: Record<string, string> = {
  intersect: "#ef4444",
  touching: "#f59e0b",
  clearance: "#38bdf8",
  duplicate: "#a855f7",
};

const SEV_COLOR: Record<string, string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#38bdf8",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

const fmtDate = (t: number) => new Date(t).toLocaleString();

function section(id: string, title: string): string {
  return `<h2 id="${id}">${esc(title)}</h2>`;
}

function clashTableHtml(): string {
  const rows = listClashes();
  if (!rows.length) {
    return `<p class="empty">No clash results in memory. Run a clash test, then re-export.</p>`;
  }
  let html =
    `<table><thead><tr>` +
    `<th>#</th><th>Kind</th><th>Status</th>` +
    `<th>Model A</th><th>Element A</th>` +
    `<th>Model B</th><th>Element B</th>` +
    `<th>Gap / Overlap</th><th>Method</th>` +
    `</tr></thead><tbody>`;
  rows.forEach((c, i) => {
    const st = getClashState(c);
    const gap =
      c.kind === "intersect" ? `${(c.depthVol * 1e6).toFixed(1)} cm³`
      : c.kind === "duplicate" ? `Identical (Δ ≤ ${(c.minGap * 1000).toFixed(1)} mm)`
      : `${(c.minGap * 1000).toFixed(1)} mm`;
    html +=
      `<tr>` +
      `<td>${i + 1}</td>` +
      `<td><span class="badge" style="background:${KIND_COLOR[c.kind] ?? "#666"};color:#fff">${c.kind}</span></td>` +
      `<td><span class="badge" style="background:${STATUS_COLOR[st.status]};color:#fff">${st.status}</span></td>` +
      `<td class="dim">${esc(c.a.modelId)}</td>` +
      `<td>${esc(c.a.name)}<br><span class="dim">${esc(c.a.cat)} · #${c.a.localId}</span></td>` +
      `<td class="dim">${esc(c.b.modelId)}</td>` +
      `<td>${esc(c.b.name)}<br><span class="dim">${esc(c.b.cat)} · #${c.b.localId}</span></td>` +
      `<td class="num">${gap}</td>` +
      `<td class="dim">${c.method}</td>` +
      `</tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

function standardsTableHtml(res: StandardsResult | null): string {
  if (!res) {
    return `<p class="empty">No standards run yet. Run a compliance check from the Standards panel, then re-export.</p>`;
  }
  if (!res.violations.length) {
    return `<p class="empty">No violations — the model passes all enabled rule packs.</p>`;
  }
  const grouped = new Map<string, StandardsViolation[]>();
  for (const v of res.violations) {
    const key = `${v.standard} · ${v.jurisdiction}`;
    const arr = grouped.get(key) ?? [];
    arr.push(v);
    grouped.set(key, arr);
  }
  let html = "";
  for (const [group, items] of grouped) {
    html += `<h3>${esc(group)} <span class="dim">(${items.length})</span></h3>`;
    html +=
      `<table><thead><tr>` +
      `<th>Severity</th><th>Rule</th><th>Category</th>` +
      `<th>Element</th><th>Message</th><th>Actual</th><th>Required</th>` +
      `</tr></thead><tbody>`;
    for (const v of items) {
      html +=
        `<tr>` +
        `<td><span class="badge" style="background:${SEV_COLOR[v.severity]};color:#fff">${v.severity}</span></td>` +
        `<td>${esc(v.ruleName)}<br><span class="dim">${esc(v.ruleId)}</span></td>` +
        `<td class="dim">${esc(v.category)}</td>` +
        `<td>${esc(v.elementName)}<br><span class="dim">${esc(v.elementCategory)} · #${v.elementId}</span></td>` +
        `<td>${esc(v.message)}</td>` +
        `<td class="dim">${esc(v.actual ?? "—")}</td>` +
        `<td class="dim">${esc(v.required ?? "—")}</td>` +
        `</tr>`;
    }
    html += `</tbody></table>`;
  }
  return html;
}

function summaryCards(res: StandardsResult | null): string {
  const clash = listClashes();
  const byStatus: Record<string, number> = { new: 0, active: 0, reviewed: 0, approved: 0, resolved: 0 };
  for (const c of clash) byStatus[getClashState(c).status]++;
  const card = (label: string, value: number | string, color = "#e8eaf0") =>
    `<div class="card"><div class="label">${esc(label)}</div>` +
    `<div class="value" style="color:${color}">${value}</div></div>`;

  let html = `<div class="cards">`;
  html += card("Total clashes", clash.length, "#38bdf8");
  html += card("New", byStatus.new, STATUS_COLOR.new);
  html += card("Active", byStatus.active, STATUS_COLOR.active);
  html += card("Reviewed", byStatus.reviewed, STATUS_COLOR.reviewed);
  html += card("Approved", byStatus.approved, STATUS_COLOR.approved);
  html += card("Resolved", byStatus.resolved, STATUS_COLOR.resolved);
  if (res) {
    html += card("Violations", res.summary.violations, "#ef4444");
    html += card("Errors", res.summary.errors, SEV_COLOR.error);
    html += card("Warnings", res.summary.warnings, SEV_COLOR.warning);
    html += card("Info", res.summary.infos, SEV_COLOR.info);
    html += card("Rule packs", res.summary.packCount);
    html += card("Rules run", res.summary.ruleCount);
    html += card("Duration", `${(res.summary.durationMs / 1000).toFixed(2)} s`);
  }
  html += `</div>`;
  return html;
}

export function buildCoordinationReportHtml(standards: StandardsResult | null): string {
  const project = getCurrentProject();
  const testName = testNameInput.value || "Clash Test";
  const reportTitle = standards
    ? `${testName} + Standards Compliance`
    : testName;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(reportTitle)} — Coordination Report</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui,-apple-system,"Segoe UI",Arial,sans-serif;
         background:#f5f6f8; color:#1a1d23; margin:0; padding:28px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; margin:26px 0 10px; color:#3d4250;
       border-bottom:1px solid #d5d8de; padding-bottom:6px; }
  h3 { font-size:13px; margin:18px 0 8px; color:#4b5563; }
  .meta { color:#6b7280; font-size:12px; margin-bottom:20px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid #d5d8de; margin-bottom:18px; }
  .tab { padding:8px 16px; font:600 12px system-ui; cursor:pointer;
         border:1px solid transparent; border-bottom:none; border-radius:6px 6px 0 0;
         background:transparent; color:#6b7280; }
  .tab.active { background:#fff; border-color:#d5d8de; color:#1a1d23; margin-bottom:-1px; }
  .panel { display:none; }
  .panel.active { display:block; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
           gap:10px; margin-bottom:18px; }
  .card { background:#fff; border:1px solid #e3e6ea; border-radius:8px;
          padding:10px 12px; }
  .card .label { font-size:10px; text-transform:uppercase; letter-spacing:.6px;
                 color:#6b7280; }
  .card .value { font-size:22px; font-weight:700; margin-top:2px;
                 font-family:ui-monospace,SFMono-Regular,monospace; }
  table { width:100%; border-collapse:collapse; background:#fff;
          border:1px solid #e3e6ea; border-radius:8px; overflow:hidden;
          font-size:11px; margin-bottom:14px; }
  th { background:#f0f2f5; text-align:left; padding:8px 10px;
       font-size:10px; font-weight:600; text-transform:uppercase;
       letter-spacing:.4px; color:#4b5563; border-bottom:1px solid #e3e6ea;
       white-space:nowrap; }
  td { padding:7px 10px; border-bottom:1px solid #eef0f3; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:#fafbfc; }
  .badge { display:inline-block; padding:2px 7px; border-radius:3px;
           font-size:9px; font-weight:700; letter-spacing:.3px;
           text-transform:uppercase; }
  .num { text-align:right; font-family:ui-monospace,monospace; }
  .dim { color:#9ca3af; font-size:10px; }
  .empty { padding:20px; color:#9ca3af; text-align:center; background:#fff;
           border:1px dashed #d5d8de; border-radius:8px; font-size:12px; }
  .footer { margin-top:40px; color:#9ca3af; font-size:10px; text-align:center; }
  @media print {
    body { padding:0; background:#fff; }
    .tabs { display:none; }
    .panel { display:block !important; page-break-before: always; }
    .panel:first-of-type { page-break-before: auto; }
  }
</style>
</head>
<body>
<h1>${esc(reportTitle)}</h1>
<div class="meta">
  ${project ? `Project: <b>${esc(project.name)}</b> · ` : ""}
  Generated: ${fmtDate(Date.now())}
</div>

<div class="tabs" role="tablist">
  <button class="tab active" data-tab="summary">Summary</button>
  <button class="tab" data-tab="clashes">Clashes (${listClashes().length})</button>
  <button class="tab" data-tab="standards">Standards${
    standards ? ` (${standards.violations.length})` : ""
  }</button>
</div>

<div class="panel active" data-panel="summary">
  ${summaryCards(standards)}
  ${standards ? `<h2>Standards run</h2>
    <table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td>Rule packs</td><td class="num">${standards.summary.packCount}</td></tr>
    <tr><td>Rules evaluated</td><td class="num">${standards.summary.ruleCount}</td></tr>
    <tr><td>Violations</td><td class="num">${standards.summary.violations}</td></tr>
    <tr><td>Errors</td><td class="num">${standards.summary.errors}</td></tr>
    <tr><td>Warnings</td><td class="num">${standards.summary.warnings}</td></tr>
    <tr><td>Info</td><td class="num">${standards.summary.infos}</td></tr>
    <tr><td>Duration</td><td class="num">${(standards.summary.durationMs / 1000).toFixed(2)} s</td></tr>
    <tr><td>Cancelled</td><td class="num">${standards.summary.cancelled ? "yes" : "no"}</td></tr>
    </tbody></table>` : ""}
</div>

<div class="panel" data-panel="clashes">
  ${section("clashes", "Clashes")}
  ${clashTableHtml()}
</div>

<div class="panel" data-panel="standards">
  ${section("standards", "Standards compliance")}
  ${standardsTableHtml(standards)}
</div>

<div class="footer">
  Open BIM Studio · coordination report · ${fmtDate(Date.now())}
</div>

<script>
(function () {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    t.classList.add("active");
    document.querySelector('[data-panel="' + t.dataset.tab + '"]')?.classList.add("active");
  }));
})();
</script>
</body></html>`;
}

/** Run a fresh standards check (uses whatever is enabled in the panel), then
 *  return the report HTML. Used by the export / preview actions. */
export async function runStandardsForReport(): Promise<StandardsResult | null> {
  const svc = tryUse("standards");
  if (!svc) return null;
  try {
    const res = await svc.run();
    return res as StandardsResult;
  } catch (err) {
    console.warn("[standards-report] run failed", err);
    return null;
  }
}

/* ── Export actions ─────────────────────────────────────────────────────── */

function triggerDownload(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export async function exportCoordinationReportHtml(): Promise<void> {
  const hasClash = listClashes().length > 0;
  const standards = hasClash || tryUse("standards") ? await runStandardsForReport() : null;
  const html = buildCoordinationReportHtml(standards);
  triggerDownload(html, `coordination-report-${new Date().toISOString().slice(0, 10)}.html`);
}

export async function previewCoordinationReportHtml(): Promise<void> {
  const standards = tryUse("standards") ? await runStandardsForReport() : null;
  const html = buildCoordinationReportHtml(standards);
  const w = window.open("", "_blank");
  if (!w) { alert("Popup blocked — allow popups to preview."); return; }
  w.document.write(html);
  w.document.close();
}

export function setupStandardsReport(): void {
  // Nothing to install at runtime — commands are registered by the
  // command palette bootstrap. Kept for symmetry with the other features.
  services.tryUse("standards");  // touch — no-op if absent
  console.log("[standards-report] ready");
}