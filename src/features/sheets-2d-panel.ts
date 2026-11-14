/**
 * Sheets 2D panel — renders sheets with live viewport content.
 *
 * Composes:
 *   - the sheets store (list/create/delete sheets, add/remove viewports)
 *   - the views store (list ViewDefs)
 *   - the view generators (plan / section / elevation)
 *   - the SVG renderer + annotation layer
 *
 * Viewports are drag-moveable and clip their content to the viewport rect.
 */

import { ctx } from "../core/context";
import { register as registerService } from "../core/services";
import {
  listSheets, getSheet, createSheet, deleteSheet, updateSheet,
  addViewport, removeViewport, onSheetsChange, getSheetSizeMm,
  ensureDefaultTitleblock, listTitleblocks,
  bootSheetsStore, cloneSheet, cloneTitleblock,
  addSheetAnnotation, updateSheetAnnotation, removeSheetAnnotation,
  updateTitleblock,
} from "../modules/sheets/sheets";
import { listViews, getView } from "../modules/views/store";
import { generatePlanScene } from "../modules/views/generators/plan";
import { generateSectionScene } from "../modules/views/generators/section";
import { generateElevationScene } from "../modules/views/generators/elevation";
import { generateScheduleScene } from "../modules/views/generators/schedule";
import { renderSceneToSvg } from "../modules/views/renderers/svg";
import { buildAnnotationLayer } from "../modules/views/annotation-layer";
import { emptyScene, type Scene2D } from "../modules/views/scene";
import { computeViewportTransform } from "../modules/views/sheet-layout";
import {
  northArrowPlacement, northArrowSvg, scaleBarLayout,
  scaleBarSvg, titleblockRows, viewTitleText, viewportCaptionY,
} from "../modules/sheets/sheet-furniture";
import { downloadSingleSheetPdf, exportAllSheetsToPdf } from "../modules/export/sheet-pdf";
import type { ViewDef } from "../modules/views/types";
import type { SheetDef, SheetViewport } from "../modules/projects/types";
import { getElements, getGrids, getLevels } from "./authoring";
import { validateNativeModel, summarizeDiagnostics } from "../modules/native-bim/model-validation";
import { validateDocumentationSet, summarizeDocumentationDiagnostics } from "../modules/native-bim/documentation-validation";
import { uiAlert } from "../core/notify";
import { confirmDialog, promptLine, openFormModal } from "./form-modal";
import { pushSheetChange, pushTitleblockChange } from "../modules/sheets/sheet-undo";
import { exportSheetToPdf } from "../modules/export/sheet-pdf";
import type { SheetAnnotation } from "../modules/sheets/sheets";

const SVG_NS = "http://www.w3.org/2000/svg";
const PANEL_ID = "obs-sheets-2d-panel";

let panel: HTMLDivElement | null = null;
let sheetListEl: HTMLDivElement | null = null;
let canvasHost: HTMLDivElement | null = null;
let viewPicker: HTMLSelectElement | null = null;
let statusEl: HTMLSpanElement | null = null;
let currentSheetId: string | null = null;
let selectedVpId: string | null = null;
let selectedAnnId: string | null = null;
let visible = false;

const sceneCache = new Map<string, { scene: Scene2D; at: number }>();

interface DragState {
  vpId: string;
  startMouseX: number;
  startMouseY: number;
  startVpX: number;
  startVpY: number;
  sheetMmPerPx: number;
  /** Deep sheet snapshot taken at drag start — the undo revert target. */
  beforeSheet: SheetDef;
}

/**
 * Sheet-level note placement: asks for the text, then drops the note at a
 * free spot near the sheet's top-left drawing area (drag refines the place).
 */
async function addSheetNote(): Promise<void> {
  if (!currentSheetId) { uiAlert("No sheet selected."); return; }
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const text = await promptLine("Add note", "Note text", "");
  if (text == null || !text.trim()) return;
  const before = cloneSheet(sheet);
  const n = (sheet.annotations ?? []).length;
  const x = 12 + (n % 4) * 4;
  const y = 14 + n * 6;
  addSheetAnnotation(sheet.id, { text: text.trim(), x, y });
  const after = getSheet(sheet.id);
  pushSheetChange("Add note", before, after ? cloneSheet(after) : null);
  selectedAnnId = null;
  render();
}

/** Edit the active sheet's titleblock fields (the same TitleblockDef the exports render). */
async function editTitleblock(): Promise<void> {
  if (!currentSheetId) { uiAlert("No sheet selected."); return; }
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const tb = listTitleblocks().find((t) => t.id === sheet.titleblockId);
  if (!tb) { uiAlert("This sheet has no titleblock."); return; }
  const values = await openFormModal({
    title: "Edit Titleblock",
    subtitle: sheet.number + " - " + sheet.name,
    fields: tb.fields.map((f) => ({
      kind: "text" as const,
      key: f.key,
      label: f.label,
      default: f.value,
    })),
    submitLabel: "Apply",
  });
  if (!values) return;
  const beforeTb = cloneTitleblock(tb);
  const afterTb = cloneTitleblock(tb);
  for (const f of afterTb.fields) {
    if (typeof values[f.key] === "string") f.value = values[f.key];
  }
  updateTitleblock(tb.id, { fields: afterTb.fields });
  pushTitleblockChange("Edit titleblock", beforeTb, afterTb);
  render();
}
let drag: DragState | null = null;

let qaPanel: HTMLDivElement | null = null;
let pendingRender = false;
function scheduleRender(): void {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    render();
  });
}

export function setupSheets2dPanel(): void {
  bootSheetsStore(); // hydrate sheets + default titleblock (idempotent)

  // The command palette ("Sheets" panel command) and drafting-bridge resolve
  // the panel under the service key "sheetsPanel" — a key nothing registered,
  // so "Toggle Sheets" only toasted "Sheets panel is not loaded" (same break
  // class the schedules panel had). Register the facade under the key the
  // rest of the app looks up, and alias the feature handle.
  try {
    registerService("sheetsPanel", {
      toggle: () => toggleSheets2dPanel(),
      isVisible: () => visible,
    });
  } catch { /* re-registration during HMR overwrites — safe to ignore */ }

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "left:400px",
    "top:90px",
    "right:14px",
    "bottom:40px",
    // Above the plan workspace overlay (z=200) — at the old z=36 the panel
    // opened INVISIBLE behind the Floor Plan, so sheets could only be seen
    // from the CAD/3D workspaces. Same tier as the Schedules overlay (340).
    "z-index:340",
    "display:none",
    "flex-direction:column",
    "background:#1a1d27",
    "color:#e8eaf0",
    "border:1px solid #2a2e3a",
    "border-radius:10px",
    "box-shadow:0 12px 36px rgba(0,0,0,.55)",
    "font:12px system-ui,sans-serif",
    "overflow:hidden",
  ].join(";");
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:8px 10px;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0;flex-wrap:wrap";

  const title = document.createElement("div");
  title.textContent = "Sheets";
  title.style.cssText = "font-weight:700;margin-right:8px";

  viewPicker = document.createElement("select");
  viewPicker.style.cssText =
    "padding:4px 8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;" +
    "color:#e8eaf0;font:11px system-ui;max-width:220px";

  const addVpBtn = mkBtn("+ Viewport", () => addSelectedViewport());
  const newSheetBtn = mkBtn("+ Sheet", () => {
    const s = createSheet();
    pushSheetChange("Create sheet", null, s);
    currentSheetId = s.id;
    selectedVpId = null;
    render();
  });
  const delSheetBtn = mkBtn("Delete Sheet", () => {
    if (!currentSheetId) return;
    const sheetId = currentSheetId;
    const s = getSheet(sheetId);
    if (!s) return;
    void confirmDialog("Delete sheet", "Delete sheet \"" + s.number + " - " + s.name + "\"?").then((ok) => {
      if (!ok) return;
      const before = cloneSheet(s);
      deleteSheet(sheetId);
      pushSheetChange("Delete sheet", before, null);
      if (currentSheetId === sheetId) currentSheetId = null;
      selectedVpId = null;
      render();
    });
  });
  const delVpBtn = mkBtn("Delete Viewport", () => {
    if (!currentSheetId || !selectedVpId) return;
    const before = getSheet(currentSheetId);
    if (!before) return;
    const snapshotBefore = cloneSheet(before);
    removeViewport(currentSheetId, selectedVpId);
    const after = getSheet(currentSheetId);
    pushSheetChange("Delete viewport", snapshotBefore, after ? cloneSheet(after) : null);
    selectedVpId = null;
    render();
  });
  const qaBtn = mkBtn("Model QA", () => toggleModelQa());

  const exportBtn = mkBtn("Export SVG", () => exportSheet());

  const pdfBtn = mkBtn("Export PDF", () => {
    if (!currentSheetId) { uiAlert("No sheet selected."); return; }
    void downloadSingleSheetPdf(currentSheetId).catch((err) => {
      console.error("[sheets-2d] PDF export failed", err);
      uiAlert("PDF export failed: " + (err && err.message ? err.message : err));
    });
  });

  const pdfAllBtn = mkBtn("PDF All", () => {
    const sheets = listSheets();
    if (!sheets.length) { uiAlert("No sheets to export."); return; }
    void exportAllSheetsToPdf(sheets, "open-bim-studio-sheets.pdf").catch((err) => {
      console.error("[sheets-2d] batch PDF failed", err);
      uiAlert("Batch PDF failed: " + (err && err.message ? err.message : err));
    });
  });

  // Print: renders the same PDF the export produces and hands it to the
  // browser's print preview — one code path, no re-implemented plotting.
  const printBtn = mkBtn("Print", () => {
    if (!currentSheetId) { uiAlert("No sheet selected."); return; }
    void exportSheetToPdf(currentSheetId).then((bytes) => {
      if (!bytes) { uiAlert("Nothing to print."); return; }
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }).catch((err) => {
      console.error("[sheets-2d] print failed", err);
      uiAlert("Print failed: " + (err && err.message ? err.message : err));
    });
  });

  // Sheet-level note (SheetDef.annotations): text placed on the sheet itself,
  // outside any viewport. Drag to move, double-click to edit, Del removes.
  const addNoteBtn = mkBtn("+ Note", () => { void addSheetNote(); });
  const delNoteBtn = mkBtn("Delete Note", () => {
    if (!currentSheetId || !selectedAnnId) { uiAlert("Click a note first."); return; }
    const sheet = getSheet(currentSheetId);
    const ann = sheet?.annotations?.find((a) => a.id === selectedAnnId);
    if (!sheet || !ann) { selectedAnnId = null; render(); return; }
    const before = cloneSheet(sheet);
    removeSheetAnnotation(sheet.id, ann.id);
    const after = getSheet(sheet.id);
    pushSheetChange("Delete note", before, after ? cloneSheet(after) : null);
    selectedAnnId = null;
    render();
  });

  // Editable titleblock fields — the same TitleblockDef the exports render.
  const tbBtn = mkBtn("Edit Titleblock", () => { void editTitleblock(); });




  const closeBtn = mkBtn("Close", () => toggleSheets2dPanel());

  header.append(title, viewPicker, addVpBtn, newSheetBtn, delSheetBtn, delVpBtn, addNoteBtn, delNoteBtn, tbBtn, qaBtn, exportBtn, pdfBtn, pdfAllBtn, printBtn, closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "flex:1;display:flex;min-height:0";

  sheetListEl = document.createElement("div");
  sheetListEl.style.cssText =
    "width:220px;flex:none;border-right:1px solid #2a2e3a;overflow-y:auto;background:#0e1017";

  canvasHost = document.createElement("div");
  canvasHost.style.cssText =
    "flex:1;overflow:auto;background:#e9ecf1;position:relative;padding:20px;box-sizing:border-box";

  body.append(sheetListEl, canvasHost);

  const footer = document.createElement("div");
  footer.style.cssText =
    "padding:6px 12px;border-top:1px solid #2a2e3a;background:#12141b;" +
    "display:flex;justify-content:space-between;font:11px system-ui;color:#94a3b8;flex-shrink:0";
  statusEl = document.createElement("span");
  statusEl.style.cssText = "font:11px system-ui;color:#94a3b8";
  footer.append(
    document.createTextNode("Click a viewport to select. Drag to move."),
    statusEl,
  );

  panel.append(header, body, footer);
  ctx.rightHost.appendChild(panel);

  onSheetsChange(() => { if (visible) scheduleRender(); });

  (ctx.features as any).sheets2dPanel = {
    open: () => { visible = true; if (panel) panel.style.display = "flex"; render(); },
    close: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => toggleSheets2dPanel(),
    isVisible: () => visible,
    invalidateCache: () => invalidateSceneCaches(),
  };
  // Alias under the key drafting-bridge (and older callers) look up. The
  // facade has no addToCurrentSheet, so drafting-bridge will report the
  // truthful "does not support drafting attachment yet" instead of lying
  // about a missing panel.
  (ctx.features as any).sheetsPanel = (ctx.features as any).sheets2dPanel;
}

function getDocumentationDiagnostics() {
  const sheets = listSheets();
  const views = listViews();
  const sheetSizesMm: Record<string, { w: number; h: number }> = {};
  for (const sheet of sheets) sheetSizesMm[sheet.id] = getSheetSizeMm(sheet.size, sheet.orientation);
  return validateDocumentationSet({
    sheets: sheets.map(sheet => ({
      id: sheet.id, number: sheet.number, name: sheet.name, size: sheet.size,
      orientation: sheet.orientation, viewports: sheet.viewports,
    })),
    views: views.map(view => ({ id: view.id, name: view.name, scale: view.scale })),
    sheetSizesMm,
  });
}

function toggleModelQa(): void {
  if (qaPanel) {
    qaPanel.remove();
    qaPanel = null;
    return;
  }
  if (!panel) return;
  qaPanel = document.createElement("div");
  qaPanel.style.cssText = [
    "position:absolute", "inset:42px 0 0 0", "z-index:5",
    "display:flex", "flex-direction:column", "min-height:0",
    "background:#11151f", "color:#e8eaf0", "border-top:1px solid #343b4a",
    "box-shadow:0 8px 30px rgba(0,0,0,.35)", "font:12px system-ui,sans-serif"
  ].join(";");
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #2a2e3a";
  const heading = document.createElement("strong");
  heading.textContent = "Native Model QA";
  const close = mkBtn("Close QA", () => { qaPanel?.remove(); qaPanel = null; });
  head.append(heading, close);
  const content = document.createElement("div");
  content.style.cssText = "overflow:auto;padding:12px 14px;flex:1";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px";
  const refresh = mkBtn("Run validation", () => renderModelQa(content));
  const exportReport = mkBtn("Export report JSON", () => {
    const snapshot = { elements: getElements(), levels: getLevels(), grids: getGrids() };
    const diagnostics = validateNativeModel(snapshot);
    const documentation = getDocumentationDiagnostics();
    const report = { generatedAt: new Date().toISOString(), elementCount: snapshot.elements.length, levelCount: snapshot.levels.length, gridCount: snapshot.grids.length, modelSummary: summarizeDiagnostics(diagnostics), modelDiagnostics: diagnostics, documentationSummary: summarizeDocumentationDiagnostics(documentation), documentationDiagnostics: documentation };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "openbimstudio-model-qa.json";
    a.click();
    URL.revokeObjectURL(url);
  });
  actions.append(refresh, exportReport);
  content.append(actions);
  qaPanel.append(head, content);
  panel.appendChild(qaPanel);
  renderModelQa(content);
}

function renderModelQa(content: HTMLDivElement): void {
  // Keep action buttons in place while refreshing only the results section.
  const old = content.querySelector("[data-qa-results]");
  old?.remove();
  const snapshot = { elements: getElements(), levels: getLevels(), grids: getGrids() };
  const modelDiagnostics = validateNativeModel(snapshot);
  const documentationDiagnostics = getDocumentationDiagnostics();
  const diagnostics = [...modelDiagnostics.map(d => ({ ...d, scope: "Model" })), ...documentationDiagnostics.map(d => ({ code: d.code, severity: d.severity, message: d.message, elementId: d.viewportId ?? d.sheetId, relatedId: d.relatedId, path: d.sheetId ? "sheet:" + d.sheetId : undefined, scope: "Documentation" }))];
  const modelSummary = summarizeDiagnostics(modelDiagnostics);
  const docSummary = summarizeDocumentationDiagnostics(documentationDiagnostics);
  const summary = { errors: modelSummary.errors + docSummary.errors, warnings: modelSummary.warnings + docSummary.warnings };
  const results = document.createElement("div");
  results.dataset.qaResults = "true";
  const metrics = document.createElement("div");
  metrics.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 14px";
  const metric = (label: string, value: number, color: string) => {
    const item = document.createElement("div");
    item.style.cssText = "padding:8px 12px;border:1px solid #303848;border-radius:6px;min-width:86px";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    strong.style.cssText = "display:block;font-size:18px;color:" + color;
    const caption = document.createElement("span");
    caption.textContent = label;
    caption.style.cssText = "color:#9aa7bb";
    item.append(strong, caption);
    metrics.appendChild(item);
  };
  metric("Elements", snapshot.elements.length, "#e8eaf0");
  metric("Levels", snapshot.levels.length, "#e8eaf0");
  metric("Grids", snapshot.grids.length, "#e8eaf0");
  metric("Errors", summary.errors, summary.errors ? "#fb7185" : "#34d399");
  metric("Warnings", summary.warnings, summary.warnings ? "#fbbf24" : "#34d399");
  metric("Sheets", listSheets().length, "#e8eaf0");
  metric("Views", listViews().length, "#e8eaf0");
  results.appendChild(metrics);
  const status = document.createElement("p");
  status.style.cssText = "margin:0 0 12px;color:" + (summary.errors ? "#fb7185" : "#34d399");
  status.textContent = summary.errors ? "Validation found blocking errors. Review the diagnostics below." : "No blocking errors detected by the current validation rules.";
  results.appendChild(status);
  if (!diagnostics.length) {
    const clean = document.createElement("p");
    clean.textContent = "No warnings or errors were reported. This is a rule-based check, not an engineering approval or IFC certification.";
    clean.style.cssText = "color:#9aa7bb";
    results.appendChild(clean);
  } else {
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;text-align:left";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["Scope", "Severity", "Code", "Element / Viewport", "Message"]) {
      const th = document.createElement("th");
      th.textContent = label;
      th.style.cssText = "padding:8px;border-bottom:1px solid #394254;color:#9aa7bb";
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const d of diagnostics) {
      const tr = document.createElement("tr");
      const values = [d.scope, d.severity.toUpperCase(), d.code, d.elementId ?? "—", d.message + (d.path ? " (" + d.path + ")" : "")];
      values.forEach((value, i) => {
        const td = document.createElement("td");
        td.textContent = value;
        td.style.cssText = "padding:8px;border-bottom:1px solid #252c39;vertical-align:top;overflow-wrap:anywhere";
        if (i === 0) td.style.color = d.severity === "error" ? "#fb7185" : d.severity === "warning" ? "#fbbf24" : "#93c5fd";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    results.appendChild(table);
  }
  content.appendChild(results);
}

function mkBtn(label: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "padding:4px 9px;background:transparent;color:#cbd5e1;border:1px solid #2a2e3a;" +
    "border-radius:4px;cursor:pointer;font:11px system-ui";
  b.onmouseenter = () => { b.style.background = "#1e2330"; };
  b.onmouseleave = () => { b.style.background = "transparent"; };
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function render(): void {
  if (!panel || !sheetListEl || !canvasHost || !viewPicker) return;
  const sheets = listSheets();

  // View picker options
  const views = listViews();
  const prevPickerValue = viewPicker.value;
  viewPicker.innerHTML = "";
  if (!views.length) {
    const opt = document.createElement("option");
    opt.textContent = "(no views - open the Views panel first)";
    opt.value = "";
    viewPicker.appendChild(opt);
  } else {
    for (const v of views) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name + "  (" + v.kind + ")";
      viewPicker.appendChild(opt);
    }
    viewPicker.value = views.some((v) => v.id === prevPickerValue) ? prevPickerValue : views[0].id;
  }

  // Sheet list
  sheetListEl.innerHTML = "";
  if (!sheets.length) {
    const hint = document.createElement("div");
    hint.textContent = "No sheets. Click + Sheet.";
    hint.style.cssText = "padding:14px;color:#6b7280;font-size:11px;text-align:center";
    sheetListEl.appendChild(hint);
  } else {
    for (const s of sheets) {
      const row = document.createElement("div");
      const active = s.id === currentSheetId;
      row.style.cssText =
        "padding:8px 10px;cursor:pointer;border-bottom:1px solid #1a1d27;" +
        (active ? "background:#16233a;color:#38bdf8;" : "color:#cbd5e1;");
      row.textContent = s.number + " - " + s.name;
      row.onclick = () => { currentSheetId = s.id; selectedVpId = null; render(); };
      sheetListEl.appendChild(row);
    }
  }
  if (!currentSheetId && sheets.length) currentSheetId = sheets[0].id;

  canvasHost.innerHTML = "";
  if (!currentSheetId) {
    const hint = document.createElement("div");
    hint.textContent = "Create or select a sheet.";
    hint.style.cssText = "padding:40px;text-align:center;color:#6b7280;font:13px system-ui";
    canvasHost.appendChild(hint);
    return;
  }
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;

  void drawSheet(sheet);
}

async function drawSheet(sheet: SheetDef): Promise<void> {
  if (!canvasHost) return;
  const sizeMm = getSheetSizeMm(sheet.size, sheet.orientation);
  const sheetWmm = sizeMm.w;
  const sheetHmm = sizeMm.h;
  const hostW = canvasHost.clientWidth || 800;
  const targetWidth = Math.min(hostW - 40, sheetWmm * 0.9);
  const targetHeight = (sheetHmm / sheetWmm) * targetWidth;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 " + sheetWmm + " " + sheetHmm);
  svg.setAttribute("width", String(targetWidth));
  svg.setAttribute("height", String(targetHeight));
  svg.style.cssText =
    "display:block;background:#ffffff;border:1px solid #cbd5e1;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.12)";

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(sheetWmm));
  bg.setAttribute("height", String(sheetHmm));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  const border = document.createElementNS(SVG_NS, "rect");
  border.setAttribute("x", "6");
  border.setAttribute("y", "6");
  border.setAttribute("width", String(sheetWmm - 12));
  border.setAttribute("height", String(sheetHmm - 12));
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", "#111827");
  border.setAttribute("stroke-width", "0.4");
  svg.appendChild(border);

  // Titleblock
  const tbW = Math.min(180, sheetWmm * 0.28);
  const tbH = 40;
  const tbX = sheetWmm - 6 - tbW;
  const tbY = sheetHmm - 6 - tbH;
  const tb = document.createElementNS(SVG_NS, "rect");
  tb.setAttribute("x", String(tbX));
  tb.setAttribute("y", String(tbY));
  tb.setAttribute("width", String(tbW));
  tb.setAttribute("height", String(tbH));
  tb.setAttribute("fill", "#f8fafc");
  tb.setAttribute("stroke", "#111827");
  tb.setAttribute("stroke-width", "0.3");
  svg.appendChild(tb);

  // North arrow — top-right inside the border, same placement as the exports
  const na = northArrowPlacement(sheetWmm, sheetHmm, 6, 8, sheet.viewports);
  if (na.visible) {
    const naG = document.createElementNS(SVG_NS, "g");
    naG.innerHTML = northArrowSvg(na.cx, na.cy, 8);
    svg.appendChild(naG);
  }

  const addText = (x: number, y: number, text: string, size: number, weight: number, color: string) => {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("font-family", "Arial, system-ui, sans-serif");
    t.setAttribute("font-size", String(size));
    t.setAttribute("font-weight", String(weight));
    t.setAttribute("fill", color);
    t.textContent = text;
    svg.appendChild(t);
  };
  addText(tbX + 3, tbY + 8, "Sheet: " + sheet.number, 5, 700, "#111827");
  addText(tbX + 3, tbY + 15, sheet.name, 4, 400, "#111827");
  // Real titleblock fields — same source of truth as the SVG / PDF exports
  const tbDef = listTitleblocks().find((t) => t.id === sheet.titleblockId);
  const rows = titleblockRows(tbDef, sheet, new Date().toISOString().slice(0, 10), sheet.viewports.map((v) => v.scale));
  const priority = ["scale", "date", "rev", "drawn", "checked"];
  const picked = rows
    .filter((r) => r.label.trim().toLowerCase() !== "project")
    .sort((a, b) => {
      const ai = priority.indexOf(a.label.trim().toLowerCase());
      const bi = priority.indexOf(b.label.trim().toLowerCase());
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .slice(0, 3);
  picked.forEach((r, i) => {
    addText(tbX + 3, tbY + 22 + i * 6, r.label + ": " + r.value, 3.5, 400, "#475569");
  });
  addText(tbX + 3, tbY + 34, "Open BIM Studio", 3, 400, "#94a3b8");

  // Draw viewports
  for (const vp of sheet.viewports) {
    const viewDef = getView(vp.viewId);
    if (!viewDef) {
      drawMissingViewport(svg, vp);
      continue;
    }
    let scene: Scene2D;
    try {
      scene = await getSceneForView(viewDef);
    } catch (err) {
      console.warn("[sheets-2d] scene failed for", viewDef.id, err);
      scene = emptyScene();
    }
    drawViewport(svg, sheet, vp, viewDef, scene);
  }

  // Sheet-level notes (SheetDef.annotations) — same source the exports render.
  for (const ann of sheet.annotations ?? []) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(ann.x));
    t.setAttribute("y", String(ann.y));
    t.setAttribute("font-size", "3.2");
    t.setAttribute("font-family", "system-ui, sans-serif");
    t.setAttribute("fill", selectedAnnId === ann.id ? "#0284c7" : "#111827");
    t.setAttribute("font-weight", selectedAnnId === ann.id ? "700" : "400");
    t.setAttribute("data-ann-id", ann.id);
    t.style.cursor = "move";
    t.textContent = ann.text;
    svg.appendChild(t);
  }

  canvasHost.appendChild(svg);
  installDragHandler(svg, sheet, sheetWmm);

  if (statusEl) {
    statusEl.textContent =
      sheet.viewports.length + " viewport(s) - " +
      sheet.size + " " + sheet.orientation + " - " +
      sheetWmm + "x" + sheetHmm + " mm";
  }
}

function drawMissingViewport(svg: SVGSVGElement, vp: SheetViewport): void {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(vp.x));
  rect.setAttribute("y", String(vp.y));
  rect.setAttribute("width", String(vp.width));
  rect.setAttribute("height", String(vp.height));
  rect.setAttribute("fill", "#fee2e2");
  rect.setAttribute("stroke", "#ef4444");
  rect.setAttribute("stroke-width", "0.4");
  rect.setAttribute("stroke-dasharray", "2 1");
  svg.appendChild(rect);

  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", String(vp.x + vp.width / 2));
  t.setAttribute("y", String(vp.y + vp.height / 2));
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("font-size", "4");
  t.setAttribute("fill", "#991b1b");
  t.setAttribute("font-family", "system-ui, sans-serif");
  t.textContent = "View missing: " + vp.viewId;
  svg.appendChild(t);
}

function drawViewport(
  svg: SVGSVGElement,
  sheet: SheetDef,
  vp: SheetViewport,
  viewDef: ViewDef,
  scene: Scene2D,
): void {
  // The incoming scene is the generator's BASE scene (no annotations). Build
  // the annotation layer at the viewport's EFFECTIVE scale — the same value
  // the SVG composer and the PDF composer use — so a 2.5 mm dimension text
  // measures 2.5 mm on paper in all three output paths.
  const tf = computeViewportTransform(vp, sheet, viewDef, scene);
  const scaled = getSceneAtScale(viewDef, scene, tf.scaleDenom);

  const clipId = "clip-" + vp.id.replace(/[^a-z0-9-]/gi, "_");
  const clipPath = document.createElementNS(SVG_NS, "clipPath");
  clipPath.setAttribute("id", clipId);
  const clipRect = document.createElementNS(SVG_NS, "rect");
  clipRect.setAttribute("x", String(tf.x));
  clipRect.setAttribute("y", String(tf.y));
  clipRect.setAttribute("width", String(tf.widthMm));
  clipRect.setAttribute("height", String(tf.heightMm));
  clipPath.appendChild(clipRect);
  svg.appendChild(clipPath);

  const inner = document.createElementNS(SVG_NS, "svg");
  inner.setAttribute("x", String(tf.x));
  inner.setAttribute("y", String(tf.y));
  inner.setAttribute("width", String(tf.widthMm));
  inner.setAttribute("height", String(tf.heightMm));
  inner.setAttribute(
    "viewBox",
    tf.viewBox.x + " " + tf.viewBox.y + " " + tf.viewBox.w + " " + tf.viewBox.h,
  );
  inner.setAttribute("preserveAspectRatio", "xMidYMid slice");
  inner.setAttribute("clip-path", "url(#" + clipId + ")");
  inner.setAttribute("data-viewport-id", vp.id);

  const sceneSvg = renderSceneToSvg(scaled, {
    scale: tf.scaleDenom,
    padding: 0,
    widthPx: tf.widthMm,
    heightPx: tf.heightMm,
  });
  const g = document.createElementNS(SVG_NS, "g");
  while (sceneSvg.firstChild) {
    g.appendChild(sceneSvg.firstChild);
  }
  inner.appendChild(g);
  svg.appendChild(inner);

  const borderRect = document.createElementNS(SVG_NS, "rect");
  borderRect.setAttribute("x", String(tf.x));
  borderRect.setAttribute("y", String(tf.y));
  borderRect.setAttribute("width", String(tf.widthMm));
  borderRect.setAttribute("height", String(tf.heightMm));
  borderRect.setAttribute("fill", "none");
  borderRect.setAttribute("stroke", selectedVpId === vp.id ? "#38bdf8" : "#334155");
  borderRect.setAttribute("stroke-width", selectedVpId === vp.id ? "0.8" : "0.3");
  borderRect.setAttribute("data-viewport-border", vp.id);
  svg.appendChild(borderRect);

  // Revit-style caption below the viewport (name · scale) + graphic scale bar —
  // mirrors the SVG / PDF composers so the screen tells the same truth.
  const sheetHmm = getSheetSizeMm(sheet.size, sheet.orientation).h;
  const caption = viewportCaptionY(vp.y + vp.height, sheetHmm - 7);
  const capText = document.createElementNS(SVG_NS, "text");
  capText.setAttribute("x", String(tf.x));
  capText.setAttribute("y", String(caption.titleY));
  capText.setAttribute("font-size", "3");
  capText.setAttribute("font-weight", "600");
  capText.setAttribute("fill", "#334155");
  capText.setAttribute("font-family", "system-ui, sans-serif");
  capText.textContent = viewTitleText(vp, viewDef.name);
  svg.appendChild(capText);
  if (vp.viewType !== "schedule") {
    const layout = scaleBarLayout(tf.scaleDenom);
    if (vp.width >= layout.barLengthMm + 2 && caption.barBaselineY < sheetHmm - 7) {
      const barG = document.createElementNS(SVG_NS, "g");
      barG.innerHTML = scaleBarSvg(tf.x + 2, caption.barBaselineY, layout);
      svg.appendChild(barG);
    }
  }
}

async function getSceneForView(viewDef: ViewDef): Promise<Scene2D> {
  const now = Date.now();
  const cached = sceneCache.get(viewDef.id);
  if (cached && now - cached.at < 15000) return cached.scene;

  let scene: Scene2D;
  if (viewDef.kind === "plan" || viewDef.kind === "rcp") {
    scene = await generatePlanScene(viewDef);
  } else if (viewDef.kind === "section") {
    scene = await generateSectionScene(viewDef);
  } else if (viewDef.kind === "elevation") {
    scene = await generateElevationScene(viewDef);
  } else if (viewDef.kind === "schedule") {
    scene = await generateScheduleScene(viewDef);
  } else {
    scene = emptyScene();
  }
  sceneCache.set(viewDef.id, { scene, at: now });
  return scene;
}

/**
 * Annotation layer rebuilt at an explicit paper scale, cached per
 * (view, scale). Viewports whose effective scale differs from the view's
 * declared scale (content-fit, or a viewport pinned to another scale) must
 * build their dimensions at the scale they actually show — otherwise a
 * 2.5 mm dimension text on screen does not match the SVG / PDF export.
 */
const annotationScaleCache = new Map<string, Scene2D>();

function getSceneAtScale(viewDef: ViewDef, base: Scene2D, scaleDenom: number): Scene2D {
  const key = viewDef.id + ":" + scaleDenom;
  const hit = annotationScaleCache.get(key);
  if (hit) return hit;
  const ann = buildAnnotationLayer(viewDef.id, scaleDenom);
  const scene: Scene2D = { ...base, layers: { ...base.layers, annotation: ann.entities } };
  annotationScaleCache.set(key, scene);
  return scene;
}

function invalidateSceneCaches(): void {
  sceneCache.clear();
  annotationScaleCache.clear();
}

function installDragHandler(svg: SVGSVGElement, sheet: SheetDef, sheetWmm: number): void {
  svg.addEventListener("mousedown", (ev) => {
    const target = ev.target as Element;
    const directId = target.getAttribute ? target.getAttribute("data-viewport-border") : null;
    const parent = target.parentElement as Element | null;
    const innerId = parent && parent.getAttribute ? parent.getAttribute("data-viewport-id") : null;
    const vpId = directId || innerId;
    const annEl = target.closest("[data-ann-id]");
    const annId = annEl ? annEl.getAttribute("data-ann-id") : null;

    if (!vpId && !annId) {
      if (selectedVpId || selectedAnnId) { selectedVpId = null; selectedAnnId = null; render(); }
      return;
    }

    const rect = svg.getBoundingClientRect();
    const sheetMmPerPx = sheetWmm / rect.width;

    if (annId) {
      const ann = (sheet.annotations ?? []).find((a) => a.id === annId);
      if (!ann) return;
      if (selectedAnnId !== annId) {
        selectedAnnId = annId;
        selectedVpId = null;
        render();
        return;
      }
      drag = {
        vpId: "",
        startMouseX: ev.clientX,
        startMouseY: ev.clientY,
        startVpX: ann.x,
        startVpY: ann.y,
        sheetMmPerPx,
        beforeSheet: cloneSheet(sheet),
      };
      ev.preventDefault();
      return;
    }

    const vp = sheet.viewports.find((v) => v.id === vpId);
    if (!vp || !vpId) return;

    if (selectedVpId !== vpId) {
      selectedVpId = vpId;
      selectedAnnId = null;
      render();
      return;
    }

    drag = {
      vpId: vpId,
      startMouseX: ev.clientX,
      startMouseY: ev.clientY,
      startVpX: vp.x,
      startVpY: vp.y,
      sheetMmPerPx,
      beforeSheet: cloneSheet(sheet),
    };
    ev.preventDefault();
  });

  svg.addEventListener("dblclick", (ev) => {
    const target = ev.target as Element;
    const annEl = target.closest("[data-ann-id]");
    const annId = annEl ? annEl.getAttribute("data-ann-id") : null;
    if (!annId || !currentSheetId) return;
    void editSheetNoteText(currentSheetId, annId);
  });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

/** Double-click on a note: replace its text (undoable). */
async function editSheetNoteText(sheetId: string, annId: string): Promise<void> {
  const sheet = getSheet(sheetId);
  const ann = sheet?.annotations?.find((a) => a.id === annId);
  if (!sheet || !ann) return;
  const text = await promptLine("Edit note", "Note text", ann.text);
  if (text == null || !text.trim() || text.trim() === ann.text) return;
  const before = cloneSheet(sheet);
  updateSheetAnnotation(sheetId, annId, { text: text.trim() });
  const after = getSheet(sheetId);
  pushSheetChange("Edit note", before, after ? cloneSheet(after) : null);
  render();
}

function onDragMove(ev: MouseEvent): void {
  if (!drag || !currentSheetId) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const dx = (ev.clientX - drag.startMouseX) * drag.sheetMmPerPx;
  const dy = (ev.clientY - drag.startMouseY) * drag.sheetMmPerPx;
  if (drag.vpId) {
    const vp = sheet.viewports.find((v) => v.id === drag!.vpId);
    if (!vp) return;
    vp.x = Math.round((drag.startVpX + dx) * 10) / 10;
    vp.y = Math.round((drag.startVpY + dy) * 10) / 10;
  } else {
    const ann = (sheet.annotations ?? []).find((a) => a.id === selectedAnnId);
    if (!ann) return;
    ann.x = Math.round((drag.startVpX + dx) * 10) / 10;
    ann.y = Math.round((drag.startVpY + dy) * 10) / 10;
  }
  scheduleRender();
}

function onDragEnd(): void {
  if (!drag) return;
  const state = drag;
  drag = null;
  if (!currentSheetId) return;
  const after = getSheet(currentSheetId);
  if (!after) return;
  const afterSnap = cloneSheet(after);
  const beforeSnap = state.beforeSheet;
  // Push undo only when something actually moved.
  const moved =
    JSON.stringify(beforeSnap.viewports) !== JSON.stringify(afterSnap.viewports) ||
    JSON.stringify(beforeSnap.annotations ?? []) !== JSON.stringify(afterSnap.annotations ?? []);
  if (!moved) return;
  updateSheet(currentSheetId, {}); // stamp updatedAt so the save state turns dirty
  pushSheetChange(state.vpId ? "Move viewport" : "Move note", beforeSnap, afterSnap);
}

function addSelectedViewport(): void {
  if (!currentSheetId || !viewPicker) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const viewId = viewPicker.value;
  if (!viewId) { uiAlert("No views available. Open the Views panel first."); return; }
  const viewDef = getView(viewId);
  if (!viewDef) return;

  const sizeMm = getSheetSizeMm(sheet.size, sheet.orientation);
  const offset = sheet.viewports.length * 15;
  const vpWidth = Math.min(400, sizeMm.w * 0.5);
  const vpHeight = Math.min(280, sizeMm.h * 0.5);
  const isSchedule = viewDef.kind === "schedule";
  const viewType: SheetViewport["viewType"] =
    (viewDef.kind === "plan" || viewDef.kind === "rcp") ? "plan"
    : viewDef.kind === "section" ? "section"
    : viewDef.kind === "elevation" ? "elevation"
    : isSchedule ? "schedule"
    : "3d";

  const before = cloneSheet(sheet);
  addViewport(currentSheetId, {
    viewId,
    viewType,
    x: 20 + offset,
    y: 20 + offset,
    width: vpWidth,
    height: vpHeight,
    scale: isSchedule ? "1:1" : "1:" + viewDef.scale,
    title: viewDef.name,
  });
  if (isSchedule) {
    // Fit the viewport to the table's true paper size (scene units are mm/1000).
    void getSceneForView(viewDef).then((scene) => {
      const sh = getSheet(currentSheetId!);
      if (!sh) return;
      const vp2 = sh.viewports[sh.viewports.length - 1];
      if (!vp2 || vp2.viewId !== viewDef.id) return;
      const wMm = Math.ceil((scene.bounds.maxX - scene.bounds.minX) * 1000) + 8;
      const hMm = Math.ceil((scene.bounds.maxZ - scene.bounds.minZ) * 1000) + 8;
      vp2.width = Math.min(Math.max(60, wMm), sizeMm.w - 40);
      vp2.height = Math.min(Math.max(40, hMm), sizeMm.h - 60);
      updateSheet(currentSheetId!, {});
      const after = getSheet(currentSheetId!);
      pushSheetChange("Add viewport", before, after ? cloneSheet(after) : null);
      render();
    }).catch(() => { /* placeholder scene already renders */ });
  } else {
    const after = getSheet(currentSheetId);
    pushSheetChange("Add viewport", before, after ? cloneSheet(after) : null);
  }
  render();
}

function exportSheet(): void {
  if (!currentSheetId || !canvasHost) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const svgEl = canvasHost.querySelector("svg");
  if (!svgEl) { uiAlert("Nothing to export."); return; }
  const xml = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob(
    ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + xml],
    { type: "image/svg+xml" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sheet.number.replace(/[^a-z0-9-]/gi, "_") + ".svg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export function toggleSheets2dPanel(): void {
  visible = !visible;
  if (!panel) return;
  panel.style.display = visible ? "flex" : "none";
  if (visible) render();
}
export function isSheets2dPanelVisible(): boolean { return visible; }
export function openSheets2dPanel(): void {
  visible = true;
  if (panel) { panel.style.display = "flex"; render(); }
}
