/**
 * Sheets 2D panel â€” renders sheets with live viewport content.
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
import {
  listSheets, getSheet, createSheet, deleteSheet, updateSheet,
  addViewport, removeViewport, onSheetsChange, getSheetSizeMm,
  ensureDefaultTitleblock,
} from "../modules/sheets/sheets";
import { listViews, getView } from "../modules/views/store";
import { generatePlanScene } from "../modules/views/generators/plan";
import { generateSectionScene } from "../modules/views/generators/section";
import { generateElevationScene } from "../modules/views/generators/elevation";
import { renderSceneToSvg } from "../modules/views/renderers/svg";
import { buildAnnotationLayer } from "../modules/views/annotation-layer";
import { emptyScene, type Scene2D } from "../modules/views/scene";
import { computeViewportTransform } from "../modules/views/sheet-layout";
import { downloadSingleSheetPdf, exportAllSheetsToPdf } from "../modules/export/sheet-pdf";
import type { ViewDef } from "../modules/views/types";
import type { SheetDef, SheetViewport } from "../modules/projects/types";

const SVG_NS = "http://www.w3.org/2000/svg";
const PANEL_ID = "obs-sheets-2d-panel";

let panel: HTMLDivElement | null = null;
let sheetListEl: HTMLDivElement | null = null;
let canvasHost: HTMLDivElement | null = null;
let viewPicker: HTMLSelectElement | null = null;
let statusEl: HTMLSpanElement | null = null;
let currentSheetId: string | null = null;
let selectedVpId: string | null = null;
let visible = false;

const sceneCache = new Map<string, { scene: Scene2D; at: number }>();

interface DragState {
  vpId: string;
  startMouseX: number;
  startMouseY: number;
  startVpX: number;
  startVpY: number;
  sheetMmPerPx: number;
}
let drag: DragState | null = null;

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
  ensureDefaultTitleblock();

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "left:400px",
    "top:90px",
    "right:14px",
    "bottom:40px",
    "z-index:36",
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
    currentSheetId = s.id;
    selectedVpId = null;
    render();
  });
  const delSheetBtn = mkBtn("Delete Sheet", () => {
    if (!currentSheetId) return;
    const s = getSheet(currentSheetId);
    if (!s) return;
    if (confirm("Delete sheet \"" + s.number + " - " + s.name + "\"?")) {
      deleteSheet(currentSheetId);
      currentSheetId = null;
      selectedVpId = null;
      render();
    }
  });
  const delVpBtn = mkBtn("Delete Viewport", () => {
    if (!currentSheetId || !selectedVpId) return;
    removeViewport(currentSheetId, selectedVpId);
    selectedVpId = null;
    render();
  });
  const exportBtn = mkBtn("Export SVG", () => exportSheet());

  const pdfBtn = mkBtn("Export PDF", () => {
    if (!currentSheetId) { alert("No sheet selected."); return; }
    void downloadSingleSheetPdf(currentSheetId).catch((err) => {
      console.error("[sheets-2d] PDF export failed", err);
      alert("PDF export failed: " + (err && err.message ? err.message : err));
    });
  });

  const pdfAllBtn = mkBtn("PDF All", () => {
    const sheets = listSheets();
    if (!sheets.length) { alert("No sheets to export."); return; }
    void exportAllSheetsToPdf(sheets, "open-bim-studio-sheets.pdf").catch((err) => {
      console.error("[sheets-2d] batch PDF failed", err);
      alert("Batch PDF failed: " + (err && err.message ? err.message : err));
    });
  });




  const closeBtn = mkBtn("Close", () => toggleSheets2dPanel());

  header.append(title, viewPicker, addVpBtn, newSheetBtn, delSheetBtn, delVpBtn, exportBtn, pdfBtn, pdfAllBtn, closeBtn);

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
    invalidateCache: () => sceneCache.clear(),
  };
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
  addText(tbX + 3, tbY + 22, "Scale: as noted", 3.5, 400, "#475569");
  addText(tbX + 3, tbY + 28, "Date: " + new Date().toISOString().slice(0, 10), 3.5, 400, "#475569");
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
  const tf = computeViewportTransform(vp, sheet, viewDef, scene);

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

  const sceneSvg = renderSceneToSvg(scene, {
    scale: viewDef.scale,
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

  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", String(tf.x + 1));
  label.setAttribute("y", String(tf.y - 1.5));
  label.setAttribute("font-size", "3.5");
  label.setAttribute("font-weight", "600");
  label.setAttribute("fill", "#334155");
  label.setAttribute("font-family", "system-ui, sans-serif");
  label.textContent = (vp.title || viewDef.name) + " - " + (vp.scale || "1:" + viewDef.scale);
  svg.appendChild(label);
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
  } else {
    scene = emptyScene();
  }
  const ann = buildAnnotationLayer(viewDef.id, viewDef.scale);
  scene.layers.annotation = ann.entities;
  sceneCache.set(viewDef.id, { scene, at: now });
  return scene;
}

function installDragHandler(svg: SVGSVGElement, sheet: SheetDef, sheetWmm: number): void {
  svg.addEventListener("mousedown", (ev) => {
    const target = ev.target as Element;
    const directId = target.getAttribute ? target.getAttribute("data-viewport-border") : null;
    const parent = target.parentElement as Element | null;
    const innerId = parent && parent.getAttribute ? parent.getAttribute("data-viewport-id") : null;
    const vpId = directId || innerId;

    if (!vpId) {
      if (selectedVpId) { selectedVpId = null; render(); }
      return;
    }
    const vp = sheet.viewports.find((v) => v.id === vpId);
    if (!vp) return;

    if (selectedVpId !== vpId) {
      selectedVpId = vpId;
      render();
      return;
    }

    const rect = svg.getBoundingClientRect();
    const sheetMmPerPx = sheetWmm / rect.width;
    drag = {
      vpId,
      startMouseX: ev.clientX,
      startMouseY: ev.clientY,
      startVpX: vp.x,
      startVpY: vp.y,
      sheetMmPerPx,
    };
    ev.preventDefault();
  });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

function onDragMove(ev: MouseEvent): void {
  if (!drag || !currentSheetId) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const vp = sheet.viewports.find((v) => v.id === drag!.vpId);
  if (!vp) return;
  const dx = (ev.clientX - drag.startMouseX) * drag.sheetMmPerPx;
  const dy = (ev.clientY - drag.startMouseY) * drag.sheetMmPerPx;
  vp.x = Math.round((drag.startVpX + dx) * 10) / 10;
  vp.y = Math.round((drag.startVpY + dy) * 10) / 10;
  scheduleRender();
}

function onDragEnd(): void {
  if (!drag) return;
  drag = null;
  if (currentSheetId) updateSheet(currentSheetId, {});
}

function addSelectedViewport(): void {
  if (!currentSheetId || !viewPicker) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const viewId = viewPicker.value;
  if (!viewId) { alert("No views available. Open the Views panel first."); return; }
  const viewDef = getView(viewId);
  if (!viewDef) return;

  const sizeMm = getSheetSizeMm(sheet.size, sheet.orientation);
  const offset = sheet.viewports.length * 15;
  const vpWidth = Math.min(400, sizeMm.w * 0.5);
  const vpHeight = Math.min(280, sizeMm.h * 0.5);
  const viewType: SheetViewport["viewType"] =
    (viewDef.kind === "plan" || viewDef.kind === "rcp") ? "plan"
    : viewDef.kind === "section" ? "section"
    : viewDef.kind === "elevation" ? "elevation"
    : "3d";

  addViewport(currentSheetId, {
    viewId,
    viewType,
    x: 20 + offset,
    y: 20 + offset,
    width: vpWidth,
    height: vpHeight,
    scale: "1:" + viewDef.scale,
    title: viewDef.name,
  });
  render();
}

function exportSheet(): void {
  if (!currentSheetId || !canvasHost) return;
  const sheet = getSheet(currentSheetId);
  if (!sheet) return;
  const svgEl = canvasHost.querySelector("svg");
  if (!svgEl) { alert("Nothing to export."); return; }
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
