/** 5D Cost floating panel: Takeoff | Cost Items | Summary + CSV export. */
import { escapeHtml } from "../core/html-escape";
import { ctx } from "../core/context";
import {
  getItems, addCostItem, updateCostItem, deleteCostItem,
  getAssignment, setAssignment, setQtyOverride, computeLine, computeTotals, onCostChanged,
} from "../modules/cost/cost";
import { computeTakeoff, getRows } from "../modules/cost/quantities";
import type { CostItem, CostUnit, TakeoffRow } from "../modules/cost/types";

const UNITS: CostUnit[] = ["m", "m2", "m3", "pcs"];

const panel = document.createElement("div");
panel.style.cssText = "position:absolute;left:394px;top:14px;bottom:14px;width:680px;z-index:36;display:none;flex-direction:column;background:#171821;border:1px solid #2a2a35;border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:#e2e8f0;overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #24252f;background:#1b1c26";
const tabRow = document.createElement("div");
tabRow.style.cssText = "display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #24252f";
const body = document.createElement("div");
body.style.cssText = "flex:1;overflow:auto;padding:8px";
panel.append(header, tabRow, body);

const INP = "padding:3px 6px;background:#12131a;border:1px solid #34353f;border-radius:4px;color:#e2e8f0;font-size:11px";
const MINI = "padding:3px 8px;background:#24252f;color:#cbd5e1;border:1px solid #34353f;border-radius:5px;cursor:pointer;font-size:10px";
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number) => `${getCurrency()}${(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const num = (n: number) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function getCurrency() { try { return localStorage.getItem("obs.currency") ?? "$"; } catch { return "$"; } }
function setCurrency(s: string) { try { localStorage.setItem("obs.currency", s || "$"); } catch { /* */ } }

let activeTab: "takeoff" | "items" | "summary" = "takeoff";
let recalculating = false;

function miniBtn(label: string, onclick: () => void, title = "") {
  const b = document.createElement("button");
  b.textContent = label; b.title = title || label; b.style.cssText = MINI;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function renderHeader() {
  header.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = "💰 5D Cost";
  t.style.cssText = "font-weight:700;flex:1";
  header.append(
    t,
    miniBtn("🔄 Recalculate", async () => { await refreshTakeoff(); renderBody(); }),
    miniBtn("⬇ CSV", () => exportCostCsv()),
    miniBtn("✕", () => toggleCostPanel()),
  );
}

function renderTabs() {
  tabRow.innerHTML = "";
  const tabs: [typeof activeTab, string][] = [["takeoff", "Takeoff"], ["items", "Cost Items"], ["summary", "Summary"]];
  for (const [id, label] of tabs) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "padding:5px 12px;border-radius:6px;cursor:pointer;font:600 11px system-ui,sans-serif;border:1px solid #34353f;background:" + (activeTab === id ? "#16233a;color:#38bdf8" : "#1e1f28;color:#94a3b8");
    b.onclick = () => { activeTab = id; renderTabs(); renderBody(); };
    tabRow.appendChild(b);
  }
}

// ── Takeoff tab ──
function renderTakeoff() {
  const rows = getRows();
  if (recalculating) { body.innerHTML = `<div style="opacity:.6;padding:14px">Computing quantities...</div>`; return; }
  if (!rows.length) {
    body.innerHTML = `<div style="opacity:.55;text-align:center;padding:20px;border:1px dashed #34353f;border-radius:8px">
      No quantities yet. Import models or draw objects, then click <b>Recalculate</b>.</div>`;
    return;
  }
  const items = getItems();
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px";
  table.innerHTML = `<thead><tr style="position:sticky;top:0;background:#1b1c26">
    ${["Element / Category", "Info", "Pcs", "m", "m²", "m³", "Cost item", "Rate", "Override qty", "Line"].map((h) =>
      `<th style="text-align:left;padding:5px 6px;border-bottom:1px solid #2a2a35;font-weight:600">${h}</th>`).join("")}
  </tr></thead>`;
  const tbody = document.createElement("tbody");
  let grandTotal = 0;

  for (const row of rows) {
    const a = getAssignment(row.key);
    const line = computeLine(row);
    grandTotal += line.lineCost;
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #20212b";

    const tdLabel = document.createElement("td");
    tdLabel.style.cssText = "padding:4px 6px;font-weight:600";
    tdLabel.textContent = row.label;
    const srcDot = row.source === "authored" ? "🟩" : "🟨";
    tdLabel.prepend(document.createTextNode(srcDot + " "));

    const tdInfo = document.createElement("td");
    tdInfo.style.cssText = "padding:4px 6px;opacity:.55;font-size:10px";
    tdInfo.textContent = row.detail;

    const td = (v: number) => {
      const d = document.createElement("td");
      d.style.cssText = "padding:4px 6px";
      d.textContent = v ? num(v) : "—";
      return d;
    };

    const sel = document.createElement("select");
    sel.style.cssText = INP + ";max-width:150px";
    sel.innerHTML = `<option value="">— none —</option>` +
      items.map((i) => `<option value="${i.id}" ${a.costItemId === i.id ? "selected" : ""}>${esc(i.code)} · ${esc(i.name)} (${i.unit})</option>`).join("");
    sel.onchange = () => { setAssignment(row.key, sel.value || null); renderBody(); };

    const tdRate = document.createElement("td");
    tdRate.style.cssText = "padding:4px 6px";
    const rateInput = document.createElement("input");
    rateInput.type = "number";
    rateInput.style.cssText = INP + ";width:70px";
    rateInput.value = line.item ? String(line.rate) : "";
    rateInput.disabled = !line.item;
    rateInput.onchange = () => {
      if (line.item) {
        updateCostItem(line.item.id, { rate: Number(rateInput.value) || 0 });
        renderBody();
      }
    };
    tdRate.appendChild(rateInput);

    const ov = document.createElement("input");
    ov.type = "number"; ov.style.cssText = INP + ";width:70px";
    ov.placeholder = "auto"; ov.value = a.qtyOverride != null ? String(a.qtyOverride) : "";
    ov.onchange = () => { setQtyOverride(row.key, ov.value === "" ? null : Number(ov.value)); renderBody(); };

    const tdLine = document.createElement("td");
    tdLine.style.cssText = "padding:4px 6px;font-weight:700;color:#22c55e";
    tdLine.textContent = line.item ? money(line.lineCost) : "—";
    if (line.item) tdLine.title = `${num(line.qty)} ${line.item.unit} × ${money(line.rate)}`;

    tr.append(tdLabel, tdInfo, td(row.count), td(row.length), td(row.area), td(row.volume));
    const tdSel = document.createElement("td"); tdSel.style.cssText = "padding:4px 6px"; tdSel.appendChild(sel);
    const tdOv = document.createElement("td"); tdOv.style.cssText = "padding:4px 6px"; tdOv.appendChild(ov);
    tr.append(tdSel, tdRate, tdOv, tdLine);
    tbody.appendChild(tr);
  }

  const trTotal = document.createElement("tr");
  trTotal.style.cssText = "background:#1b1c26;font-weight:700;border-top:1px solid #2a2a35";
  const tdTotalLabel = document.createElement("td");
  tdTotalLabel.colSpan = 9;
  tdTotalLabel.style.cssText = "padding:8px 6px;text-align:right;color:#e2e8f0";
  tdTotalLabel.textContent = "Grand Total:";
  const tdTotalVal = document.createElement("td");
  tdTotalVal.style.cssText = "padding:8px 6px;color:#22c55e;font-size:13px";
  tdTotalVal.textContent = money(grandTotal);
  trTotal.append(tdTotalLabel, tdTotalVal);
  tbody.appendChild(trTotal);

  table.appendChild(tbody);
  body.innerHTML = "";
  body.appendChild(table);
  const legend = document.createElement("div");
  legend.style.cssText = "margin-top:8px;font-size:10px;opacity:.5";
  legend.textContent = "🟩 authored (exact) · 🟨 IFC (bbox approximation) — assign a cost item per row; override qty if the auto quantity isn't what you bill.";
  body.appendChild(legend);
}

// ── Cost items tab ──
function renderItems() {
  const items = getItems();
  body.innerHTML = "";

  const addBar = document.createElement("div");
  addBar.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
  const add = document.createElement("button");
  add.textContent = "＋ Add cost item";
  add.style.cssText = "padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:11px";
  add.onclick = () => { addCostItem(); renderBody(); };
  addBar.appendChild(add);
  body.appendChild(addBar);

  if (!items.length) {
    body.innerHTML += `<div style="opacity:.55;text-align:center;padding:16px;border:1px dashed #34353f;border-radius:8px">No cost items yet — add one above (e.g. code C-001, "Ready-mix concrete C30", unit m³, rate 120).</div>`;
    return;
  }

  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px";
  table.innerHTML = `<thead><tr style="background:#1b1c26">
    ${["Code", "Name", "Unit", "Rate", "Category", ""].map((h) =>
      `<th style="text-align:left;padding:5px 6px;border-bottom:1px solid #2a2a35">${h}</th>`).join("")}
  </tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const it of items) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #20212b";
    const cell = (v: string, on: (val: string) => void, width = "") => {
      const d = document.createElement("td"); d.style.cssText = "padding:3px 4px";
      const i = document.createElement("input");
      i.value = v; i.style.cssText = INP + (width ? `;width:${width}` : "");
      i.onchange = () => { on(i.value); };
      d.appendChild(i); return d;
    };
    tr.append(
      cell(it.code, (v) => updateCostItem(it.id, { code: v }), "60px"),
      cell(it.name, (v) => updateCostItem(it.id, { name: v }), "170px"),
      (() => {
        const d = document.createElement("td"); d.style.cssText = "padding:3px 4px";
        const s = document.createElement("select"); s.style.cssText = INP;
        s.innerHTML = UNITS.map((u) => `<option ${u === it.unit ? "selected" : ""}>${escapeHtml(u)}</option>`).join("");
        s.onchange = () => updateCostItem(it.id, { unit: s.value as CostUnit });
        d.appendChild(s); return d;
      })(),
      cell(String(it.rate), (v) => updateCostItem(it.id, { rate: Number(v) || 0 }), "80px"),
      cell(it.category, (v) => updateCostItem(it.id, { category: v }), "100px"),
      (() => {
        const d = document.createElement("td"); d.style.cssText = "padding:3px 4px";
        d.appendChild(miniBtn("🗑", () => { if (confirm(`Delete cost item "${it.code} ${it.name}"?`)) { deleteCostItem(it.id); renderBody(); } }));
        return d;
      })(),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

// ── Summary tab ──
function renderSummary() {
  const rows = getRows();
  const totals = computeTotals(rows);
  body.innerHTML = "";

  const curRow = document.createElement("div");
  curRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:10px";
  const curInp = document.createElement("input");
  curInp.value = getCurrency(); curInp.style.cssText = INP + ";width:44px;text-align:center";
  curInp.onchange = () => { setCurrency(curInp.value); renderBody(); };
  curRow.append("Currency symbol:", curInp);
  body.appendChild(curRow);

  const grandCard = document.createElement("div");
  grandCard.style.cssText = "padding:14px;background:linear-gradient(135deg,#16233a,#1b1c26);border:1px solid #26466b;border-radius:10px;margin-bottom:12px";
  grandCard.innerHTML = `<div style="font-size:11px;opacity:.6">TOTAL PROJECT COST</div>
    <div style="font:800 26px system-ui,sans-serif;color:#38bdf8;margin-top:2px">${money(totals.grand)}</div>
    <div style="font-size:10px;opacity:.55;margin-top:4px">${totals.assignedRows} of ${totals.totalRows} rows assigned · ${getItems().length} cost items</div>`;
  body.appendChild(grandCard);

  const barSection = (title: string, data: { name: string; total: number }[]) => {
    const sec = document.createElement("div");
    sec.style.cssText = "margin-bottom:14px";
    sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${escapeHtml(title)}</div>`;
    if (!data.length) { sec.innerHTML += `<div style="opacity:.5;font-size:11px">No assigned costs yet.</div>`; body.appendChild(sec); return; }
    const max = Math.max(...data.map((d) => d.total), 1);
    for (const d of data.slice(0, 12)) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0";
      const label = document.createElement("div");
      label.style.cssText = "width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px";
      label.textContent = d.name; label.title = d.name;
      const track = document.createElement("div");
      track.style.cssText = "flex:1;height:14px;background:#12131a;border-radius:4px;overflow:hidden";
      const bar = document.createElement("div");
      bar.style.cssText = `height:100%;width:${Math.max(2, (d.total / max) * 100)}%;background:linear-gradient(90deg,#38bdf8,#818cf8)`;
      track.appendChild(bar);
      const val = document.createElement("div");
      val.style.cssText = "width:110px;text-align:right;font-size:11px;color:#22c55e;font-weight:600";
      val.textContent = money(d.total);
      row.append(label, track, val);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  };

  barSection("By cost category", totals.byCategory);
  barSection("By cost item", totals.byItem.map((x) => ({ name: `${x.item.code} · ${x.item.name}`, total: x.total })));
}

function renderBody() {
  if (activeTab === "takeoff") renderTakeoff();
  else if (activeTab === "items") renderItems();
  else renderSummary();
}

// ── CSV export (exported: used by the File menu too) ──
export function exportCostCsv() {
  const rows = getRows();
  if (!rows.length) { alert("Nothing to export — run Recalculate first."); return; }
  const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines: string[] = ["Source,Label,Detail,Count,Length_m,Area_m2,Volume_m3,CostCode,CostName,Unit,Qty,Rate,LineCost,CostCategory"];
  let grand = 0;
  for (const row of rows) {
    const { qty, rate, lineCost, item } = computeLine(row);
    grand += lineCost;
    lines.push([
      row.source, q(row.label), q(row.detail), row.count, row.length, row.area, row.volume,
      item ? q(item.code) : "", item ? q(item.name) : "", item?.unit ?? "",
      item ? qty.toFixed(3) : "", item ? rate.toFixed(2) : "", lineCost.toFixed(2),
      item ? q(item.category) : "",
    ].join(","));
  }
  lines.push(`,,,,,,,,,TOTAL,,${grand.toFixed(2)},`);
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "open-bim-studio-cost.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

async function refreshTakeoff() {
  recalculating = true;
  try { renderBody(); await computeTakeoff(); }
  finally { recalculating = false; }
}

// ── Public API ──
export function toggleCostPanel() {
  panel.style.display = panel.style.display === "none" || !panel.style.display ? "flex" : "none";
  if (panel.style.display === "flex") {
    renderHeader(); renderTabs();
    void refreshTakeoff().then(renderBody);
  }
}
export function isCostPanelVisible() { return panel.style.display === "flex"; }
export async function recalculateTakeoff() {
  await refreshTakeoff();
  if (panel.style.display === "flex") renderBody();
}

export function setupCostPanel() {
  ctx.rightHost.appendChild(panel);
  onCostChanged(() => { if (panel.style.display === "flex") renderBody(); });
  ctx.features.costPanel = { toggle: toggleCostPanel, isVisible: isCostPanelVisible, recalculate: recalculateTakeoff };
}