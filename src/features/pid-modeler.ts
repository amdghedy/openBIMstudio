/**
 * P&ID Modeler — 2D Process & Instrumentation Diagram sketch pad.
 *
 * A lightweight SVG canvas where the user can place P&ID symbols
 * (pumps, valves, tanks, instruments) and connect them with process
 * lines. Data is stored per project via localStorage.
 */

import { ctx } from "../core/context";

const SVG_NS = "http://www.w3.org/2000/svg";
const STORE_KEY = "obs.pid.diagram.v1";

type SymbolKind = "pump" | "valve" | "tank" | "instrument" | "line";

interface PidSymbol {
  id: string;
  kind: SymbolKind;
  x: number;
  y: number;
  label: string;
}

interface PidDiagram {
  symbols: PidSymbol[];
  lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
}

let panel: HTMLDivElement | null = null;
let canvasHost: HTMLDivElement | null = null;
let currentTool: SymbolKind = "pump";
let visible = false;
let diagram: PidDiagram = { symbols: [], lines: [] };
let selectedId: string | null = null;
let pendingLineStart: { x: number; y: number } | null = null;

function loadDiagram(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) diagram = JSON.parse(raw);
  } catch { /* */ }
}
function saveDiagram(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(diagram)); } catch { /* */ }
}

export function setupPidModeler(): void {
  loadDiagram();

  panel = document.createElement("div");
  panel.id = "obs-pid-modeler";
  panel.style.cssText =
    "position:fixed;left:400px;top:120px;right:20px;bottom:60px;z-index:33;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);font:12px system-ui,sans-serif;overflow:hidden";
  panel.onmousedown = (e) => e.stopPropagation();

  // Header + toolbar
  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:8px 12px;flex-wrap:wrap;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0";
  header.innerHTML = "<div style='font-weight:700'>\u2699 P&ID Modeler</div>";

  const toolDefs: Array<{ kind: SymbolKind; label: string; color: string }> = [
    { kind: "pump",       label: "Pump",      color: "#38bdf8" },
    { kind: "valve",      label: "Valve",     color: "#22c55e" },
    { kind: "tank",       label: "Tank",      color: "#a855f7" },
    { kind: "instrument", label: "Instrument", color: "#f59e0b" },
    { kind: "line",       label: "Process Line", color: "#94a3b8" },
  ];

  const toolButtons = new Map<SymbolKind, HTMLButtonElement>();
  function refreshTools(): void {
    for (const [k, b] of toolButtons) {
      const active = k === currentTool;
      b.style.background = active ? "#38bdf8" : "transparent";
      b.style.color = active ? "#0b0d12" : "#cbd5e1";
      b.style.borderColor = active ? "#38bdf8" : "#2a2e3a";
    }
  }

  for (const t of toolDefs) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.style.cssText =
      "padding:4px 10px;background:transparent;color:#cbd5e1;border:1px solid #2a2e3a;" +
      "border-radius:4px;cursor:pointer;font:11px system-ui";
    b.onclick = () => { currentTool = t.kind; pendingLineStart = null; refreshTools(); };
    toolButtons.set(t.kind, b);
    header.appendChild(b);
  }
  refreshTools();

  const spacer = document.createElement("div");
  spacer.style.cssText = "flex:1";
  header.appendChild(spacer);

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.style.cssText =
    "padding:4px 10px;background:transparent;color:#fca5a5;border:1px solid #ef4444;" +
    "border-radius:4px;cursor:pointer;font:11px system-ui";
  clearBtn.onclick = () => {
    if (!confirm("Clear the P&ID diagram?")) return;
    diagram = { symbols: [], lines: [] };
    saveDiagram();
    render();
  };
  header.appendChild(clearBtn);

  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export SVG";
  exportBtn.style.cssText =
    "padding:4px 10px;background:transparent;color:#cbd5e1;border:1px solid #2a2e3a;" +
    "border-radius:4px;cursor:pointer;font:11px system-ui";
  exportBtn.onclick = exportSvg;
  header.appendChild(exportBtn);

  canvasHost = document.createElement("div");
  canvasHost.style.cssText = "flex:1;overflow:auto;background:#f7f7f5;position:relative";

  panel.append(header, canvasHost);
  ctx.rightHost.appendChild(panel);

  (ctx.features as any).pidModeler = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; render(); },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).pidModeler.hide() : (ctx.features as any).pidModeler.show(); },
    isVisible: () => visible,
  };
}

function render(): void {
  if (!canvasHost) return;
  canvasHost.innerHTML = "";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", "0 0 1000 700");
  svg.style.cssText = "display:block;background:#f7f7f5;cursor:crosshair";

  // Grid
  for (let x = 0; x <= 1000; x += 20) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("y1", "0");
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", "700");
    line.setAttribute("stroke", x % 100 === 0 ? "#d1d5db" : "#eceff3");
    line.setAttribute("stroke-width", x % 100 === 0 ? "1" : "0.5");
    svg.appendChild(line);
  }
  for (let y = 0; y <= 700; y += 20) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", "1000");
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", y % 100 === 0 ? "#d1d5db" : "#eceff3");
    line.setAttribute("stroke-width", y % 100 === 0 ? "1" : "0.5");
    svg.appendChild(line);
  }

  // Lines
  for (const line of diagram.lines) {
    const el = document.createElementNS(SVG_NS, "line");
    el.setAttribute("x1", String(line.x1));
    el.setAttribute("y1", String(line.y1));
    el.setAttribute("x2", String(line.x2));
    el.setAttribute("y2", String(line.y2));
    el.setAttribute("stroke", "#111827");
    el.setAttribute("stroke-width", "2");
    svg.appendChild(el);
  }

  // Symbols
  for (const sym of diagram.symbols) {
    const g = drawSymbol(sym);
    g.setAttribute("data-symbol-id", sym.id);
    g.style.cursor = "move";
    const isSelected = sym.id === selectedId;
    if (isSelected) {
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", String(sym.x));
      ring.setAttribute("cy", String(sym.y));
      ring.setAttribute("r", "26");
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", "#38bdf8");
      ring.setAttribute("stroke-width", "2");
      ring.setAttribute("stroke-dasharray", "4 2");
      g.appendChild(ring);
    }
    g.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      selectedId = sym.id;
      render();
    });
    svg.appendChild(g);
  }

  // Click to place / start line
  svg.addEventListener("click", (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = Math.round(((ev.clientX - rect.left) / rect.width) * 1000 / 10) * 10;
    const y = Math.round(((ev.clientY - rect.top) / rect.height) * 700 / 10) * 10;
    placeAt(x, y);
  });

  canvasHost.appendChild(svg);
}

function placeAt(x: number, y: number): void {
  if (currentTool === "line") {
    if (!pendingLineStart) {
      pendingLineStart = { x, y };
    } else {
      diagram.lines.push({
        id: "l-" + Date.now().toString(36),
        x1: pendingLineStart.x,
        y1: pendingLineStart.y,
        x2: x,
        y2: y,
      });
      pendingLineStart = null;
      saveDiagram();
      render();
    }
    return;
  }

  const label = currentTool === "instrument"
    ? prompt("Instrument tag (e.g. FT-101):", "FT-101")
    : prompt("Symbol label:", currentTool.toUpperCase());
  if (label == null) return;

  diagram.symbols.push({
    id: "s-" + Date.now().toString(36),
    kind: currentTool,
    x, y,
    label: label || currentTool,
  });
  saveDiagram();
  render();
}

function drawSymbol(sym: PidSymbol): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  const cx = sym.x;
  const cy = sym.y;

  if (sym.kind === "pump") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "18");
    circle.setAttribute("fill", "white");
    circle.setAttribute("stroke", "#111827");
    circle.setAttribute("stroke-width", "2");
    g.appendChild(circle);
    const tri = document.createElementNS(SVG_NS, "polygon");
    tri.setAttribute("points", (cx - 8) + "," + (cy - 8) + " " + (cx + 8) + "," + cy + " " + (cx - 8) + "," + (cy + 8));
    tri.setAttribute("fill", "none");
    tri.setAttribute("stroke", "#111827");
    tri.setAttribute("stroke-width", "2");
    g.appendChild(tri);
  } else if (sym.kind === "valve") {
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", (cx - 14) + "," + (cy - 10) + " " + (cx + 14) + "," + (cy - 10) + " " + cx + "," + cy + " " + (cx + 14) + "," + (cy + 10) + " " + (cx - 14) + "," + (cy + 10) + " " + cx + "," + cy);
    poly.setAttribute("fill", "white");
    poly.setAttribute("stroke", "#111827");
    poly.setAttribute("stroke-width", "2");
    g.appendChild(poly);
  } else if (sym.kind === "tank") {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(cx - 24));
    rect.setAttribute("y", String(cy - 20));
    rect.setAttribute("width", "48");
    rect.setAttribute("height", "40");
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", "white");
    rect.setAttribute("stroke", "#111827");
    rect.setAttribute("stroke-width", "2");
    g.appendChild(rect);
  } else if (sym.kind === "instrument") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "18");
    circle.setAttribute("fill", "white");
    circle.setAttribute("stroke", "#111827");
    circle.setAttribute("stroke-width", "2");
    g.appendChild(circle);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(cx - 18));
    line.setAttribute("y1", String(cy));
    line.setAttribute("x2", String(cx + 18));
    line.setAttribute("y2", String(cy));
    line.setAttribute("stroke", "#111827");
    line.setAttribute("stroke-width", "2");
    g.appendChild(line);
  }

  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", String(cx));
  label.setAttribute("y", String(cy + 34));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-family", "ui-monospace, monospace");
  label.setAttribute("font-size", "11");
  label.setAttribute("fill", "#374151");
  label.setAttribute("font-weight", "600");
  label.textContent = sym.label;
  g.appendChild(label);

  return g;
}

function exportSvg(): void {
  if (!canvasHost) return;
  const svg = canvasHost.querySelector("svg");
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob(["<?xml version=\"1.0\"?>\n" + xml], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pid-diagram.svg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}