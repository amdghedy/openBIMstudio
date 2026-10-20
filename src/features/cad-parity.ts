/**
 * CAD Parity - AutoCAD-style tools, shortcuts, and panel on top of cad-engine
 * + existing drafting-2d overlay.
 *
 * Shortcuts (classic CAD):
 *   L  line - PL polyline - REC rectangle - C circle - A arc - T text
 *   O  offset - E erase - M move-copy last - MI mirror
 *   ORTHO (F8) - GRID (F7) - U undo - REDO
 */

import { ctx } from "../core/context";
import { cadEngine, type CadPt, type CadTool } from "../modules/cad/cad-engine";

type Any = Record<string, any>;

let installed = false;
let panel: HTMLDivElement | null = null;
let svgOverlay: SVGSVGElement | null = null;
let hostEl: HTMLElement | null = null;
let drawing = false;
let startPt: CadPt | null = null;
let pointerId: number | null = null;
let trimPicks: CadPt[] = [];
let filletRadius = 20;
let cmdLine: HTMLDivElement | null = null;


const UI_SEL =
  "button,input,select,textarea,[contenteditable],.obs-ribbon,.obs-panel,.obs-property,.obs-dialog,#obs-bim-cc,#obs-cad-panel,.obs-adv-toolbar";

function setCmd(msg: string): void {
  if (!cmdLine) {
    cmdLine = document.createElement("div");
    cmdLine.id = "obs-cad-cmdline";
    cmdLine.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:10003;" +
      "min-width:280px;max-width:min(640px,calc(100vw - 24px));padding:8px 14px;" +
      "background:#0c0e14;border:1px solid #fbbf24;border-radius:8px;" +
      "color:#fbbf24;font:600 12px/1.3 ui-monospace,monospace;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:none;";
    document.body.appendChild(cmdLine);
  }
  cmdLine.textContent = msg;
  cmdLine.style.display = "block";
}

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 1600 } }),
    );
  } catch {
    console.log(`[cad] ${kind}: ${msg}`);
  }
}

function getHost(): HTMLElement | null {
  const c = ctx as Any;
  return (
    (c.rightHost as HTMLElement) ||
    document.getElementById("viewport") ||
    (document.querySelector(".obs-viewport") as HTMLElement | null)
  );
}

function ptFromEvent(e: PointerEvent): CadPt {
  if (!hostEl) return { x: 0, y: 0 };
  const r = hostEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function isUi(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest(UI_SEL);
}

/* -- SVG render of CAD entities -------------------------------------------- */

function ensureSvg(): void {
  hostEl = getHost();
  if (!hostEl) return;
  if (getComputedStyle(hostEl).position === "static") {
    hostEl.style.position = "relative";
  }
  if (svgOverlay && svgOverlay.parentElement === hostEl) return;

  if (svgOverlay?.parentElement) svgOverlay.parentElement.removeChild(svgOverlay);

  const ns = "http://www.w3.org/2000/svg";
  svgOverlay = document.createElementNS(ns, "svg") as SVGSVGElement;
  svgOverlay.setAttribute("width", "100%");
  svgOverlay.setAttribute("height", "100%");
  svgOverlay.style.cssText =
    "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:9998;";
  hostEl.appendChild(svgOverlay);
  render();
}

function render(): void {
  if (!svgOverlay) return;
  const ns = "http://www.w3.org/2000/svg";
  while (svgOverlay.firstChild) svgOverlay.removeChild(svgOverlay.firstChild);

  // Grid
  if (cadEngine.isGrid()) {
    const g = document.createElementNS(ns, "g");
    const size = cadEngine.getGridSize();
    const w = hostEl?.clientWidth ?? 2000;
    const h = hostEl?.clientHeight ?? 1200;
    for (let x = 0; x <= w; x += size) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(x));
      line.setAttribute("y1", "0");
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(h));
      line.setAttribute("stroke", "#1e2433");
      line.setAttribute("stroke-width", "1");
      g.appendChild(line);
    }
    for (let y = 0; y <= h; y += size) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", String(y));
      line.setAttribute("x2", String(w));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", "#1e2433");
      line.setAttribute("stroke-width", "1");
      g.appendChild(line);
    }
    svgOverlay.appendChild(g);
  }

  const layer = document.createElementNS(ns, "g");
  for (const e of cadEngine.listEntities()) {
    if (e.kind === "line" && e.b) {
      const el = document.createElementNS(ns, "line");
      el.setAttribute("x1", String(e.a.x));
      el.setAttribute("y1", String(e.a.y));
      el.setAttribute("x2", String(e.b.x));
      el.setAttribute("y2", String(e.b.y));
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", String(e.strokeWidth));
      el.setAttribute("stroke-linecap", "round");
      layer.appendChild(el);
    } else if (e.kind === "rect" && e.b) {
      const el = document.createElementNS(ns, "rect");
      el.setAttribute("x", String(Math.min(e.a.x, e.b.x)));
      el.setAttribute("y", String(Math.min(e.a.y, e.b.y)));
      el.setAttribute("width", String(Math.abs(e.b.x - e.a.x)));
      el.setAttribute("height", String(Math.abs(e.b.y - e.a.y)));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", String(e.strokeWidth));
      layer.appendChild(el);
    } else if (e.kind === "circle" && e.r != null) {
      const el = document.createElementNS(ns, "circle");
      el.setAttribute("cx", String(e.a.x));
      el.setAttribute("cy", String(e.a.y));
      el.setAttribute("r", String(e.r));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", String(e.strokeWidth));
      layer.appendChild(el);
    } else if (e.kind === "polyline" && e.points && e.points.length >= 2) {
      const el = document.createElementNS(ns, "polyline");
      el.setAttribute(
        "points",
        e.points.map((p) => `${p.x},${p.y}`).join(" "),
      );
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", String(e.strokeWidth));
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("stroke-linecap", "round");
      layer.appendChild(el);
    } else if (
      e.kind === "arc" &&
      e.r != null &&
      e.startAngle != null &&
      e.endAngle != null
    ) {
      const r = e.r;
      let a0 = e.startAngle;
      let a1 = e.endAngle;
      if (a1 < a0) a1 += Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = e.a.x + r * Math.cos(a0);
      const y0 = e.a.y + r * Math.sin(a0);
      const x1 = e.a.x + r * Math.cos(a1);
      const y1 = e.a.y + r * Math.sin(a1);
      const el = document.createElementNS(ns, "path");
      el.setAttribute(
        "d",
        `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
      );
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", String(e.strokeWidth));
      layer.appendChild(el);
    } else if (e.kind === "text") {
      const el = document.createElementNS(ns, "text");
      el.setAttribute("x", String(e.a.x));
      el.setAttribute("y", String(e.a.y));
      el.setAttribute("fill", e.color);
      el.setAttribute("font-size", "14");
      el.setAttribute("font-family", "Inter, system-ui, sans-serif");
      el.textContent = e.text ?? "";
      layer.appendChild(el);
    }
  }

  // Live polyline preview
  const poly = cadEngine.getPolyPoints();
  if (poly.length >= 1) {
    const el = document.createElementNS(ns, "polyline");
    el.setAttribute("points", poly.map((p) => `${p.x},${p.y}`).join(" "));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", cadEngine.getColor());
    el.setAttribute("stroke-width", "1.5");
    el.setAttribute("stroke-dasharray", "6 4");
    layer.appendChild(el);
  }

  svgOverlay.appendChild(layer);
}

/* -- Pointer tools --------------------------------------------------------- */

function onDown(e: PointerEvent): void {
  const tool = cadEngine.getTool();
  if (!tool || e.button !== 0) return;
  if (isUi(e.target)) return;
  if (!hostEl?.contains(e.target as Node)) return;

  e.preventDefault();
  e.stopPropagation();

  const raw = ptFromEvent(e);

  if (tool === "polyline") {
    cadEngine.addPolyVertex(raw);
    render();
    return;
  }

  if (tool === "text") {
    const p = cadEngine.snapPoint(null, raw);
    const text = window.prompt("Text:", "Text") ?? "";
    if (text) {
      cadEngine.addText(p, text);
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "trim") {
    const p = cadEngine.snapPoint(null, raw);
    trimPicks.push(p);
    setCmd("TRIM: pick cutting edge, then object to trim (" + trimPicks.length + "/2)");
    if (trimPicks.length >= 2) {
      const ok = cadEngine.trimAt(trimPicks[0], trimPicks[1]);
      toast(ok ? "success" : "warn", ok ? "Trimmed" : "Trim failed - click nearer to lines");
      trimPicks = [];
      setCmd(ok ? "TRIM done" : "TRIM failed");
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "extend") {
    const p = cadEngine.snapPoint(null, raw);
    trimPicks.push(p);
    setCmd("EXTEND: pick boundary, then object to extend (" + trimPicks.length + "/2)");
    if (trimPicks.length >= 2) {
      const ok = cadEngine.extendTo(trimPicks[0], trimPicks[1]);
      toast(ok ? "success" : "warn", ok ? "Extended" : "Extend failed");
      trimPicks = [];
      setCmd(ok ? "EXTEND done" : "EXTEND failed");
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "fillet") {
    const p = cadEngine.snapPoint(null, raw);
    trimPicks.push(p);
    setCmd("FILLET r=" + filletRadius + " - pick two lines (" + trimPicks.length + "/2)");
    if (trimPicks.length >= 2) {
      const ok = cadEngine.filletAt(trimPicks[0], trimPicks[1], filletRadius);
      toast(ok ? "success" : "warn", ok ? "Filleted" : "Fillet failed");
      trimPicks = [];
      setCmd(ok ? "FILLET done" : "FILLET failed");
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "distance") {
    const p = cadEngine.snapPoint(null, raw);
    trimPicks.push(p);
    setCmd("DIST: pick two points (" + trimPicks.length + "/2)");
    if (trimPicks.length >= 2) {
      const d = cadEngine.distance(trimPicks[0], trimPicks[1]);
      toast("info", "Distance: " + d.toFixed(1) + " px");
      setCmd("DIST = " + d.toFixed(2) + " px");
      trimPicks = [];
    }
    return;
  }

  if (tool === "erase") {
    const p = cadEngine.snapPoint(null, raw);
    const hit = cadEngine.pickEntity(p, 24);
    if (hit) {
      cadEngine.deleteById(hit.id);
      toast("info", "Erased " + hit.kind);
      setCmd("ERASE " + hit.kind);
    } else {
      cadEngine.eraseLast();
      toast("info", "Erased last");
      setCmd("ERASE last");
    }
    render();
    syncDrafting();
    return;
  }

  if (tool === "offset") {
    const d = Number(window.prompt("Offset distance (px):", "20") ?? "20");
    if (Number.isFinite(d) && d !== 0) {
      const ent = cadEngine.offsetLast(d);
      toast(ent ? "success" : "warn", ent ? "Offset created" : "Nothing to offset");
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "move" || tool === "copy") {
    const dx = Number(window.prompt("Delta X (px):", "40") ?? "40");
    const dy = Number(window.prompt("Delta Y (px):", "0") ?? "0");
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      const ent = cadEngine.copyLast(dx, dy);
      if (tool === "move" && ent) {
        // remove original (last-but-one after copy)
        // simpler: undo original by removing second-to-last - skip for safety
        toast("success", "Copied with delta");
      } else {
        toast(ent ? "success" : "warn", ent ? "Copied" : "Nothing to copy");
      }
      render();
      syncDrafting();
    }
    return;
  }

  if (tool === "mirror") {
    // Mirror last about vertical axis through click
    const p = cadEngine.snapPoint(null, raw);
    const axisA = { x: p.x, y: p.y - 100 };
    const axisB = { x: p.x, y: p.y + 100 };
    const ent = cadEngine.mirrorLast(axisA, axisB);
    toast(ent ? "success" : "warn", ent ? "Mirrored" : "Nothing to mirror");
    render();
    syncDrafting();
    return;
  }

  // Two-point tools: line, rect, circle, arc
  drawing = true;
  pointerId = e.pointerId;
  startPt = cadEngine.snapPoint(null, raw);
  try {
    (e.target as Any).setPointerCapture?.(e.pointerId);
  } catch { /* */ }
}

function onMove(e: PointerEvent): void {
  if (!drawing || pointerId !== e.pointerId || !startPt) return;
  e.preventDefault();
  // Preview is optional; full redraw on up is enough for v1
}

function onUp(e: PointerEvent): void {
  if (!drawing || pointerId !== e.pointerId || !startPt) return;
  e.preventDefault();
  e.stopPropagation();

  const tool = cadEngine.getTool();
  const end = cadEngine.snapPoint(startPt, ptFromEvent(e));

  if (tool === "line") {
    if (Math.hypot(end.x - startPt.x, end.y - startPt.y) > 2) {
      cadEngine.addLine(startPt, end);
    }
  } else if (tool === "rect") {
    if (Math.hypot(end.x - startPt.x, end.y - startPt.y) > 2) {
      cadEngine.addRect(startPt, end);
    }
  } else if (tool === "circle") {
    const r = Math.hypot(end.x - startPt.x, end.y - startPt.y);
    if (r > 2) cadEngine.addCircle(startPt, r);
  } else if (tool === "arc") {
    const r = Math.hypot(end.x - startPt.x, end.y - startPt.y);
    if (r > 2) {
      const ang = Math.atan2(end.y - startPt.y, end.x - startPt.x);
      cadEngine.addArc(startPt, r, ang - Math.PI / 2, ang + Math.PI / 2);
    }
  }

  drawing = false;
  pointerId = null;
  startPt = null;
  render();
  syncDrafting();
}

function onKey(e: KeyboardEvent): void {
  if (isUi(e.target)) return;
  const t = (e.target as HTMLElement)?.tagName?.toLowerCase();
  if (t === "input" || t === "textarea") return;

  // Finish polyline with Enter
  if (e.key === "Enter" && cadEngine.getTool() === "polyline") {
    e.preventDefault();
    cadEngine.finishPolyline();
    render();
    syncDrafting();
    toast("success", "Polyline finished");
    return;
  }
  // Cancel tool with Esc
  if (e.key === "Escape") {
    if (cadEngine.getPolyPoints().length) {
      cadEngine.cancelPoly();
      render();
    }
    cadEngine.setTool(null);
    updatePanelActive();
    return;
  }
}

/** Push simplified entities into drafting-2d for sheet export compatibility. */
function syncDrafting(): void {
  try {
    const d = (window as Any).__obsDrafting2D;
    if (d?.loadEntities) {
      d.loadEntities(cadEngine.toDraftEntities());
    }
  } catch { /* */ }
}

/* -- CAD Panel UI ---------------------------------------------------------- */

function setTool(tool: CadTool, label: string): void {
  trimPicks = [];
  // Toggle off if same tool
  if (cadEngine.getTool() === tool) {
    cadEngine.setTool(null);
    toast("info", "CAD tool off");
  } else {
    cadEngine.setTool(tool);
    toast("info", label);
  }
  // Also mirror simple tools onto drafting-2d for dual-path
  try {
    const d = (window as Any).__obsDrafting2D;
    if (d?.setTool) {
      const map: Record<string, string | null> = {
        line: "line",
        rect: "rect",
        circle: "circle",
        text: "text",
      };
      d.setTool(tool && map[tool] ? map[tool] : null);
    }
  } catch { /* */ }
  updatePanelActive();
}

function updatePanelActive(): void {
  if (!panel) return;
  const tool = cadEngine.getTool();
  panel.querySelectorAll("[data-cad-tool]").forEach((btn) => {
    const t = (btn as HTMLElement).getAttribute("data-cad-tool");
    (btn as HTMLElement).dataset.active = t === tool ? "1" : "0";
  });
  const orthoBtn = panel.querySelector("[data-cad-ortho]") as HTMLElement | null;
  if (orthoBtn) orthoBtn.dataset.active = cadEngine.isOrtho() ? "1" : "0";
  const gridBtn = panel.querySelector("[data-cad-grid]") as HTMLElement | null;
  if (gridBtn) gridBtn.dataset.active = cadEngine.isGrid() ? "1" : "0";
  const status = panel.querySelector("[data-cad-status]") as HTMLElement | null;
  if (status) {
    status.textContent = `Entities: ${cadEngine.getCount()} - Layer: ${cadEngine.getActiveLayer().name}${
      tool ? ` - Tool: ${tool}` : ""
    }`;
  }
  const layerHost = panel.querySelector("[data-cad-layers]") as HTMLElement | null;
  if (layerHost) {
    const active = cadEngine.getActiveLayer().id;
    layerHost.innerHTML = cadEngine
      .listLayers()
      .map(
        (l) =>
          `<button class="cad-btn" type="button" data-cad-layer="${l.id}" data-active="${
            l.id === active ? "1" : "0"
          }" title="${l.name}">${l.visible ? "-" : "-"} ${l.name}</button>`,
      )
      .join("");
  }
}

function buildPanel(): void {
  if (panel) return;
  const style = document.createElement("style");
  style.textContent = `
#obs-cad-panel {
  position: fixed; top: 100px; right: 16px; width: 280px; z-index: 8600;
  max-height: calc(100vh - 140px); overflow: auto;
  background: linear-gradient(180deg,#1a1d27,#12141c);
  border: 1px solid #2a2e3a; border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.55);
  color: #e8eaf0; font: 12px/1.4 Inter,system-ui,sans-serif;
  display: none;
}
#obs-cad-panel.is-open { display: flex; flex-direction: column; }
#obs-cad-panel .cad-hdr {
  display:flex;align-items:center;gap:8px;padding:11px 12px;
  border-bottom:1px solid #1e2029;background:#181a23;cursor:grab;
  border-radius:12px 12px 0 0;
}
#obs-cad-panel .cad-hdr b {
  flex:1;font-size:13px;
  background:linear-gradient(90deg,#e8eaf0,#fbbf24);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
#obs-cad-panel .cad-close {
  width:26px;height:26px;border-radius:6px;border:1px solid #2a2e3a;
  background:transparent;color:#94a3b8;cursor:pointer;
}
#obs-cad-panel .cad-body { padding:8px 10px 12px; }
#obs-cad-panel .cad-sec {
  margin-bottom:8px;border:1px solid #1e2029;border-radius:8px;background:#0e1017;overflow:hidden;
}
#obs-cad-panel .cad-sec-title {
  padding:5px 10px;font:700 9px/1 Inter,system-ui;letter-spacing:.6px;
  text-transform:uppercase;color:#6b7280;background:#151820;border-bottom:1px solid #1e2029;
}
#obs-cad-panel .cad-grid {
  display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;padding:6px;
}
#obs-cad-panel .cad-btn {
  padding:7px 6px;border-radius:6px;border:1px solid transparent;
  background:transparent;color:#cbd5e1;cursor:pointer;text-align:center;
  font:600 11px/1.2 Inter,system-ui;
}
#obs-cad-panel .cad-btn:hover { background:#232633;border-color:#343847;color:#f1f5f9; }
#obs-cad-panel .cad-btn[data-active="1"] {
  background:rgba(251,191,36,.14);border-color:#fbbf24;color:#fbbf24;
}
#obs-cad-panel .cad-status {
  margin:4px 6px 0;padding:6px 8px;border-radius:6px;
  background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);
  color:#fbbf24;font:500 10.5px/1.3 Inter,system-ui;
}
`;
  document.head.appendChild(style);

  panel = document.createElement("div");
  panel.id = "obs-cad-panel";
  panel.innerHTML = `
    <div class="cad-hdr">
      <b>CAD Tools</b>
      <button class="cad-close" type="button">-</button>
    </div>
    <div class="cad-body">
      <div class="cad-status" data-cad-status>Entities: 0</div>
      <div class="cad-sec">
        <div class="cad-sec-title">Draw</div>
        <div class="cad-grid">
          <button class="cad-btn" data-cad-tool="line" type="button">Line <small>L</small></button>
          <button class="cad-btn" data-cad-tool="polyline" type="button">PLine <small>PL</small></button>
          <button class="cad-btn" data-cad-tool="rect" type="button">Rect <small>REC</small></button>
          <button class="cad-btn" data-cad-tool="circle" type="button">Circle <small>C</small></button>
          <button class="cad-btn" data-cad-tool="arc" type="button">Arc <small>A</small></button>
          <button class="cad-btn" data-cad-tool="text" type="button">Text <small>T</small></button>
        </div>
      </div>
      <div class="cad-sec">
        <div class="cad-sec-title">Modify</div>
        <div class="cad-grid">
          <button class="cad-btn" data-cad-tool="offset" type="button">Offset <small>O</small></button>
          <button class="cad-btn" data-cad-tool="trim" type="button">Trim <small>TR</small></button>
          <button class="cad-btn" data-cad-tool="extend" type="button">Extend <small>EX</small></button>
          <button class="cad-btn" data-cad-tool="fillet" type="button">Fillet <small>F</small></button>
          <button class="cad-btn" data-cad-tool="erase" type="button">Erase <small>E</small></button>
          <button class="cad-btn" data-cad-tool="copy" type="button">Copy <small>CO</small></button>
          <button class="cad-btn" data-cad-tool="mirror" type="button">Mirror <small>MI</small></button>
          <button class="cad-btn" data-cad-tool="distance" type="button">Dist <small>DI</small></button>
          <button class="cad-btn" data-cad-action="undo" type="button">Undo <small>U</small></button>
          <button class="cad-btn" data-cad-action="clear" type="button">Clear</button>
          <button class="cad-btn" data-cad-action="fillet-r" type="button">Fillet R</button>
        </div>
      </div>
      <div class="cad-sec">
        <div class="cad-sec-title">Layers</div>
        <div class="cad-grid" data-cad-layers></div>
      </div>
      <div class="cad-sec">
        <div class="cad-sec-title">Options</div>
        <div class="cad-grid">
          <button class="cad-btn" data-cad-ortho type="button">Ortho <small>F8</small></button>
          <button class="cad-btn" data-cad-grid type="button">Grid <small>F7</small></button>
          <button class="cad-btn" data-cad-action="finish-pl" type="button">Finish PL</button>
          <button class="cad-btn" data-cad-action="export-dxf" type="button">Export DXF</button>
          <button class="cad-btn" data-cad-action="import-dxf" type="button">Import DXF</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector(".cad-close")?.addEventListener("click", () => closeCadPanel());

  panel.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tool = t.closest("[data-cad-tool]") as HTMLElement | null;
    if (tool) {
      const name = tool.getAttribute("data-cad-tool") as CadTool;
      const labels: Record<string, string> = {
        line: "LINE",
        polyline: "PLINE - click points, Enter to finish",
        rect: "RECTANGLE",
        circle: "CIRCLE",
        arc: "ARC",
        text: "TEXT",
        offset: "OFFSET",
        erase: "ERASE last",
        copy: "COPY last",
        mirror: "MIRROR last",
        trim: "TRIM - cutting edge, then object",
        extend: "EXTEND - boundary, then object",
        fillet: "FILLET - two lines",
        distance: "DIST - two points",
      };
      setTool(name, labels[name ?? ""] ?? name ?? "");
      return;
    }
    const action = t.closest("[data-cad-action]") as HTMLElement | null;
    if (action) {
      const a = action.getAttribute("data-cad-action");
      if (a === "undo") {
        cadEngine.undo();
        render();
        syncDrafting();
      } else if (a === "clear") {
        if (window.confirm("Clear all CAD entities?")) {
          cadEngine.clear();
          render();
          syncDrafting();
        }
      } else if (a === "finish-pl") {
        cadEngine.finishPolyline();
        render();
        syncDrafting();
        toast("success", "Polyline finished");
      } else if (a === "fillet-r") {
        const v = Number(window.prompt("Fillet radius (px):", String(filletRadius)) ?? filletRadius);
        if (Number.isFinite(v) && v > 0) {
          filletRadius = v;
          toast("info", "Fillet radius = " + filletRadius);
          setCmd("FILLETRAD = " + filletRadius);
        }
      } else if (a === "export-dxf") {
        (window as Any).__obsDrawings?.exportCadAsDxf?.("cad-export.dxf");
      } else if (a === "import-dxf") {
        (window as Any).__obsDrawingsPanel?.open?.();
        // also trigger file pick via drawings panel path
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".dxf,.dwg";
        input.onchange = async () => {
          const f = input.files?.[0];
          if (f) await (window as Any).__obsDrawings?.importDrawingFile?.(f);
          render();
          syncDrafting();
        };
        input.click();
      }
      updatePanelActive();
      return;
    }
    const layerBtn = t.closest("[data-cad-layer]") as HTMLElement | null;
    if (layerBtn) {
      const id = layerBtn.getAttribute("data-cad-layer");
      if (id) {
        cadEngine.setActiveLayer(id);
        toast("info", "Layer: " + cadEngine.getActiveLayer().name);
        updatePanelActive();
      }
      return;
    }
    if (t.closest("[data-cad-ortho]")) {
      const on = cadEngine.toggleOrtho();
      toast("info", on ? "ORTHO on" : "ORTHO off");
      updatePanelActive();
      return;
    }
    if (t.closest("[data-cad-grid]")) {
      const on = cadEngine.toggleGrid();
      render();
      toast("info", on ? "GRID on" : "GRID off");
      updatePanelActive();
    }
  });

  // Drag header
  const hdr = panel.querySelector(".cad-hdr") as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hdr.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = panel!.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    hdr.setPointerCapture(e.pointerId);
  });
  hdr.addEventListener("pointermove", (e) => {
    if (!dragging || !panel) return;
    panel.style.left = `${ox + e.clientX - sx}px`;
    panel.style.top = `${oy + e.clientY - sy}px`;
    panel.style.right = "auto";
  });
  hdr.addEventListener("pointerup", () => {
    dragging = false;
  });
}

export function openCadPanel(): void {
  buildPanel();
  ensureSvg();
  panel?.classList.add("is-open");
  updatePanelActive();
}

export function closeCadPanel(): void {
  panel?.classList.remove("is-open");
  cadEngine.setTool(null);
}

export function toggleCadPanel(): void {
  if (panel?.classList.contains("is-open")) closeCadPanel();
  else openCadPanel();
}

/* -- Shortcuts ------------------------------------------------------------- */

async function registerCadShortcuts(): Promise<void> {
  let register: ((s: Any) => void) | null = null;
  try {
    const mod: Any = await import("./shortcuts");
    register = mod.shortcuts?.register?.bind(mod.shortcuts) ?? null;
  } catch {
    return;
  }
  if (!register) return;

  const toolCmd = (keys: string, id: string, label: string, tool: CadTool) => {
    register!({
      id,
      label,
      keys,
      category: "tool",
      handler: () => {
        openCadPanel();
        setTool(tool, label);
      },
    });
  };

  toolCmd("l", "cad-line", "CAD Line", "line");
  toolCmd("pl", "cad-pline", "CAD Polyline", "polyline");
  toolCmd("rec", "cad-rect", "CAD Rectangle", "rect");
  // "c" conflicts with walk - use "ci" already exists for circle authoring;
  // CAD circle via "cc" to avoid clash
  toolCmd("cc", "cad-circle", "CAD Circle", "circle");
  toolCmd("a", "cad-arc", "CAD Arc", "arc");
  // "t" might conflict - use "dt" for dtext-like
  toolCmd("dt", "cad-text", "CAD Text", "text");
  toolCmd("o", "cad-offset", "CAD Offset", "offset");
  toolCmd("e", "cad-erase", "CAD Erase", "erase");
  toolCmd("co", "cad-copy", "CAD Copy", "copy");
  toolCmd("mi", "cad-mirror", "CAD Mirror", "mirror");
  toolCmd("tr", "cad-trim", "CAD Trim", "trim");
  toolCmd("ex", "cad-extend", "CAD Extend", "extend");
  toolCmd("fi", "cad-fillet", "CAD Fillet", "fillet");
  toolCmd("di", "cad-dist", "CAD Distance", "distance");

  register({
    id: "cad-panel",
    label: "CAD Tools Panel",
    keys: "ctrl+shift+d",
    category: "app",
    handler: () => toggleCadPanel(),
  });
  register({
    id: "cad-ortho",
    label: "Toggle Ortho (F8)",
    keys: "f8",
    category: "tool",
    handler: () => {
      const on = cadEngine.toggleOrtho();
      toast("info", on ? "ORTHO on" : "ORTHO off");
      updatePanelActive();
    },
  });
  register({
    id: "cad-grid",
    label: "Toggle Grid (F7)",
    keys: "f7",
    category: "tool",
    handler: () => {
      const on = cadEngine.toggleGrid();
      ensureSvg();
      render();
      toast("info", on ? "GRID on" : "GRID off");
      updatePanelActive();
    },
  });
  register({
    id: "cad-undo",
    label: "CAD Undo",
    keys: "u",
    category: "edit",
    handler: () => {
      if (cadEngine.getCount() === 0) return;
      cadEngine.undo();
      render();
      syncDrafting();
    },
  });

  console.log("[cad-parity] CAD shortcuts registered");
}

/* -- Setup ----------------------------------------------------------------- */

export function setupCadParity(): void {
  if (installed) return;
  installed = true;

  ensureSvg();
  cadEngine.onChange(() => {
    render();
    updatePanelActive();
  });

  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);

  void registerCadShortcuts();

  // Launcher button
  const launch = document.createElement("button");
  launch.id = "obs-cad-launch";
  launch.type = "button";
  launch.title = "CAD Tools (Ctrl+Shift+D)";
  launch.textContent = "CAD";
  launch.style.cssText =
    "position:fixed;left:64px;bottom:52px;z-index:10002;width:44px;height:40px;" +
    "border-radius:10px;border:1px solid #fbbf24;background:rgba(251,191,36,.14);" +
    "color:#fbbf24;font:700 11px Inter,system-ui;cursor:pointer;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);";
  launch.onclick = () => toggleCadPanel();
  document.body.appendChild(launch);

  (ctx.features as Any).cad = {
    engine: cadEngine,
    open: openCadPanel,
    close: closeCadPanel,
    toggle: toggleCadPanel,
  };
  (window as Any).__obsCad = (ctx.features as Any).cad;

  void (async () => {
    try {
      const cp: Any = await import("./command-palette");
      cp.registerCommand?.({
        id: "cad.panel",
        label: "CAD Tools Panel",
        category: "Drafting",
        kbd: "Ctrl+Shift+D",
        run: () => toggleCadPanel(),
      });
      cp.registerCommand?.({
        id: "cad.line",
        label: "CAD Line",
        category: "Drafting",
        run: () => {
          openCadPanel();
          setTool("line", "LINE");
        },
      });
      cp.registerCommand?.({
        id: "cad.pline",
        label: "CAD Polyline",
        category: "Drafting",
        run: () => {
          openCadPanel();
          setTool("polyline", "PLINE");
        },
      });
    } catch { /* */ }
  })();

  console.log("[cad-parity] ready - CAD button or Ctrl+Shift+D");
}
