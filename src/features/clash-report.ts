/**
 * Clash report export: rich HTML and Excel (XLS via HTML table).
 *
 * Both read the currently active clash run from clash.ts and produce a
 * self-contained document with summary, per-status breakdown, and a full
 * clash table with comments.
 */
import { ctx } from "../core/context";
import {
  listClashes,
  testNameInput,
  getClashState,
  type ClashStatus,
} from "./clash";
import { getCurrentProject } from "../modules/projects/projects";

/* ═════════════════════════════════════════════════════════════════════════
   Shared data extraction
   ═════════════════════════════════════════════════════════════════════════ */

interface Row {
  index: number;
  kind: string;
  status: ClashStatus;
  modelA: string;
  idA: number;
  nameA: string;
  catA: string;
  modelB: string;
  idB: number;
  nameB: string;
  catB: string;
  depthVol: number;   // m³
  minGap: number;     // m
  precision: string;
  triPairs: number;
  comments: { author: string; date: number; text: string }[];
}

function collectRows(): Row[] {
  const clashes = listClashes();
  const out: Row[] = [];
  for (let i = 0; i < clashes.length; i++) {
    const c = clashes[i];
    const s = getClashState(c);
    out.push({
      index: i + 1,
      kind: c.kind,
      status: s.status,
      modelA: c.a.modelId,
      idA: c.a.localId,
      nameA: c.a.name,
      catA: c.a.cat,
      modelB: c.b.modelId,
      idB: c.b.localId,
      nameB: c.b.name,
      catB: c.b.cat,
      depthVol: c.depthVol,
      minGap: c.minGap,
      precision: c.precision,
      triPairs: c.triPairs,
      comments: s.comments.map((cm) => ({
        author: cm.author,
        date: cm.date,
        text: cm.text,
      })),
    });
  }
  return out;
}

function summarize(rows: Row[]) {
  const byStatus: Record<ClashStatus, number> = {
    new: 0, active: 0, reviewed: 0, approved: 0, resolved: 0,
  };
  const byKind: Record<string, number> = { intersect: 0, touching: 0, clearance: 0 };
  for (const r of rows) {
    byStatus[r.status]++;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }
  return { byStatus, byKind, total: rows.length };
}

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

const fmtDate = (t: number) => new Date(t).toLocaleString();

/* ═════════════════════════════════════════════════════════════════════════
   HTML report
   ═════════════════════════════════════════════════════════════════════════ */

export function buildClashReportHtml(): string {
  const rows = collectRows();
  const summary = summarize(rows);
  const project = getCurrentProject();
  const testName = testNameInput.value || "Clash Test";

  const statusColor: Record<ClashStatus, string> = {
    new: "#38BDF8",
    active: "#F59E0B",
    reviewed: "#C084FC",
    approved: "#22C55E",
    resolved: "#6B7280",
  };

  const kindColor: Record<string, string> = {
    intersect: "#EF4444",
    touching: "#F59E0B",
    clearance: "#38BDF8",
  };

  let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Clash Report — ${esc(testName)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
         background: #f5f6f8; color: #1a1d23; margin: 0; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 32px 0 10px; color: #3d4250;
       border-bottom: 1px solid #d5d8de; padding-bottom: 6px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr));
           gap: 12px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px;
          padding: 12px 14px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .card .label { font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
                 color: #6b7280; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 4px;
                 font-family: ui-monospace, SFMono-Regular, monospace; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          border: 1px solid #e3e6ea; border-radius: 8px; overflow: hidden;
          font-size: 11px; }
  th { background: #f0f2f5; text-align: left; padding: 8px 10px;
       font-size: 10px; font-weight: 600; text-transform: uppercase;
       letter-spacing: .4px; color: #4b5563; border-bottom: 1px solid #e3e6ea;
       white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafbfc; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 3px;
           font-size: 9px; font-weight: 700; letter-spacing: .3px;
           text-transform: uppercase; }
  .num { text-align: right; font-family: ui-monospace, monospace; }
  .comment { border-left: 2px solid #e5e7eb; padding: 3px 8px; margin: 3px 0;
             background: #f9fafb; font-size: 10px; color: #4b5563; }
  .footer { margin-top: 40px; color: #9ca3af; font-size: 10px; text-align: center; }
  @media print {
    body { padding: 0; background: #fff; }
    .card, table { box-shadow: none; }
  }
</style>
</head>
<body>
<h1>${esc(testName)} — Clash Report</h1>
<div class="meta">
  ${project ? `Project: <b>${esc(project.name)}</b> · ` : ""}
  Generated: ${fmtDate(Date.now())} ·
  ${summary.total} clash${summary.total === 1 ? "" : "es"}
</div>

<div class="cards">
  <div class="card"><div class="label">Total</div><div class="value">${summary.total}</div></div>`;

  for (const s of ["new", "active", "reviewed", "approved", "resolved"] as ClashStatus[]) {
    html += `<div class="card"><div class="label" style="color:${statusColor[s]}">${s}</div>
             <div class="value" style="color:${statusColor[s]}">${summary.byStatus[s]}</div></div>`;
  }
  for (const k of ["intersect", "touching", "clearance"]) {
    html += `<div class="card"><div class="label" style="color:${kindColor[k]}">${k}</div>
             <div class="value" style="color:${kindColor[k]}">${summary.byKind[k] ?? 0}</div></div>`;
  }

  html += `</div>

<h2>Clashes</h2>
<table>
<thead><tr>
  <th>#</th><th>Kind</th><th>Status</th>
  <th>Model A</th><th>Element A</th>
  <th>Model B</th><th>Element B</th>
  <th>Gap / Overlap</th><th>Precision</th><th>Comments</th>
</tr></thead>
<tbody>`;

  if (!rows.length) {
    html += `<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:20px">
             No clashes. Run a test first.</td></tr>`;
  } else {
    for (const r of rows) {
      const gapText = r.kind === "intersect"
        ? `${(r.depthVol * 1e6).toFixed(1)} cm³`
        : `${(r.minGap * 1000).toFixed(1)} mm`;
      const cmt = r.comments.length
        ? r.comments.map((c) =>
            `<div class="comment"><b>${esc(c.author)}</b> · ${fmtDate(c.date)}<br/>${esc(c.text)}</div>`,
          ).join("")
        : `<span style="color:#9ca3af">—</span>`;

      html += `<tr>
        <td>${r.index}</td>
        <td><span class="badge" style="background:${kindColor[r.kind]};color:#fff">${r.kind}</span></td>
        <td><span class="badge" style="background:${statusColor[r.status]};color:#fff">${r.status}</span></td>
        <td style="color:#6b7280;font-size:10px">${esc(r.modelA)}</td>
        <td>${esc(r.nameA)}<br/><span style="color:#9ca3af;font-size:10px">${esc(r.catA)} · #${r.idA}</span></td>
        <td style="color:#6b7280;font-size:10px">${esc(r.modelB)}</td>
        <td>${esc(r.nameB)}<br/><span style="color:#9ca3af;font-size:10px">${esc(r.catB)} · #${r.idB}</span></td>
        <td class="num">${gapText}</td>
        <td style="font-size:10px;color:#6b7280">${r.precision}${r.triPairs ? ` · ${r.triPairs} pairs` : ""}</td>
        <td>${cmt}</td>
      </tr>`;
    }
  }

  html += `</tbody></table>

<div class="footer">
  Open BIM Studio · Clash Detective report · generated ${fmtDate(Date.now())}
</div>
</body></html>`;

  return html;
}

/* ═════════════════════════════════════════════════════════════════════════
   Public: HTML download
   ═════════════════════════════════════════════════════════════════════════ */

export function exportClashReportHtml(): void {
  const rows = collectRows();
  if (!rows.length) {
    alert("No clashes to report. Run a test first.");
    return;
  }
  const html = buildClashReportHtml();
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `clash-report-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/** Open the HTML report in a new tab, for previewing / printing. */
export function previewClashReportHtml(): void {
  const rows = collectRows();
  if (!rows.length) {
    alert("No clashes to report. Run a test first.");
    return;
  }
  const html = buildClashReportHtml();
  const w = window.open("", "_blank");
  if (!w) {
    alert("Popup blocked — allow popups to preview.");
    return;
  }
  w.document.write(html);
  w.document.close();
}

/* ═════════════════════════════════════════════════════════════════════════
   Excel (XLS via HTML table — opens natively in Excel / Numbers / LibreOffice)
   ═════════════════════════════════════════════════════════════════════════ */

export function exportClashReportXls(): void {
  const rows = collectRows();
  if (!rows.length) {
    alert("No clashes to report. Run a test first.");
    return;
  }
  const summary = summarize(rows);
  const project = getCurrentProject();
  const testName = testNameInput.value || "Clash Test";

  let html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Clashes</x:Name><x:WorksheetOptions><x:DisplayGridlines/>
</x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
</head><body>
<table border="1" cellspacing="0" cellpadding="4" style="font-family:Arial;font-size:11px">
<tr><td colspan="10" style="font-size:14px;font-weight:bold">${esc(testName)} — Clash Report</td></tr>
<tr><td colspan="10">${project ? `Project: ${esc(project.name)}` : ""} · Generated: ${fmtDate(Date.now())}</td></tr>
<tr><td colspan="10">Total: ${summary.total} · New: ${summary.byStatus.new} · Active: ${summary.byStatus.active} · Reviewed: ${summary.byStatus.reviewed} · Approved: ${summary.byStatus.approved} · Resolved: ${summary.byStatus.resolved}</td></tr>
<tr></tr>
<tr style="background:#e8ebef;font-weight:bold">
  <td>#</td><td>Kind</td><td>Status</td>
  <td>Model A</td><td>Element A</td><td>Category A</td>
  <td>Model B</td><td>Element B</td><td>Category B</td>
  <td>Gap (mm) / Overlap (cm3)</td>
</tr>`;

  for (const r of rows) {
    const gapText = r.kind === "intersect"
      ? `${(r.depthVol * 1e6).toFixed(2)} cm³`
      : `${(r.minGap * 1000).toFixed(2)} mm`;
    html += `<tr>
      <td>${r.index}</td>
      <td>${r.kind}</td>
      <td>${r.status}</td>
      <td>${esc(r.modelA)}</td>
      <td>${esc(r.nameA)}</td>
      <td>${esc(r.catA)}</td>
      <td>${esc(r.modelB)}</td>
      <td>${esc(r.nameB)}</td>
      <td>${esc(r.catB)}</td>
      <td>${gapText}</td>
    </tr>`;
  }

  html += `</table></body></html>`;

  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `clash-report-${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}