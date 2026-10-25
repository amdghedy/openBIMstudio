/** IDS validation floating panel. */
import { escapeHtml } from "../core/html-escape";
import { ctx } from "../core/context";
import {
  parseIdsXml,
  runIdsValidation,
  exportIdsReportCsv,
  getLastReport,
  clearLastReport,
  type IdsDocument,
  type IdsRunReport,
  type IdsSeverity,
} from "./ids";

const panel = document.createElement("div");
panel.style.cssText =
  "position:absolute;left:400px;top:90px;right:14px;bottom:60px;z-index:34;display:none;flex-direction:column;background:var(--bg-surface,#12141b);border:1px solid var(--border-default,#2a2e3a);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0);overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23)";

const body = document.createElement("div");
body.style.cssText = "flex:1;overflow:auto;padding:12px";

panel.append(header, body);

const BTN = (primary = false) =>
  "padding:6px 12px;font:500 11px system-ui;background:" +
  (primary ? "var(--accent,#38bdf8);color:#0b0d12;border:none" : "var(--bg-hover,#232633);color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a)") +
  ";border-radius:6px;cursor:pointer";

let currentDoc: IdsDocument | null = null;
let currentReport: IdsRunReport | null = null;
let activeFilter: IdsSeverity | "all" = "all";

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".ids,.xml";
fileInput.style.display = "none";

function renderHeader() {
  header.innerHTML = "";
  const title = document.createElement("div");
  title.textContent = "🛡 IDS Validation";
  title.style.cssText = "font-weight:700;flex:1";
  header.append(title);

  const pick = document.createElement("button");
  pick.textContent = "📂 Open .ids";
  pick.style.cssText = BTN();
  pick.onclick = () => fileInput.click();
  header.appendChild(pick);

  const run = document.createElement("button");
  run.textContent = "▶ Run";
  run.style.cssText = BTN(true);
  run.disabled = !currentDoc;
  run.style.opacity = currentDoc ? "1" : "0.5";
  run.onclick = () => void runNow();
  header.appendChild(run);

  const csv = document.createElement("button");
  csv.textContent = "⬇ CSV";
  csv.style.cssText = BTN();
  csv.disabled = !currentReport;
  csv.style.opacity = currentReport ? "1" : "0.5";
  csv.onclick = () => currentReport && exportIdsReportCsv(currentReport);
  header.appendChild(csv);

  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText = BTN();
  close.onclick = () => toggleIdsPanel();
  header.appendChild(close);
}

async function runNow() {
  if (!currentDoc) return;
  body.innerHTML = `<div style="opacity:.6">Running IDS validation…</div>`;
  try {
    const report = await runIdsValidation(currentDoc, {
      onProgress: (p) => {
        body.innerHTML = `<div style="opacity:.6">Model ${p.current}/${p.total} — ${escapeHtml(p.modelId)}</div>`;
      },
    });
    currentReport = report;
    renderBody();
    renderHeader();
  } catch (e: any) {
    body.innerHTML = `<div style="color:#fca5a5">Validation failed: ${escapeHtml(e?.message ?? e)}</div>`;
  }
}

function renderBody() {
  body.innerHTML = "";

  if (!currentDoc) {
    body.innerHTML = `<div style="opacity:.55;text-align:center;padding:40px;border:1px dashed var(--border-default,#2a2e3a);border-radius:8px">
      No IDS document loaded.<br>Click <b>Open .ids</b> to load a specification.
    </div>`;
    return;
  }

  // Document info
  const info = document.createElement("div");
  info.style.cssText =
    "margin-bottom:12px;padding:10px;background:var(--bg-elevated,#181a23);border-radius:6px;font-size:11px;line-height:1.6";
  info.innerHTML =
    `<b>${currentDoc.title ?? "Untitled IDS"}</b>` +
    (currentDoc.version ? ` · v${currentDoc.version}` : "") +
    (currentDoc.author ? ` · ${currentDoc.author}` : "") +
    `<br>` +
    `${currentDoc.specifications.length} specification(s)`;
  body.appendChild(info);

  if (!currentReport) {
    // Preview specs
    for (const s of currentDoc.specifications) {
      const card = document.createElement("div");
      card.style.cssText =
        "margin:6px 0;padding:8px 10px;border:1px solid var(--border-subtle,#1e2029);border-radius:6px";
      card.innerHTML =
        `<div style="font-weight:600">${s.name}</div>` +
        `<div style="opacity:.7;font-size:11px;margin-top:2px">${s.ifcVersion} · ` +
        `${s.applicability.length} applicability · ${s.requirements.length} requirements</div>`;
      if (s.description) {
        const d = document.createElement("div");
        d.style.cssText = "opacity:.65;font-size:11px;margin-top:4px";
        d.textContent = s.description;
        card.appendChild(d);
      }
      body.appendChild(card);
    }
    body.insertAdjacentHTML(
      "beforeend",
      `<div style="margin-top:10px;opacity:.55;font-size:11px">Press <b>Run</b> to validate the loaded models.</div>`,
    );
    return;
  }

  // Summary grid
  const summary = document.createElement("div");
  summary.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:12px";
  for (const s of currentReport.summary) {
    const card = document.createElement("div");
    const ok = s.failed === 0;
    card.style.cssText =
      `padding:10px;border-radius:6px;border:1px solid ${ok ? "#22c55e" : "#ef4444"};background:${ok ? "rgba(34,197,94,.08)" : "rgba(239,68,68,.08)"}`;
    card.innerHTML =
      `<div style="font-weight:600;font-size:12px">${s.specificationName}</div>` +
      `<div style="margin-top:4px;font-size:11px">` +
      `<span style="color:#22c55e">✓ ${s.passed}</span> · ` +
      `<span style="color:#ef4444">✗ ${s.failed}</span>` +
      (s.unsupported ? ` · <span style="color:#f59e0b">? ${s.unsupported}</span>` : "") +
      `<span style="opacity:.55"> · ${s.total} element(s)</span>` +
      `</div>`;
    summary.appendChild(card);
  }
  body.appendChild(summary);

  // Filter chips
  const chips = document.createElement("div");
  chips.style.cssText = "display:flex;gap:6px;margin-bottom:10px;font-size:11px";
  for (const f of ["all", "fail", "warning", "unsupported", "pass"] as const) {
    const c = document.createElement("button");
    const count = f === "all"
      ? currentReport.results.length
      : currentReport.results.filter((r) => r.severity === f).length;
    c.textContent = `${f} (${count})`;
    c.style.cssText = BTN(activeFilter === f) + ";font-size:10px;padding:4px 10px";
    c.onclick = () => {
      activeFilter = f as any;
      renderBody();
    };
    chips.appendChild(c);
  }
  body.appendChild(chips);

  // Results table
  const filtered = currentReport.results.filter(
    (r) => activeFilter === "all" || r.severity === activeFilter,
  );
  if (!filtered.length) {
    body.insertAdjacentHTML(
      "beforeend",
      `<div style="opacity:.55;text-align:center;padding:20px">No results match the current filter.</div>`,
    );
    return;
  }

  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px";
  table.innerHTML = `<thead><tr style="position:sticky;top:0;background:var(--bg-elevated,#181a23)">
    <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle,#1e2029)">Severity</th>
    <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle,#1e2029)">Specification</th>
    <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle,#1e2029)">Element</th>
    <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle,#1e2029)">Facet</th>
    <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle,#1e2029)">Message</th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");
  const SEV_COLOR: Record<IdsSeverity, string> = {
    pass: "#22c55e",
    fail: "#ef4444",
    warning: "#f59e0b",
    unsupported: "#818cf8",
  };
  for (const r of filtered.slice(0, 1000)) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid var(--border-subtle,#1e2029)";
    const td = (text: string, extra = "") => {
      const c = document.createElement("td");
      c.style.cssText = "padding:5px 6px;vertical-align:top" + extra;
      c.textContent = text;
      return c;
    };
    const sevTd = document.createElement("td");
    sevTd.style.cssText =
      `padding:5px 6px;font-weight:700;color:${SEV_COLOR[r.severity]};text-transform:uppercase;font-size:10px`;
    sevTd.textContent = r.severity;
    tr.appendChild(sevTd);
    tr.appendChild(td(r.specificationName));
    tr.appendChild(td(r.elementName));
    tr.appendChild(td(r.facet));
    const msgTd = document.createElement("td");
    msgTd.style.cssText = "padding:5px 6px";
    msgTd.innerHTML = `${escapeHtml(r.message)}${r.actual ? ` <span style="opacity:.6">(actual: ${escapeHtml(r.actual)})</span>` : ""}`;
    tr.appendChild(msgTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
  if (filtered.length > 1000) {
    body.insertAdjacentHTML(
      "beforeend",
      `<div style="margin-top:8px;opacity:.55;font-size:11px">Showing 1000 of ${filtered.length} results. Export CSV for the full list.</div>`,
    );
  }
}

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (!f) return;
  try {
    const xml = await f.text();
    currentDoc = parseIdsXml(xml);
    currentReport = null;
    clearLastReport();
    renderBody();
    renderHeader();
  } catch (e: any) {
    body.innerHTML = `<div style="color:#fca5a5">Could not parse IDS: ${escapeHtml(e?.message ?? e)}</div>`;
  }
};

export function toggleIdsPanel() {
  const visible = panel.style.display === "flex";
  panel.style.display = visible ? "none" : "flex";
  if (!visible) {
    renderHeader();
    renderBody();
  }
}

export function isIdsPanelVisible() {
  return panel.style.display === "flex";
}

export function setupIdsPanel() {
  ctx.rightHost.appendChild(panel);
  ctx.rightHost.appendChild(fileInput);
  ctx.features.idsPanel = { toggle: toggleIdsPanel, isVisible: isIdsPanelVisible };
}