/**
 * Schedules panel v3.
 *
 * Adds to v2:
 *   • "My schedules" picker — user-saved definitions
 *   • Save / Save As / Duplicate / Delete actions
 *   • "New schedule" dialog — create from any category
 *   • Edit dialog — rename, choose columns, change grouping
 *   • Template gallery (unchanged)
 *   • Snapshot diff (unchanged)
 */
import { ctx } from "../core/context";
import {
  BUILT_IN_TEMPLATES,
  cloneTemplate,
  getTemplate,
} from "../modules/schedules/schedule-templates";
import {
  clearIfcScheduleCache,
  runSchedule,
} from "../modules/schedules/schedule-generator";
import {
  listSavedSchedules,
  getSavedSchedule,
  saveSchedule,
  deleteSchedule,
  duplicateSchedule,
  type StoredSchedule,
} from "../modules/schedules/schedule-store";
import {
  buildSchedule,
  listColumnTemplates,
  type ScheduleSpec,
} from "../modules/schedules/schedule-builder";
import { CATEGORY_CATALOG, listDisciplines } from "../modules/schedules/schedule-catalog";
import {
  takeSnapshot,
  listSnapshots,
  diffAgainstSnapshot,
  deleteSnapshot,
  summarizeDiff,
  type ScheduleDiff,
} from "../modules/schedules/schedule-diff";
import type {
  ScheduleDefinition,
  ScheduleRun,
  ScheduleRow,
  ScheduleColumn,
  ConditionalRule,
  GroupLevel,
} from "../modules/schedules/schedule-types";

/* ═════════════════════════════════════════════════════════════════════════
   State
   ═════════════════════════════════════════════════════════════════════════ */
let currentDefinition: ScheduleDefinition = cloneTemplate(BUILT_IN_TEMPLATES[0]);
let currentRun: ScheduleRun | null = null;
let sortKey: string | null = null;
let sortDir: 1 | -1 = 1;
let visibleColumns = new Set<string>();
let running = false;
let cancelHandle: { cancelled: boolean } | null = null;
let currentDiff: ScheduleDiff | null = null;

/* ═════════════════════════════════════════════════════════════════════════
   DOM
   ═════════════════════════════════════════════════════════════════════════ */
const overlay = document.createElement("div");
overlay.style.cssText =
  "position:fixed;inset:0;z-index:340;display:none;flex-direction:column;" +
  "background:var(--bg-base,#0b0d12);color:var(--text-primary,#e8eaf0);" +
  "font:13px system-ui,sans-serif;user-select:none";
overlay.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:8px 12px;" +
  "background:var(--bg-surface,#12141b);border-bottom:1px solid var(--border-default,#2a2e3a);" +
  "height:44px;flex:none;overflow-x:auto";

const controls = document.createElement("div");
controls.style.cssText =
  "display:flex;align-items:center;gap:10px;padding:6px 12px;" +
  "background:var(--bg-base,#0b0d12);border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "height:42px;flex:none;overflow-x:auto;overflow-y:hidden";

const tableWrap = document.createElement("div");
tableWrap.style.cssText = "flex:1;overflow:auto;background:var(--bg-base,#0b0d12)";

const footer = document.createElement("div");
footer.style.cssText =
  "display:flex;align-items:center;gap:12px;padding:6px 12px;" +
  "background:var(--bg-surface,#12141b);border-top:1px solid var(--border-default,#2a2e3a);" +
  "height:32px;flex:none;font:11px system-ui";

const loading = document.createElement("div");
loading.style.cssText =
  "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
  "flex-direction:column;gap:12px;background:rgba(11,13,18,0.85);color:#e8eaf0;z-index:10";
const loadingText = document.createElement("div");
loadingText.style.cssText = "font:14px system-ui";
loadingText.textContent = "Generating schedule…";
const loadingBar = document.createElement("div");
loadingBar.style.cssText =
  "width:300px;height:6px;background:#1e2029;border-radius:3px;overflow:hidden";
const loadingBarInner = document.createElement("div");
loadingBarInner.style.cssText =
  "height:100%;width:0%;background:#38bdf8;transition:width .15s";
loadingBar.appendChild(loadingBarInner);
const cancelBtn = document.createElement("button");
cancelBtn.textContent = "Cancel";
cancelBtn.style.cssText =
  "padding:6px 14px;background:rgba(239,68,68,0.13);color:#fca5a5;" +
  "border:1px solid #ef4444;border-radius:5px;cursor:pointer;font:12px system-ui";
cancelBtn.onclick = () => {
  if (cancelHandle) cancelHandle.cancelled = true;
};
loading.append(loadingText, loadingBar, cancelBtn);

const stage = document.createElement("div");
stage.style.cssText =
  "position:relative;flex:1;display:flex;flex-direction:column;overflow:hidden";
stage.append(tableWrap, loading);

/* ═════════════════════════════════════════════════════════════════════════
   Helpers
   ═════════════════════════════════════════════════════════════════════════ */
const btn = (label: string, onclick: () => void, primary = false) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    `padding:6px 12px;border-radius:5px;cursor:pointer;font:12px system-ui;` +
    (primary
      ? "background:var(--accent,#38bdf8);color:#0b0d12;border:1px solid var(--accent,#38bdf8)"
      : "background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a)");
  b.onclick = (e) => {
    e.stopPropagation();
    onclick();
  };
  return b;
};

const divider = () => {
  const d = document.createElement("div");
  d.style.cssText = "width:1px;height:22px;background:var(--border-default,#2a2e3a);flex:none";
  return d;
};

/* ═════════════════════════════════════════════════════════════════════════
   Header
   ═════════════════════════════════════════════════════════════════════════ */
function renderHeader(): void {
  header.innerHTML = "";

  const title = document.createElement("div");
  title.textContent = "📊 Schedules";
  title.style.cssText = "font:700 13px system-ui;white-space:nowrap";

  // My schedules dropdown (user-saved)
  const savedSel = document.createElement("select");
  savedSel.style.cssText =
    "padding:5px 9px;background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui;min-width:180px";
  const saved = listSavedSchedules();
  savedSel.innerHTML =
    `<option value="">— My schedules (${saved.length}) —</option>` +
    saved.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
  savedSel.value = saved.some((s) => s.id === currentDefinition.id) ? currentDefinition.id : "";
  savedSel.onchange = () => {
    const s = savedSel.value ? getSavedSchedule(savedSel.value) : null;
    if (!s) return;
    currentDefinition = s;
    visibleColumns = new Set(currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key));
    void regenerate();
  };

  // Template gallery
  const tplSel = document.createElement("select");
  tplSel.style.cssText = savedSel.style.cssText;
  tplSel.innerHTML =
    `<option value="">— Templates (${BUILT_IN_TEMPLATES.length}) —</option>` +
    BUILT_IN_TEMPLATES.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  tplSel.value = "";
  tplSel.onchange = () => {
    const tpl = getTemplate(tplSel.value);
    if (!tpl) return;
    currentDefinition = cloneTemplate(tpl);
    visibleColumns = new Set(currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key));
    void regenerate();
  };

  const spacer = document.createElement("div");
  spacer.style.cssText = "flex:1";

  const runBtn = btn("⟳ Run", () => void regenerate(), true);
  const newBtn = btn("＋ New", () => openNewDialog());
  const saveBtn = btn("💾 Save", () => saveCurrent());
  const snapshotBtn = btn("📷 Snapshot", takeSnapshotNow);
  const diffBtn = btn("⇄ Diff", showLatestDiff);
  const closeBtn = btn("✕", () => toggleSchedules());

  header.append(
    title, divider(),
    savedSel, tplSel,
    spacer,
    runBtn, newBtn, saveBtn, snapshotBtn, diffBtn, closeBtn,
  );
}

/* ═════════════════════════════════════════════════════════════════════════
   New schedule dialog
   ═════════════════════════════════════════════════════════════════════════ */
function openNewDialog(): void {
  const back = document.createElement("div");
  back.style.cssText =
    "position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.65);" +
    "display:flex;align-items:center;justify-content:center";
  back.onmousedown = (e) => {
    if (e.target === back) back.remove();
  };

  const card = document.createElement("div");
  card.style.cssText =
    "background:var(--bg-floating,#1c1e28);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:10px;padding:16px;width:480px;max-width:92vw;max-height:88vh;overflow:auto;" +
    "color:var(--text-primary,#e8eaf0);font:12px system-ui";

  const t = document.createElement("div");
  t.textContent = "New schedule";
  t.style.cssText = "font:700 14px system-ui;margin-bottom:12px";

  const row = (label: string, control: HTMLElement): HTMLElement => {
    const r = document.createElement("div");
    r.style.cssText =
      "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;margin-bottom:8px";
    const l = document.createElement("label");
    l.textContent = label;
    l.style.cssText = "color:var(--text-secondary,#a0a6b5)";
    r.append(l, control);
    return r;
  };

  const INP =
    "width:100%;box-sizing:border-box;padding:5px 8px;background:var(--bg-inset,#0e1017);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;" +
    "color:var(--text-primary,#e8eaf0);font:12px system-ui";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Doors on Level 2";
  nameInput.style.cssText = INP;

  // Category picker grouped by discipline
  const catSel = document.createElement("select");
  catSel.style.cssText = INP + ";cursor:pointer";
  const opts: string[] = [`<option value="">— All categories —</option>`];
  for (const d of listDisciplines()) {
    const group = CATEGORY_CATALOG.filter((c) => c.discipline === d.key);
    if (!group.length) continue;
    opts.push(`<optgroup label="${d.label}">`);
    for (const c of group) {
      opts.push(`<option value="${c.ifc}">${c.label} (${c.ifc})</option>`);
    }
    opts.push(`</optgroup>`);
  }
  catSel.innerHTML = opts.join("");

  const colsPreview = document.createElement("div");
  colsPreview.style.cssText =
    "font-size:10.5px;color:var(--text-tertiary,#6b7280);line-height:1.5;" +
    "padding:6px 8px;background:var(--bg-inset,#0e1017);border-radius:5px;" +
    "border:1px solid var(--border-subtle,#1e2029);margin-top:4px;min-height:40px";
  colsPreview.textContent = "Category defaults will be used.";

  catSel.onchange = () => {
    const cat = CATEGORY_CATALOG.find((c) => c.ifc === catSel.value);
    if (!cat) {
      colsPreview.textContent = "Multi-category schedule. Columns: type, level, count.";
      return;
    }
    colsPreview.textContent =
      `Default columns: ${cat.defaultColumns.join(", ")}\n` +
      `Default grouping: ${cat.defaultGrouping.join(" > ") || "none"}`;
    colsPreview.style.whiteSpace = "pre-wrap";
  };

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px";

  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.style.cssText =
    "padding:6px 14px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;cursor:pointer;font:12px system-ui";
  cancel.onclick = () => back.remove();

  const create = document.createElement("button");
  create.textContent = "Create & save";
  create.style.cssText =
    "padding:6px 14px;background:var(--accent,#38bdf8);color:#0b0d12;border:none;" +
    "border-radius:5px;cursor:pointer;font:600 12px system-ui";
  create.onclick = () => {
    const name = nameInput.value.trim() || "New schedule";
    const spec: ScheduleSpec = {
      name,
      category: catSel.value || null,
    };
    const def = buildSchedule(spec);
    const stored = saveSchedule(def);
    currentDefinition = stored;
    visibleColumns = new Set(currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key));
    back.remove();
    void regenerate();
    renderHeader();
  };

  actions.append(cancel, create);
  card.append(
    t,
    row("Name", nameInput),
    row("Category", catSel),
    colsPreview,
    actions,
  );
  back.appendChild(card);
  document.body.appendChild(back);
}

/* ═════════════════════════════════════════════════════════════════════════
   Save current
   ═════════════════════════════════════════════════════════════════════════ */
function saveCurrent(): void {
  const existing = listSavedSchedules().find((s) => s.id === currentDefinition.id);
  if (existing) {
    const stored = saveSchedule(currentDefinition);
    currentDefinition = stored;
    alert(`Saved "${stored.name}".`);
    renderHeader();
    return;
  }
  const name = prompt("Save schedule as:", currentDefinition.name || "New schedule");
  if (name == null) return;
  const named = { ...currentDefinition, name: name.trim() || currentDefinition.name };
  const stored = saveSchedule(named);
  currentDefinition = stored;
  alert(`Saved as "${stored.name}".`);
  renderHeader();
}

/* ═════════════════════════════════════════════════════════════════════════
   Controls
   ═════════════════════════════════════════════════════════════════════════ */
function renderControls(): void {
  controls.innerHTML = "";

  const lbl = (text: string) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.cssText = "font:11px system-ui;color:var(--text-tertiary,#6b7280);white-space:nowrap";
    return s;
  };

  controls.appendChild(lbl("Columns:"));

  for (const col of currentDefinition.columns) {
    if (col.hidden) continue;
    const chip = document.createElement("button");
    chip.textContent = col.header + (col.format === "formula" ? " ƒ" : "");
    const isOn = visibleColumns.has(col.key);
    chip.style.cssText =
      `padding:3px 8px;border-radius:4px;font:11px system-ui;cursor:pointer;white-space:nowrap;` +
      (isOn
        ? "background:var(--accent-dim,rgba(56,189,248,.14));color:var(--accent,#38bdf8);border:1px solid var(--accent,#38bdf8)"
        : "background:var(--bg-elevated,#181a23);color:var(--text-secondary,#a0a6b5);border:1px solid var(--border-default,#2a2e3a)");
    chip.title = col.help ?? col.header;
    chip.onclick = () => {
      if (visibleColumns.has(col.key)) visibleColumns.delete(col.key);
      else visibleColumns.add(col.key);
      renderControls();
      renderTable();
    };
    controls.appendChild(chip);
  }

  controls.appendChild(divider());
  controls.appendChild(lbl("Group:"));

  const groups: GroupLevel[] = currentDefinition.grouping ?? [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const chip = document.createElement("span");
    chip.textContent = `${g.key} ✕`;
    chip.title = "Remove grouping level";
    chip.style.cssText =
      "padding:3px 8px;border-radius:4px;font:11px system-ui;cursor:pointer;" +
      "background:rgba(168,85,247,.14);color:#c084fc;border:1px solid rgba(168,85,247,.4)";
    chip.onclick = () => {
      currentDefinition.grouping = groups.filter((_, j) => j !== i);
      void regenerate();
    };
    controls.appendChild(chip);
  }

  const addGroup = document.createElement("button");
  addGroup.textContent = "+";
  addGroup.title = "Add a grouping level";
  addGroup.style.cssText =
    "padding:3px 10px;border-radius:4px;font:11px system-ui;cursor:pointer;" +
    "background:var(--bg-elevated,#181a23);color:var(--text-secondary,#a0a6b5);" +
    "border:1px dashed var(--border-default,#2a2e3a)";
  addGroup.onclick = () => {
    const key = prompt(
      "Group by column key (e.g. level, category, systemType, material, type):",
      "level",
    );
    if (!key) return;
    currentDefinition.grouping = [...(currentDefinition.grouping ?? []), { key, subtotal: true }];
    void regenerate();
  };
  controls.appendChild(addGroup);
}

/* ═════════════════════════════════════════════════════════════════════════
   Formatting
   ═════════════════════════════════════════════════════════════════════════ */
function formatCell(col: ScheduleColumn, value: string | number | null): string {
  if (value == null || value === "") return "";
  if (col.format === "text" || col.format === "date") return String(value);
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return String(value);
  if (col.format === "count") return String(Math.round(n));
  if (col.format === "currency") return n.toFixed(2);
  if (col.format === "percent") return `${n.toFixed(1)}%`;
  return n.toFixed(3);
}

function ruleMatches(rule: ConditionalRule, row: ScheduleRow, col: ScheduleColumn): boolean {
  const target = rule.column === "*" ? col.key : rule.column;
  const v = row.values[target];
  const s = String(v ?? "").toLowerCase();
  const exp = String(rule.value ?? "").toLowerCase();
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  const en = parseFloat(String(rule.value ?? ""));
  switch (rule.op) {
    case "eq": return s === exp;
    case "neq": return s !== exp;
    case "contains": return s.includes(exp);
    case "gt": return Number.isFinite(n) && Number.isFinite(en) && n > en;
    case "gte": return Number.isFinite(n) && Number.isFinite(en) && n >= en;
    case "lt": return Number.isFinite(n) && Number.isFinite(en) && n < en;
    case "lte": return Number.isFinite(n) && Number.isFinite(en) && n <= en;
    case "empty": return v == null || v === "";
    case "notempty": return v != null && v !== "";
    default: return false;
  }
}

function cellStyle(row: ScheduleRow, col: ScheduleColumn): { bg: string; fg: string } {
  const rules = currentDefinition.conditionalFormatting ?? [];
  for (const r of rules) {
    const applies =
      r.column === "*" ||
      r.column === col.key ||
      (r.wholeRow && ruleMatches(r, row, col));
    if (applies && ruleMatches(r, row, col)) {
      return { bg: r.bg ?? "transparent", fg: r.fg ?? "inherit" };
    }
  }
  return { bg: "", fg: "" };
}

/* ═════════════════════════════════════════════════════════════════════════
   Table rendering
   ═════════════════════════════════════════════════════════════════════════ */
function renderTable(): void {
  tableWrap.innerHTML = "";

  if (currentDiff) {
    renderDiffView();
    return;
  }

  if (!currentRun) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:40px;text-align:center;color:var(--text-tertiary,#6b7280)";
    empty.textContent = "No schedule generated yet — press Run.";
    tableWrap.appendChild(empty);
    return;
  }

  const cols = currentDefinition.columns.filter((c) => visibleColumns.has(c.key));
  if (!cols.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:40px;text-align:center;color:var(--text-tertiary,#6b7280)";
    empty.textContent = "All columns hidden.";
    tableWrap.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.style.cssText =
    "width:100%;border-collapse:collapse;font:12px system-ui;background:var(--bg-base,#0b0d12)";

  const thead = document.createElement("thead");
  thead.style.cssText = "position:sticky;top:0;z-index:2";
  const headRow = document.createElement("tr");
  headRow.style.cssText = "background:var(--bg-surface,#12141b)";

  for (const col of cols) {
    const th = document.createElement("th");
    th.style.cssText =
      "padding:8px 10px;text-align:left;font-weight:600;font-size:11px;" +
      "color:var(--text-secondary,#a0a6b5);text-transform:uppercase;letter-spacing:0.5px;" +
      "border-bottom:1px solid var(--border-default,#2a2e3a);cursor:pointer;white-space:nowrap;" +
      `width:${col.width ?? 120}px`;
    const arrow = sortKey === col.key ? (sortDir === 1 ? " ▲" : " ▼") : "";
    const fn = col.format === "formula" ? " ƒ" : "";
    th.textContent = col.header + (col.unit ? ` (${col.unit})` : "") + fn + arrow;
    if (col.help) th.title = col.help;
    th.onclick = () => {
      if (sortKey === col.key) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortKey = col.key;
        sortDir = 1;
      }
      renderTable();
    };
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let dataRows = 0;
  for (const r of currentRun.rows) {
    const isSubtotal = !!r.subtotal;
    const tr = document.createElement("tr");
    tr.style.cssText =
      "border-bottom:1px solid var(--border-subtle,#1e2029);cursor:pointer";
    if (isSubtotal) {
      tr.style.background = "rgba(56,189,248,.06)";
      tr.style.fontWeight = "600";
    }
    tr.onmouseenter = () => {
      if (!isSubtotal) tr.style.background = "var(--bg-hover,#232633)";
    };
    tr.onmouseleave = () => {
      tr.style.background = isSubtotal ? "rgba(56,189,248,.06)" : "";
    };
    tr.onclick = () => void selectLinked(r);

    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const td = document.createElement("td");
      const isNum = col.format !== "text" && col.format !== "date";
      const padLeft = i === 0 ? 10 + (r.depth ?? 0) * 16 : 10;
      td.style.cssText =
        `padding:6px 10px 6px ${padLeft}px;font-size:12px;` +
        (isNum ? "text-align:right;font-family:var(--font-mono,monospace);" : "");

      let value: any;
      if (isSubtotal && r.subtotalValues && col.key in r.subtotalValues) {
        value = r.subtotalValues[col.key];
      } else if (isSubtotal && col.key in r.values) {
        value = r.values[col.key];
      } else {
        value = r.values[col.key] ?? null;
      }

      td.textContent = formatCell(col, value);

      if (!isSubtotal) {
        const style = cellStyle(r, col);
        if (style.bg) td.style.background = style.bg;
        if (style.fg) td.style.color = style.fg;
      } else if (i === 0) {
        td.style.color = "var(--accent,#38bdf8)";
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    if (!isSubtotal) dataRows++;
  }
  table.appendChild(tbody);

  if (currentDefinition.showTotals !== false && currentRun.totals) {
    const tfoot = document.createElement("tfoot");
    tfoot.style.cssText =
      "position:sticky;bottom:0;background:var(--bg-surface,#12141b);" +
      "border-top:2px solid var(--border-strong,#3d4250)";
    const tr = document.createElement("tr");
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const td = document.createElement("td");
      td.style.cssText = "padding:8px 10px;font-weight:700;font-size:12px;";
      if (i === 0) {
        td.textContent = `Grand total (${dataRows} rows)`;
        td.style.color = "var(--text-primary,#e8eaf0)";
      } else if (col.format !== "text" && col.format !== "date") {
        const t = currentRun.totals[col.key];
        td.textContent = t != null ? formatCell(col, t) : "";
        td.style.textAlign = "right";
        td.style.fontFamily = "var(--font-mono,monospace)";
        td.style.color = "var(--accent,#38bdf8)";
      }
      tr.appendChild(td);
    }
    tfoot.appendChild(tr);
    table.appendChild(tfoot);
  }

  tableWrap.appendChild(table);
}

/* ═════════════════════════════════════════════════════════════════════════
   Diff view
   ═════════════════════════════════════════════════════════════════════════ */
function renderDiffView(): void {
  if (!currentDiff) return;
  const diff = currentDiff;

  const banner = document.createElement("div");
  banner.style.cssText =
    "padding:10px 14px;background:var(--bg-surface,#12141b);" +
    "border-bottom:1px solid var(--border-default,#2a2e3a);" +
    "display:flex;align-items:center;gap:12px;font-size:12px";
  banner.innerHTML =
    `<b>Diff against "${diff.snapshotLabel}"</b> ` +
    `<span style="opacity:.6">(${new Date(diff.snapshotAt).toLocaleString()})</span>` +
    `<span style="margin-left:auto;opacity:.7">${summarizeDiff(diff)}</span>`;

  const back = document.createElement("button");
  back.textContent = "← Back to table";
  back.style.cssText =
    "padding:4px 10px;background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer;font-size:11px";
  back.onclick = () => {
    currentDiff = null;
    renderTable();
  };
  banner.appendChild(back);

  const container = document.createElement("div");
  container.style.cssText = "padding:14px";

  const section = (title: string, color: string, entries: any[], renderer: (e: any) => HTMLElement) => {
    const s = document.createElement("div");
    s.style.cssText = "margin-bottom:16px";
    const h = document.createElement("div");
    h.textContent = `${title} (${entries.length})`;
    h.style.cssText =
      `font-weight:700;font-size:12px;color:${color};margin-bottom:6px;` +
      "padding-bottom:4px;border-bottom:1px solid var(--border-subtle,#1e2029)";
    s.appendChild(h);
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.textContent = "None.";
      empty.style.cssText = "font-size:11px;opacity:.6";
      s.appendChild(empty);
      return s;
    }
    for (const e of entries.slice(0, 100)) s.appendChild(renderer(e));
    return s;
  };

  container.appendChild(
    section("Added", "#22c55e", diff.added, (e) => {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:6px 8px;background:rgba(34,197,94,.08);border-left:3px solid #22c55e;" +
        "border-radius:4px;margin:3px 0;font-size:11px";
      row.textContent = `${e.rowId} — ${describeValues(e.values)}`;
      return row;
    }),
  );

  container.appendChild(
    section("Removed", "#ef4444", diff.removed, (e) => {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:6px 8px;background:rgba(239,68,68,.08);border-left:3px solid #ef4444;" +
        "border-radius:4px;margin:3px 0;font-size:11px";
      row.textContent = `${e.rowId} — ${describeValues(e.values)}`;
      return row;
    }),
  );

  container.appendChild(
    section("Changed", "#f59e0b", diff.changed, (e) => {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:6px 8px;background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;" +
        "border-radius:4px;margin:3px 0;font-size:11px";
      const lines = (e.changedColumns ?? []).slice(0, 8).map(
        (c: any) =>
          `<div style="opacity:.85;font-family:var(--font-mono,monospace)">` +
          `${c.key}: <s style="opacity:.6">${String(c.before ?? "—")}</s> → <b>${String(c.after ?? "—")}</b></div>`,
      );
      row.innerHTML = `<div style="font-weight:600">${e.rowId}</div>` + lines.join("");
      return row;
    }),
  );

  tableWrap.appendChild(banner);
  tableWrap.appendChild(container);
}

function describeValues(values: Record<string, any>): string {
  const keys = Object.keys(values).slice(0, 3);
  return keys.map((k) => `${k}=${values[k]}`).join(" · ") || "(no values)";
}

/* ═════════════════════════════════════════════════════════════════════════
   Regenerate
   ═════════════════════════════════════════════════════════════════════════ */
async function regenerate(): Promise<void> {
  if (running) return;
  running = true;
  loading.style.display = "flex";
  loadingBarInner.style.width = "0%";
  cancelHandle = { cancelled: false };

  try {
    clearIfcScheduleCache();
    const run = await runSchedule(currentDefinition, {
      signal: cancelHandle,
      onProgress: (p) => {
        loadingText.textContent = p.phase;
        loadingBarInner.style.width = `${Math.min(95, (p.current / Math.max(1, p.total)) * 100)}%`;
      },
    });
    if (cancelHandle.cancelled) return;
    currentRun = run;
    sortKey = currentDefinition.sortBy ?? null;
    sortDir = 1;
    currentDiff = null;
    renderTable();
    renderFooter();
  } catch (err) {
    console.error("[schedule] failed", err);
    alert("Schedule generation failed — see console.");
  } finally {
    running = false;
    loading.style.display = "none";
    cancelHandle = null;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Snapshot / diff
   ═════════════════════════════════════════════════════════════════════════ */
function takeSnapshotNow(): void {
  if (!currentRun) {
    alert("Run the schedule first.");
    return;
  }
  const label = prompt("Snapshot label:", `Run ${new Date().toLocaleString()}`);
  if (label == null) return;
  takeSnapshot(currentRun, label);
  alert(`Snapshot saved with ${currentRun.rows.length} rows.`);
}

function showLatestDiff(): void {
  if (!currentRun) {
    alert("Run the schedule first.");
    return;
  }
  const snaps = listSnapshots(currentDefinition.id);
  if (!snaps.length) {
    alert("No snapshots for this schedule yet. Take one first.");
    return;
  }
  currentDiff = diffAgainstSnapshot(currentRun, snaps[0]);
  renderTable();
}

/* ═════════════════════════════════════════════════════════════════════════
   Row link
   ═════════════════════════════════════════════════════════════════════════ */
async function selectLinked(row: ScheduleRow) {
  if (row.subtotal || !row.link) return;
  try {
    const sel = (ctx.features as any).selection;
    if (row.link.kind === "ifc" && row.link.modelId != null && row.link.localId != null) {
      if (sel?.replace) {
        sel.replace({ [row.link.modelId]: new Set([row.link.localId]) });
        await sel.applyToHighlighter?.();
      }
      try {
        const cam = await import("./camera-tools");
        await cam.fitToMap?.({ [row.link.modelId]: new Set([row.link.localId]) } as any);
      } catch {
        /* */
      }
    } else if (row.link.kind === "authored" && row.link.authoredId) {
      const authoring = (ctx.features as any).authoring;
      if (authoring?.selectAllAuthored) {
        authoring.selectAllAuthored([row.link.authoredId]);
      }
    }
  } catch (err) {
    console.warn("[schedule] select failed", err);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Footer
   ═════════════════════════════════════════════════════════════════════════ */
function renderFooter(): void {
  footer.innerHTML = "";
  const info = document.createElement("span");
  info.style.cssText = "opacity:.75";
  if (currentRun) {
    const dataRows = currentRun.rows.filter((r) => !r.subtotal).length;
    info.textContent =
      `${dataRows} rows · ` +
      `${currentRun.rows.filter((r) => r.source === "authored").length} authored · ` +
      `${currentRun.rows.filter((r) => r.source === "ifc").length} IFC · ` +
      `${currentRun.rows.filter((r) => r.subtotal).length} group rows · ` +
      `generated ${new Date(currentRun.generatedAt).toLocaleTimeString()}`;
  } else {
    info.textContent = "No schedule yet";
  }
  const savedCount = listSavedSchedules().length;
  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;opacity:.55";
  hint.textContent =
    `${savedCount} saved · ƒ = formula · Esc to close`;
  footer.append(info, hint);
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
export function toggleSchedules() {
  const visible = overlay.style.display === "flex";
  overlay.style.display = visible ? "none" : "flex";
  if (!visible) {
    visibleColumns = new Set(
      currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key),
    );
    renderHeader();
    renderControls();
    renderFooter();
    if (!currentRun) void regenerate();
    else renderTable();
  }
}

export function isSchedulesVisible(): boolean {
  return overlay.style.display === "flex";
}

export function setupSchedulesPanel() {
  document.body.appendChild(overlay);
  overlay.append(header, controls, stage, footer);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isSchedulesVisible()) {
      if (currentDiff) {
        currentDiff = null;
        renderTable();
        return;
      }
      toggleSchedules();
    }
  });

  ctx.features.schedules = {
    toggle: toggleSchedules,
    isVisible: isSchedulesVisible,
    regenerate: () => void regenerate(),
    setDefinition: (def: ScheduleDefinition) => {
      currentDefinition = def;
      visibleColumns = new Set(
        currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key),
      );
      renderHeader();
      renderControls();
      void regenerate();
    },
    getDefinition: () => currentDefinition,
    takeSnapshot: (label?: string) => currentRun ? takeSnapshot(currentRun, label) : null,
    listSnapshots: () => listSnapshots(currentDefinition.id),
    diffLatest: () => {
      if (!currentRun) return null;
      const snaps = listSnapshots(currentDefinition.id);
      if (!snaps.length) return null;
      currentDiff = diffAgainstSnapshot(currentRun, snaps[0]);
      renderTable();
      return currentDiff;
    },
    clearSnapshots: (id?: string) => {
      if (id) deleteSnapshot(id);
      else for (const s of listSnapshots(currentDefinition.id)) deleteSnapshot(s.id);
    },
    save: () => saveCurrent(),
    listSaved: () => listSavedSchedules(),
    load: (id: string) => {
      const s = getSavedSchedule(id);
      if (!s) return false;
      currentDefinition = s;
      visibleColumns = new Set(
        currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key),
      );
      void regenerate();
      renderHeader();
      return true;
    },
    deleteSaved: (id: string) => deleteSchedule(id),
    duplicateSaved: (id: string) => duplicateSchedule(id),
    buildAndSave: (spec: ScheduleSpec) => {
      const def = buildSchedule(spec);
      const stored = saveSchedule(def);
      currentDefinition = stored;
      visibleColumns = new Set(
        currentDefinition.columns.filter((c) => !c.hidden).map((c) => c.key),
      );
      void regenerate();
      renderHeader();
      return stored;
    },
  };
}