/** 5D Cost floating panel: Takeoff | Cost Items | Summary + CSV export. */
import { escapeHtml } from "../core/html-escape";
import { ctx } from "../core/context";
import {
  getItems, addCostItem, updateCostItem, deleteCostItem,
  getAssignment, setAssignment, setQtyOverride, computeLine, computeTotals, onCostChanged,
} from "../modules/cost/cost";
import { computeTakeoff, getRows } from "../modules/cost/quantities";
import type { CostItem, CostUnit, TakeoffRow } from "../modules/cost/types";
import {
  evaluateQtoRules, getActiveQtoRules, getCustomQtoRules, setCustomQtoRules,
  normalizeQtoRuleInput, slugifyQtoRuleName, QTO_FORMULA_VARIABLES,
  propertyClauseToString,
  type QtoRun, type QtoRule, type QtoRuleInput,
} from "../modules/cost/qto-rules";
import { validateFormula } from "../modules/schedules/schedule-formula";
import { listSystems } from "../modules/classification";
import { uiAlert } from "../core/notify";
import { confirmDialog } from "./form-modal";

const UNITS: CostUnit[] = ["m", "m2", "m3", "pcs", "kg"];

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

let activeTab: "takeoff" | "items" | "summary" | "rules" = "takeoff";
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
  const tabs: [typeof activeTab, string][] = [["takeoff", "Takeoff"], ["items", "Cost Items"], ["summary", "Summary"], ["rules", "QTO Rules"]];
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
        d.appendChild(miniBtn("🗑", async () => { if (await confirmDialog("Delete cost item", `Delete cost item "${it.code} ${it.name}"?`)) { deleteCostItem(it.id); renderBody(); } }));
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

// ── QTO Rules tab (5D rules engine) ──
function buildRateBook(): Record<string, { code: string; name: string; unit: CostUnit; rate: number }> {
  const rates: Record<string, { code: string; name: string; unit: CostUnit; rate: number }> = {};
  for (const it of getItems()) {
    if (it.code && rates[it.code] == null) {
      rates[it.code] = { code: it.code, name: it.name, unit: it.unit, rate: it.rate };
    }
  }
  return rates;
}

let lastQtoRun: QtoRun | null = null;

function runQtoRules(): QtoRun {
  lastQtoRun = evaluateQtoRules(getRows(), getActiveQtoRules(), { rates: buildRateBook() });
  return lastQtoRun;
}

// Rule editor state — kept across re-renders so typing survives a refresh.
let editorOpen = false;
let editingRuleId: string | null = null; // null = create/copy
let editorDraft: Record<string, string> = {};
let editorErrors: string[] = [];

const EDITOR_FIELDS: Array<[string, string, string]> = [
  ["name", "Name", 'e.g. Wall render both faces'],
  ["formula", "Formula", 'e.g. 2 * Length * Height'],
  ["waste", "Waste %", '0–100'],
  ["classification", "Classification", 'e.g. 09 90 00 Painting'],
  ["matchTokens", "Match tokens (comma-sep)", 'all must appear in label + detail'],
  ["excludeTokens", "Exclude tokens (comma-sep)", 'dropped if in the label'],
  ["levels", "Levels (comma-sep)", 'e.g. Level 1, Level 2'],
  ["propertyFilters", "Property filters (name = value; name ~ text; bare = exists)", 'e.g. FireRating = 2 hr; IsExternal = true; Mark ~ D'],
  ["costCode", "Cost code", 'rate-book code to price the result'],
  ["description", "Description", 'shown as the tooltip assumption'],
];

function renderRuleEditor() {
  const box = document.createElement("div");
  box.style.cssText = "padding:10px;margin-bottom:12px;border:1px solid #26466b;background:#141a26;border-radius:8px";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;margin-bottom:8px;color:#38bdf8";
  title.textContent = editingRuleId ? "Edit rule" : "New rule";
  box.appendChild(title);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px 10px";

  const field = (key: string, labelText: string, ph: string, wide = false) => {
    const wrap = document.createElement("div");
    if (wide) wrap.style.gridColumn = "1 / 3";
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:10px;opacity:.6;margin-bottom:2px";
    lab.textContent = labelText;
    const inp = document.createElement("input");
    inp.type = key === "waste" ? "number" : "text";
    inp.value = editorDraft[key] ?? "";
    inp.placeholder = ph;
    inp.style.cssText = INP + ";width:100%";
    inp.oninput = () => { editorDraft[key] = inp.value; };
    wrap.append(lab, inp);
    grid.appendChild(wrap);
    return inp;
  };

  let classifInput: HTMLInputElement | null = null;
  for (const [key, label, ph] of EDITOR_FIELDS) {
    const inp = field(key, label, ph, key === "formula");
    if (key === "classification") classifInput = inp;
  }

  // Classification codes from the built-in systems (UniFormat II, Uniclass 2015
  // EF, OmniClass Table 21) as type-ahead suggestions for the rule's roll-up
  // code. Free text is still allowed — the datalist only suggests.
  try {
    const dl = document.createElement("datalist");
    dl.id = "obs-qto-classif-dl";
    for (const sys of listSystems()) {
      for (const c of sys.codes.slice(0, 400)) {
        const opt = document.createElement("option");
        opt.value = c.code;
        opt.label = `${c.title} (${sys.name})`;
        dl.appendChild(opt);
      }
    }
    box.appendChild(dl);
    if (classifInput) classifInput.setAttribute("list", "obs-qto-classif-dl");
  } catch { /* datalist is a suggestion, never a blocker */ }

  // Unit select
  {
    const wrap = document.createElement("div");
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:10px;opacity:.6;margin-bottom:2px";
    lab.textContent = "Unit";
    const sel = document.createElement("select");
    sel.style.cssText = INP + ";width:100%";
    sel.innerHTML = UNITS.map((u) => `<option ${u === (editorDraft.unit || "m3") ? "selected" : ""}>${escapeHtml(u)}</option>`).join("");
    sel.onchange = () => { editorDraft.unit = sel.value; };
    wrap.append(lab, sel);
    grid.appendChild(wrap);
  }

  // Source select
  {
    const wrap = document.createElement("div");
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:10px;opacity:.6;margin-bottom:2px";
    lab.textContent = "Source";
    const sel = document.createElement("select");
    sel.style.cssText = INP + ";width:100%";
    const cur = editorDraft.source || "any";
    sel.innerHTML = ["any", "authored", "ifc"].map((s) => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
    sel.onchange = () => { editorDraft.source = sel.value; };
    wrap.append(lab, sel);
    grid.appendChild(wrap);
  }

  box.appendChild(grid);

  const vars = document.createElement("div");
  vars.style.cssText = "font-size:10px;opacity:.55;margin-top:8px";
  vars.textContent = `Variables: ${QTO_FORMULA_VARIABLES.join(" \u00b7 ")}. Height/Thickness/Width come from authored element dimensions and are 0 when the type (or IFC) has none.`;
  box.appendChild(vars);

  // Live formula validation
  const fStatus = document.createElement("div");
  fStatus.style.cssText = "font-size:10px;margin-top:4px";
  const fv = (editorDraft.formula ?? "").trim();
  if (fv) {
    const v = validateFormula(fv);
    if (v.ok) { fStatus.style.color = "#22c55e"; fStatus.textContent = "Formula OK"; }
    else { fStatus.style.color = "#fca5a5"; fStatus.textContent = `Formula error: ${v.error}`; }
  } else { fStatus.textContent = ""; }
  box.appendChild(fStatus);

  if (editorErrors.length) {
    const errBox = document.createElement("div");
    errBox.style.cssText = "margin-top:8px;padding:6px 8px;border:1px solid #7f1d1d;background:#2a1518;border-radius:6px;font-size:11px;color:#fca5a5";
    errBox.innerHTML = editorErrors.map((e) => `<div>${escapeHtml(e)}</div>`).join("");
    box.appendChild(errBox);
  }

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;margin-top:10px";
  const save = document.createElement("button");
  save.textContent = "Save rule";
  save.style.cssText = "padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:11px";
  save.onclick = (e) => { e.stopPropagation(); saveRuleFromEditor(); };
  const cancel = miniBtn("Cancel", () => { editorOpen = false; editingRuleId = null; editorDraft = {}; editorErrors = []; renderRules(); });
  btnRow.append(save, cancel);
  box.appendChild(btnRow);
  body.appendChild(box);
}

function draftFromRule(r: QtoRule): Record<string, string> {
  return {
    name: r.name,
    formula: r.formula,
    unit: r.unit,
    waste: r.wasteFactorPct != null ? String(r.wasteFactorPct) : "",
    classification: r.classification ?? "",
    source: r.filter.sources?.[0] ?? "any",
    matchTokens: r.filter.matchAll?.join(", ") ?? "",
    excludeTokens: r.filter.excludeAny?.join(", ") ?? "",
    levels: r.filter.levels?.join(", ") ?? "",
    propertyFilters: r.filter.properties?.map(propertyClauseToString).join("; ") ?? "",
    costCode: r.costCode ?? "",
    description: r.description ?? "",
  };
}

function saveRuleFromEditor() {
  const input: QtoRuleInput = {
    id: editingRuleId ?? undefined,
    name: editorDraft.name ?? "",
    description: editorDraft.description,
    classification: editorDraft.classification,
    sources: editorDraft.source || "any",
    matchTokens: editorDraft.matchTokens,
    excludeTokens: editorDraft.excludeTokens,
    levels: editorDraft.levels,
    propertyFilters: editorDraft.propertyFilters,
    formula: editorDraft.formula ?? "",
    unit: editorDraft.unit || "m3",
    wasteFactorPct: editorDraft.waste,
    costCode: editorDraft.costCode,
  };
  const customs = getCustomQtoRules();
  const otherIds = new Set(customs.map((c) => c.id).filter((id) => id !== editingRuleId));
  let res = normalizeQtoRuleInput(input, otherIds);
  // Creating (or copying) a rule whose auto id collides: propose suffixed ids
  // instead of making the user rename it.
  if (!res.ok && !editingRuleId && res.errors.length === 1 && res.errors[0].startsWith("duplicate id:")) {
    const base = `custom-${slugifyQtoRuleName(input.name)}`;
    for (let n = 2; ; n++) {
      const candidate = n === 2 ? base : `${base}-${n - 1}`;
      if (!otherIds.has(candidate)) {
        res = normalizeQtoRuleInput({ ...input, id: candidate }, otherIds);
        break;
      }
    }
  }
  if (!res.ok) { editorErrors = res.errors; renderRules(); return; }
  const next = editingRuleId
    ? customs.map((c) => (c.id === editingRuleId ? res.rule : c))
    : [...customs, res.rule];
  setCustomQtoRules(next);
  editorOpen = false;
  editingRuleId = null;
  editorDraft = {};
  editorErrors = [];
  renderRules();
}

function ruleActionButtons(ruleId: string, isCustom: boolean): HTMLElement[] {
  const btns: HTMLElement[] = [];
  if (isCustom) {
    btns.push(miniBtn("✎", () => {
      const r = getCustomQtoRules().find((c) => c.id === ruleId);
      if (!r) return;
      editorOpen = true; editingRuleId = r.id; editorDraft = draftFromRule(r); editorErrors = [];
      renderRules();
    }, "Edit this rule"));
    btns.push(miniBtn("🗑", async () => {
      const r = getCustomQtoRules().find((c) => c.id === ruleId);
      if (r && await confirmDialog("Delete rule", `Delete rule "${r.name}"?`)) {
        setCustomQtoRules(getCustomQtoRules().filter((c) => c.id !== ruleId));
        renderRules();
      }
    }, "Delete this rule"));
  } else {
    const r = getActiveQtoRules().find((c) => c.id === ruleId);
    btns.push(miniBtn("⧉", () => {
      if (!r) return;
      editorOpen = true; editingRuleId = null; editorDraft = draftFromRule(r); editorErrors = [];
      renderRules();
    }, "Copy as a custom rule (edits here never touch the built-in)"));
  }
  return btns;
}

function renderRules() {
  const run = runQtoRules();
  body.innerHTML = "";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:8px";
  const info = document.createElement("span");
  info.style.cssText = "flex:1;font-size:10px;opacity:.55";
  info.textContent = "Rules derive work-item quantities from the takeoff, apply waste factors, roll up by classification and price against the rate book by cost code.";
  bar.append(
    info,
    miniBtn("＋ New rule", () => { editorOpen = true; editingRuleId = null; editorDraft = {}; editorErrors = []; renderRules(); }, "Create a custom QTO rule"),
    miniBtn("⬇ Rules CSV", () => exportQtoRulesCsv(run), "Export rule results as CSV"),
  );
  body.appendChild(bar);

  if (editorOpen) renderRuleEditor();

  if (run.errors.length) {
    const errBox = document.createElement("div");
    errBox.style.cssText = "padding:8px 10px;margin-bottom:10px;border:1px solid #7f1d1d;background:#2a1518;border-radius:8px;font-size:11px;color:#fca5a5";
    for (const e of run.errors) {
      const line = document.createElement("div");
      line.textContent = `⚠ ${e.ruleName}: ${e.error}`;
      const custom = getCustomQtoRules().find((c) => c.id === e.ruleId);
      if (custom) line.append(" ", ...ruleActionButtons(e.ruleId, true));
      errBox.appendChild(line);
    }
    body.appendChild(errBox);
  }

  if (!run.results.length) {
    if (!editorOpen) {
      body.innerHTML += `<div style="opacity:.55;text-align:center;padding:16px;border:1px dashed #34353f;border-radius:8px">No rule matched the current takeoff. Draw objects or import a model, click <b>Recalculate</b>, or create a rule above.</div>`;
    }
    return;
  }

  const customIds = new Set(getCustomQtoRules().map((c) => c.id));
  const activeById = new Map(getActiveQtoRules().map((r) => [r.id, r] as const));
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px";
  table.innerHTML = `<thead><tr style="position:sticky;top:0;background:#1b1c26">
    ${["Rule", "Classification", "Matched", "Unit", "Net", "Waste %", "Quantity", "Cost code", "Rate", "Total", ""].map((h) =>
      `<th style="text-align:left;padding:5px 6px;border-bottom:1px solid #2a2a35;font-weight:600">${h}</th>`).join("")}
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const r of run.results) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #20212b";
    const cellText = (v: string, extra = "") => {
      const d = document.createElement("td");
      d.style.cssText = "padding:4px 6px" + (extra ? ";" + extra : "");
      d.textContent = v;
      return d;
    };
    const ruleCell = cellText(r.ruleName, "font-weight:600");
    const ruleDef = activeById.get(r.ruleId);
    ruleCell.title = (ruleDef?.formula ?? "") + (ruleDef?.description ? `\n${ruleDef.description}` : "") +
      (customIds.has(r.ruleId) ? "\n(custom rule)" : "\n(built-in — use the copy button to override it)");
    tr.append(
      ruleCell,
      cellText(r.classification, "opacity:.7;font-size:10px"),
      cellText(String(r.matchedRows)),
      cellText(r.unit),
      cellText(num(r.netQuantity)),
      cellText(r.wasteFactorPct ? `+${r.wasteFactorPct}%` : "—", "opacity:.6"),
      cellText(num(r.quantity), "font-weight:700;color:#38bdf8"),
      cellText(r.cost ? r.cost.code : "—", "opacity:.7"),
      cellText(r.cost ? money(r.cost.rate) : "—"),
      cellText(r.cost ? money(r.cost.total) : "—", "font-weight:700;color:#22c55e"),
    );
    const tdAct = document.createElement("td");
    tdAct.style.cssText = "padding:4px 6px;white-space:nowrap";
    for (const b of ruleActionButtons(r.ruleId, customIds.has(r.ruleId))) tdAct.appendChild(b);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }

  const trTotal = document.createElement("tr");
  trTotal.style.cssText = "background:#1b1c26;font-weight:700;border-top:1px solid #2a2a35";
  const tdL = document.createElement("td");
  tdL.colSpan = 10;
  tdL.style.cssText = "padding:8px 6px;text-align:right";
  tdL.textContent = "Rules cost total:";
  const tdV = document.createElement("td");
  tdV.style.cssText = "padding:8px 6px;color:#22c55e;font-size:13px";
  tdV.textContent = money(run.costTotal);
  trTotal.append(tdL, tdV);
  tbody.appendChild(trTotal);

  table.appendChild(tbody);
  body.appendChild(table);

  const cls = run.byClassification;
  if (cls.length) {
    const sec = document.createElement("div");
    sec.style.cssText = "margin-top:12px";
    sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">By classification</div>`;
    for (const c of cls) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin:3px 0;font-size:11px";
      const name = document.createElement("span");
      name.style.cssText = "flex:1;opacity:.8";
      name.textContent = c.classification;
      const qty = document.createElement("span");
      qty.style.cssText = "color:#38bdf8;font-weight:600";
      qty.textContent = `${num(c.quantity)} ${c.unit}`;
      row.append(name, qty);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  const elc = run.byElementClassification;
  if (elc.length) {
    const sec = document.createElement("div");
    sec.style.cssText = "margin-top:12px";
    sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">By element classification</div>` +
      `<div style="font-size:10px;opacity:.5;margin-bottom:4px">rules without their own classification, grouped by the element's assigned code</div>`;
    for (const c of elc) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin:3px 0;font-size:11px";
      const name = document.createElement("span");
      name.style.cssText = "flex:1;opacity:.8";
      name.textContent = c.code;
      const qty = document.createElement("span");
      qty.style.cssText = "color:#38bdf8;font-weight:600";
      qty.textContent = `${num(c.quantity)} ${c.unit}`;
      row.append(name, qty);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  const legend = document.createElement("div");
  legend.style.cssText = "margin-top:8px;font-size:10px;opacity:.5";
  legend.textContent = "Cost prices only when the rate book has a cost item whose CODE matches the rule's cost code with the SAME unit. Rebar uses a generic 100 kg/m³ ratio — override with custom rules for real projects.";
  body.appendChild(legend);
}

function exportQtoRulesCsv(run: QtoRun) {
  const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines: string[] = ["RuleId,Rule,Classification,MatchedRows,Unit,NetQuantity,WastePercent,Quantity,CostCode,Rate,Total"];
  for (const r of run.results) {
    lines.push([
      r.ruleId, q(r.ruleName), q(r.classification), r.matchedRows, r.unit,
      r.netQuantity.toFixed(3), r.wasteFactorPct, r.quantity.toFixed(3),
      r.cost?.code ?? "", r.cost ? r.cost.rate.toFixed(2) : "", r.cost ? r.cost.total.toFixed(2) : "",
    ].join(","));
  }
  for (const c of run.byElementClassification ?? []) {
    lines.push([q(c.code), "", q("by element classification"), "", c.unit, "", "", c.quantity.toFixed(3), "", "", ""].join(","));
  }
  for (const e of run.errors) {
    lines.push(`${q(e.ruleId)},${q(e.ruleName)},,0,,,,,,ERROR: ${q(e.error)}`);
  }
  lines.push(`,,,,,,,,RULES_TOTAL,${run.costTotal.toFixed(2)}`);
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "open-bim-studio-qto-rules.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function renderBody() {
  if (activeTab === "takeoff") renderTakeoff();
  else if (activeTab === "items") renderItems();
  else if (activeTab === "rules") renderRules();
  else renderSummary();
}

// ── CSV export (exported: used by the File menu too) ──
export function exportCostCsv() {
  const rows = getRows();
  if (!rows.length) { uiAlert("Nothing to export — run Recalculate first."); return; }
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