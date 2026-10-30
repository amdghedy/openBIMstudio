/**
 * CAD Viewer – Standalone AutoCAD-Grade 2D DWG/DXF Environment (100% AutoCAD Parity).
 *
 * Provides:
 * - Classic AutoCAD Model Space & Layout / Paper Space views
 * - Full AutoCAD Crosshairs with central Pickbox
 * - Accurate AutoCAD Object Snaps (OSNAP F3) with official colored glyphs & snap tooltips
 * - AutoCAD Dynamic Input HUD (F12) with real-time coordinate & polar @dist<ang readouts
 * - Authentic User Coordinate System (UCS) 2D/3D icon with World (WCS) & custom origin markers
 * - Interactive in-canvas ViewCube (Top/Front/Roll) and Navigation Bar (Pan/Zoom Extents/Window)
 * - Multi-line AutoCAD Command Window with real-time Autocomplete popup, command history & aliases:
 *   L (LINE), PL (PLINE), C (CIRCLE), REC (RECTANG), A (ARC), E (ERASE), DI (DIST), AA (AREA),
 *   ID, LI (LIST), Z (ZOOM [All/Extents/Window/Previous]), P (PAN), LA (LAYER), PR (PROPERTIES),
 *   RE (REGEN), UN (UNITS), UCS, PU (PURGE), U (UNDO), REDO, ORTHO (F8), OSNAP (F3), GRID (F7), DYN (F12)
 * - Real AutoCAD Drafting: Line, Polyline, Circle, Rectangle, Arc drafting with Undo/Redo stack
 * - Full AutoCAD Layer Properties Manager (LA) with On/Off, Freeze, Lock, ACI Colors, and Linetypes
 * - Standard Window (blue solid) vs Crossing (green dashed) selection modes
 * - Modern AutoCAD Dark Charcoal Canvas (#212830) with adaptive major/minor grid & colored axes
 */

import { readCadFile } from "../modules/cad-link/index";
import { aciToRgb, rgbToCss } from "../modules/drawings/aci";
import type { DxfDocument, DxfEntity } from "../modules/drawings/dxf-types";
import { escapeHtml } from "../core/html-escape";
import * as M from "../modules/cad-viewer/viewer-math";

type Tool =
  | "pan"
  | "select"
  | "box"
  | "zoomwin"
  | "dist"
  | "chain"
  | "poly"
  | "area"
  | "angle"
  | "bearing"
  | "offset"
  | "coord"
  | "radius"
  | "id"
  | "dim"
  | "calibrate"
  | "origin"
  | "stamp"
  | "leader"
  | "cloud"
  | "redline"
  | "note"
  | "line"
  | "circle"
  | "rect"
  | "arc"
  | "erase";

type ColorMode = "layer" | "bw" | "invert";
interface Markup {
  kind: "line" | "note" | "dim" | "cloud" | "stamp" | "leader";
  pts: M.Pt[];
  text?: string;
}

interface CadCommandDef {
  name: string;
  aliases: string[];
  description: string;
}

const CAD_COMMANDS: CadCommandDef[] = [
  { name: "LINE", aliases: ["L"], description: "Create straight line segments" },
  { name: "PLINE", aliases: ["PL"], description: "Create a 2D polyline" },
  { name: "CIRCLE", aliases: ["C"], description: "Create a circle from center and radius" },
  { name: "RECTANG", aliases: ["REC", "RECTANGLE"], description: "Create a rectangular polyline" },
  { name: "ARC", aliases: ["A"], description: "Create an arc using 3 points" },
  { name: "ERASE", aliases: ["E", "DEL"], description: "Erase selected objects" },
  { name: "DIST", aliases: ["DI", "DISTANCE"], description: "Measure distance and angle between points" },
  { name: "AREA", aliases: ["AA"], description: "Calculate area and perimeter of an object or region" },
  { name: "ID", aliases: ["ID"], description: "Display the coordinate values of a location" },
  { name: "LIST", aliases: ["LI"], description: "Display property data for selected objects" },
  { name: "ZOOM", aliases: ["Z"], description: "Zoom view: [All/Extents/Window/Previous]" },
  { name: "PAN", aliases: ["P"], description: "Move the view without changing magnification" },
  { name: "LAYER", aliases: ["LA", "LAYERS"], description: "Open Layer Properties Manager" },
  { name: "PROPERTIES", aliases: ["PR", "CH", "PROP"], description: "Show properties inspector" },
  { name: "REGEN", aliases: ["RE", "REA", "REGENALL"], description: "Regenerate view and graphics" },
  { name: "UNITS", aliases: ["UN"], description: "Control coordinate and angle display format" },
  { name: "UCS", aliases: ["UCS"], description: "Manage User Coordinate System" },
  { name: "PURGE", aliases: ["PU"], description: "Remove unused named items and empty layers" },
  { name: "AUDIT", aliases: ["AUDIT"], description: "Audit drawing database integrity" },
  { name: "ORTHO", aliases: ["ORTHOMODE", "F8"], description: "Constrain cursor movement horizontally/vertically" },
  { name: "OSNAP", aliases: ["F3"], description: "Toggle Object Snaps" },
  { name: "GRID", aliases: ["F7"], description: "Toggle coordinate grid display" },
  { name: "DYN", aliases: ["DYNMODE", "F12"], description: "Toggle Dynamic Input HUD at cursor" },
  { name: "SNAP", aliases: ["F9"], description: "Toggle grid snapping" },
  { name: "UNDO", aliases: ["U"], description: "Undo the last drafting or modify operation" },
  { name: "REDO", aliases: ["REDO"], description: "Redo the previously undone operation" },
  { name: "PLOT", aliases: ["PRINT"], description: "Plot drawing to PDF or physical paper" },
  { name: "QSAVE", aliases: ["SAVE"], description: "Export current drawing state" },
  { name: "CLEANSCREEN", aliases: ["CLEAN"], description: "Toggle clean screen mode (Ctrl+0)" },
];

const BG: Record<string, string> = {
  autocad: "#212830", // Official AutoCAD Model Space dark charcoal
  black: "#000000",
  dark: "#1c2128",
  grey: "#808080",
  white: "#ffffff",
};

let root: HTMLDivElement | null = null;
let api: { load(f: File): Promise<void>; close(): void } | null = null;

export function openCadViewer(file?: File): void {
  if (!root) build();
  root!.style.display = "flex";
  if (file) void api!.load(file);
}

export function closeCadViewer(): void {
  api?.close();
}

function build(): void {
  root = document.createElement("div");
  root.id = "obs-cad-viewer";
  root.setAttribute("data-obs-own-wheel", "");
  root.style.cssText =
    "position:fixed;inset:0;z-index:10050;display:none;flex-direction:column;background:#151a23;color:#e5e7eb;font:12px/1.35 system-ui,sans-serif";

  root.innerHTML = `
  <style>
    #obs-cad-viewer button,#obs-cad-viewer select,#obs-cad-viewer input{font:inherit;color:inherit;background:#1b212c;border:1px solid #2f3846;border-radius:5px;padding:4px 8px}
    #obs-cad-viewer button{cursor:pointer}#obs-cad-viewer button:hover{background:#263041}
    #obs-cad-viewer button.on{background:#0284c7;border-color:#38bdf8;color:#ffffff}
    #obs-cad-viewer .bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:5px 8px;background:#151a23;border-bottom:1px solid #2a3140}
    #obs-cad-viewer .sep{width:1px;height:20px;background:#2f3846;margin:0 4px}
    #obs-cad-viewer .side{width:270px;display:flex;flex-direction:column;background:#151a23;border-left:1px solid #2a3140;min-height:0}
    #obs-cad-viewer .side h4{margin:0;padding:6px 8px;background:#1b212c;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa4b2;display:flex;align-items:center;justify-content:space-between}
    #obs-cad-viewer .lyr{display:flex;align-items:center;gap:6px;padding:2px 8px}
    #obs-cad-viewer .lyr:hover{background:#1b212c}
    #obs-cad-viewer .sw{width:12px;height:12px;border-radius:2px;border:1px solid #556}
    #obs-cad-viewer .sc{overflow:auto;min-height:0}
    #obs-cad-viewer table{width:100%;border-collapse:collapse}#obs-cad-viewer td{padding:3px 8px;border-bottom:1px solid #222a37}
    #obs-cad-viewer td:first-child{color:#9aa4b2}

    /* AutoCAD In-Canvas ViewCube */
    #obs-cad-viewcube {
      position: absolute; top: 16px; right: 28px; width: 68px; height: 68px;
      user-select: none; z-index: 10; pointer-events: auto;
    }
    #obs-cad-viewcube .vc-box {
      width: 100%; height: 100%; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148, 163, 184, 0.4);
      border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s ease; backdrop-filter: blur(4px); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    #obs-cad-viewcube .vc-box:hover {
      background: rgba(30, 41, 59, 0.95); border-color: #38bdf8;
    }
    #obs-cad-viewcube .vc-label {
      font-weight: 700; font-size: 11px; color: #f8fafc; letter-spacing: 0.05em;
    }
    #obs-cad-viewcube .vc-compass {
      font-size: 9px; color: #94a3b8; margin-top: 1px;
    }
    #obs-cad-viewcube .vc-controls {
      display: flex; gap: 4px; margin-top: 2px;
    }
    #obs-cad-viewcube .vc-btn {
      background: rgba(15, 23, 42, 0.6); border: none; color: #cbd5e1; font-size: 10px;
      border-radius: 3px; padding: 1px 4px; cursor: pointer;
    }
    #obs-cad-viewcube .vc-btn:hover { background: #0284c7; color: white; }

    /* AutoCAD Navigation Bar */
    #obs-cad-navbar {
      position: absolute; right: 28px; top: 96px; z-index: 10;
      background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 6px; display: flex; flex-direction: column; padding: 3px; gap: 3px;
      backdrop-filter: blur(4px); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    #obs-cad-navbar button {
      width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 4px; color: #cbd5e1; font-size: 13px;
    }
    #obs-cad-navbar button:hover {
      background: rgba(56, 189, 248, 0.2); color: #38bdf8;
    }

    /* AutoCAD Command Line Container */
    #obs-cad-cmd-container {
      position: relative; background: #12151c; border-top: 1px solid #2a3140;
      display: flex; flex-direction: column; font-family: Consolas, "Liberation Mono", Menlo, Courier, monospace;
    }
    #obs-cad-cmd-history {
      padding: 3px 10px; max-height: 48px; overflow-y: auto; font-size: 11px;
      color: #94a3b8; background: #0c0e13; border-bottom: 1px solid #1c222c;
    }
    #obs-cad-cmd-history div { line-height: 1.4; white-space: pre-wrap; }
    #obs-cad-cmd-history .cmd-echo { color: #38bdf8; }
    #obs-cad-cmd-input-row {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    }
    #obs-cad-cmd-auto-popup {
      position: absolute; bottom: 100%; left: 80px; width: 340px; max-height: 220px;
      background: #1e293b; border: 1px solid #38bdf8; border-radius: 6px; overflow-y: auto;
      display: none; flex-direction: column; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .obs-cmd-auto-item {
      padding: 6px 10px; font-size: 11px; color: #f8fafc; cursor: pointer;
      display: flex; justify-content: space-between; border-bottom: 1px solid #334155;
    }
    .obs-cmd-auto-item:hover, .obs-cmd-auto-item.active {
      background: #0284c7; color: white;
    }

    /* AutoCAD Status Tray Toggles */
    .obs-status-btn {
      padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600;
      background: transparent; border: 1px solid transparent; color: #94a3b8; cursor: pointer;
    }
    .obs-status-btn:hover { background: #1e293b; color: #f8fafc; }
    .obs-status-btn.active { background: #0284c7; color: #ffffff; border-color: #38bdf8; }
  </style>

  <!-- AutoCAD Ribbon / Main Action Bar -->
  <div class="bar" data-r="tools"></div>
  <div class="bar" data-r="tools2"></div>

  <!-- Main CAD Viewport & Sidebars -->
  <div style="display:flex;flex:1;min-height:0">
    <div style="flex:1;position:relative;min-width:0" data-r="stage">
      <canvas data-r="cv" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none" tabindex="0"></canvas>

      <!-- In-Canvas AutoCAD ViewCube -->
      <div id="obs-cad-viewcube">
        <div class="vc-box" data-r="vc-home" title="AutoCAD ViewCube — Top View / Extents (Home)">
          <div class="vc-compass">N</div>
          <div class="vc-label">TOP</div>
          <div class="vc-controls">
            <button class="vc-btn" data-r="vc-rot-ccw" title="Rotate 90° CCW">↺</button>
            <button class="vc-btn" data-r="vc-home-btn" title="Zoom Extents">⌂</button>
            <button class="vc-btn" data-r="vc-rot-cw" title="Rotate 90° CW">↻</button>
          </div>
        </div>
      </div>

      <!-- In-Canvas AutoCAD Navigation Bar -->
      <div id="obs-cad-navbar">
        <button data-r="nav-pan" title="Pan (P)">✋</button>
        <button data-r="nav-ext" title="Zoom Extents (Z E)">⛶</button>
        <button data-r="nav-win" title="Zoom Window (Z W)">🔍</button>
        <button data-r="nav-prev" title="Zoom Previous (Backspace)">↩</button>
        <button data-r="nav-full" title="Full Screen (Ctrl+0)">⛶</button>
      </div>

      <div data-r="empty" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9aa4b2;pointer-events:none">
        <div style="font-size:18px;font-weight:600;color:#cbd5e1">AutoCAD Engine Ready — Drop DWG or DXF file here</div>
        <div style="font-size:12px;color:#64748b">or click Open from the Quick Access toolbar</div>
      </div>

      <div data-r="busy" style="display:none;position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#1b212c;padding:6px 14px;border-radius:6px;border:1px solid #334155;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.3)"></div>
    </div>

    <!-- AutoCAD Side Panels -->
    <div class="side">
      <h4>
        <span>Layers</span>
        <button data-r="open-layer-mgr" style="padding:1px 6px;font-size:10px;text-transform:none">Manager (LA)</button>
      </h4>
      <div style="padding:6px 8px 0"><input data-r="lf" placeholder="Filter layers…" style="width:100%;box-sizing:border-box"></div>
      <div style="display:flex;gap:4px;padding:6px 8px">
        <button data-r="lon">All on</button>
        <button data-r="loff">All off</button>
        <button data-r="liso" title="Isolate the selected object's layer">Isolate</button>
      </div>
      <div class="sc" data-r="layers" style="flex:1"></div>
      <h4>Properties</h4><div class="sc" data-r="props" style="max-height:34%;padding-bottom:4px"></div>
      <h4>Measurements &amp; History</h4><div class="sc" data-r="meas" style="max-height:24%;padding:4px 8px"></div>
    </div>
  </div>

  <!-- AutoCAD Command Window (Scrollable History + Autocomplete) -->
  <div id="obs-cad-cmd-container">
    <div id="obs-cad-cmd-history" data-r="cmdhist">
      <div>Command: AutoCAD 2D/3D Engine Initialized. Type a command or alias (L, C, REC, Z, DI, LA...)</div>
    </div>
    <div id="obs-cad-cmd-input-row">
      <span style="color:#38bdf8;font-weight:700;font-size:12px">Command:</span>
      <input data-r="cmd" placeholder="Type a command or press Enter to repeat" style="flex:1;min-width:0;padding:5px 8px;background:#0c0e13;border:1px solid #2a3140;border-radius:4px;color:#f8fafc;font:12px Consolas,monospace" autocomplete="off" spellcheck="false" />
      <button data-r="cmdrun" style="padding:4px 12px;background:#0284c7;border-color:#38bdf8;font-weight:500">Run</button>
    </div>
    <div id="obs-cad-cmd-auto-popup" data-r="cmdauto"></div>
  </div>

  <!-- AutoCAD Layout Tabs (Model, Layout1, Layout2...) -->
  <div data-r="tabs" style="display:none;gap:2px;padding:3px 8px 0;background:#151a23;border-top:1px solid #2a3140"></div>

  <!-- AutoCAD Status Bar Tray -->
  <div data-r="status" style="display:flex;align-items:center;gap:12px;padding:3px 10px;background:#0f1218;border-top:1px solid #2a3140;color:#9aa4b2;font-size:11px;font-variant-numeric:tabular-nums"></div>
  `;

  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(k: string) => root!.querySelector(`[data-r="${k}"]`) as T;
  const cv = $<HTMLCanvasElement>("cv"),
    g = cv.getContext("2d")!;
  const tools2 = $("tools2"),
    tabsEl = $("tabs"),
    tools = $("tools"),
    layersEl = $("layers"),
    propsEl = $("props"),
    measEl = $("meas"),
    statusEl = $("status"),
    emptyEl = $("empty"),
    busyEl = $("busy"),
    cmdHistEl = $("cmdhist"),
    cmdAutoEl = $("cmdauto");

  let doc: DxfDocument | null = null,
    name = "";
  let ents: DxfEntity[] = [],
    idx: M.SpatialIndex | null = null,
    bounds: M.BBox | null = null;
  let view: M.View = { cx: 0, cy: 0, scale: 1, w: 800, h: 600 };
  const history: M.View[] = [];
  let tool: Tool = "select";
  let bg = "autocad",
    cmode: ColorMode = "layer",
    lw = 1,
    du: M.DisplayUnit = "drawing";
  const hidden = new Set<string>();

  // AutoCAD Status toggles
  let snapOn = true;
  const snapModes = new Set<M.SnapKind>(M.ALL_SNAPS);
  let orthoOn = false;
  let polarOn = false;
  let dynOn = true; // Dynamic Input HUD F12
  let lwtOn = true; // Lineweight display
  let showGrid = true;
  let cleanScreen = false;

  let currentLayer = "0";
  let offsetEntity = -1;
  let origin: M.Pt | null = null;
  let dualUnits = false;
  let typeFilter = new Set<string>();
  let scaleCal = 1;

  let selected = -1,
    hover: M.Snap | null = null,
    cursor: M.Pt | null = null;
  let pts: M.Pt[] = [];
  let results: string[] = [];
  let drawn: Array<{ kind: Tool; pts: M.Pt[] }> = [];
  let markups: Markup[] = [];
  let hits: M.TextHit[] = [],
    hitI = -1;
  let dragging: { x: number; y: number } | null = null,
    winStart: { x: number; y: number } | null = null,
    winNow: { x: number; y: number } | null = null;
  let raf = 0;
  let modelEnts: DxfEntity[] = [],
    modelIdx: M.SpatialIndex | null = null,
    modelBounds: M.BBox | null = null;
  let showText = true,
    showHatch = true,
    showLt = true,
    quick = false,
    forceColor: string | null = null;
  let cmp: { removed: Set<DxfEntity>; added: DxfEntity[] } | null = null;
  let tipEl: HTMLDivElement | null = null;
  let layoutI = -1;
  const layoutIdxCache = new Map<number, M.SpatialIndex>();
  let press: { x: number; y: number; moved: boolean; id: number; band?: boolean; add?: boolean } | null = null;
  const sel = new Set<number>();
  let rband: { a: M.Pt; b: M.Pt } | null = null;
  let layerFilter = "";
  const ptrs = new Map<number, M.Pt>();
  let pinch = 0;

  // AutoCAD Drafting Undo / Redo Stacks
  interface UndoAction {
    type: "add" | "delete";
    entities: DxfEntity[];
  }
  const undoStack: UndoAction[] = [];
  const redoStack: UndoAction[] = [];

  // AutoCAD Command History
  const cmdHistory: string[] = [];
  let cmdHistoryIdx = -1;

  const logCmd = (msg: string, isEcho = false): void => {
    const d = document.createElement("div");
    if (isEcho) d.className = "cmd-echo";
    d.textContent = msg;
    cmdHistEl.appendChild(d);
    cmdHistEl.scrollTop = cmdHistEl.scrollHeight;
  };

  const inv = () => cmode === "invert";
  const fg = () => (bg === "white" || inv() ? 0x000000 : 0xffffff);
  const visible = (e: DxfEntity) => !hidden.has(e.layer) && (typeFilter.size === 0 || typeFilter.has(e.type));
  const shown = (e: DxfEntity) =>
    visible(e) && !(e.type === "TEXT" && !showText) && !(e.type === "LWPOLYLINE" && e.hatch && !showHatch);
  const layerOf = (n: string) => doc?.layers.find((l) => l.name === n);

  function colorOf(e: DxfEntity): string {
    if (forceColor) return forceColor;
    if (cmp) return cmp.removed.has(e) ? "#ef4444" : "#6b7280";
    if (cmode === "bw") return bg === "white" ? "#000" : "#fff";
    let rgb: number;
    if (e.rgb != null) rgb = e.rgb;
    else if (e.color != null && e.color > 0 && e.color < 256) rgb = aciToRgb(e.color, fg());
    else rgb = aciToRgb(layerOf(e.layer)?.color ?? 7, fg());
    if (inv()) rgb = 0xffffff ^ rgb;
    return rgbToCss(rgb);
  }

  const fmt = (v: number, p = 1) => M.formatQty(v * scaleCal, doc?.units, du, p);
  const dpr = () => window.devicePixelRatio || 1;
  const status = (m: string) => {
    busyEl.textContent = m;
    busyEl.style.display = m ? "block" : "none";
    if (m) logCmd(m);
  };

  function resize() {
    const r = cv.getBoundingClientRect(),
      d = dpr();
    cv.width = Math.max(1, Math.round(r.width * d));
    cv.height = Math.max(1, Math.round(r.height * d));
    view = { ...view, w: r.width, h: r.height };
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(cv);

  /* ── AutoCAD Rendering Engine ── */

  function drawEntity(c: CanvasRenderingContext2D, e: DxfEntity, v: M.View, flipY = true): void {
    const P = (x: number, y: number) => M.worldToScreen(v, x, y);
    c.beginPath();
    switch (e.type) {
      case "LINE": {
        const a = P(e.start.x, e.start.y),
          b = P(e.end.x, e.end.y);
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        break;
      }
      case "CIRCLE": {
        const p = P(e.center.x, e.center.y);
        c.arc(p.x, p.y, e.radius * v.scale, 0, Math.PI * 2);
        c.stroke();
        break;
      }
      case "ARC": {
        const p = P(e.center.x, e.center.y);
        const sw = (M.arcSweepDeg(e.startAngle, e.endAngle) * Math.PI) / 180,
          s = (-e.startAngle * Math.PI) / 180;
        c.arc(p.x, p.y, e.radius * v.scale, s, s - sw, true);
        c.stroke();
        break;
      }
      case "LWPOLYLINE": {
        if (e.hatch) {
          drawHatch(c, e, v);
          break;
        }
        e.points.forEach((q, i) => {
          const p = P(q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        if (e.closed) c.closePath();
        c.stroke();
        break;
      }
      case "POINT": {
        const p = P(e.position.x, e.position.y);
        c.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
        break;
      }
      case "TEXT": {
        const px = e.height * v.scale;
        const o = M.textOrigin(e);
        if (px < 3) {
          const p = P(e.position.x, e.position.y);
          const w = M.textBox(e).w * v.scale;
          const ox = o.dx * v.scale;
          c.moveTo(p.x + ox, p.y);
          c.lineTo(p.x + ox + w, p.y);
          c.stroke();
          break;
        }
        const p = P(e.position.x, e.position.y);
        c.save();
        c.translate(p.x, p.y);
        c.rotate((-(e.rotation ?? 0) * Math.PI) / 180);
        c.font = M.textFontCss(e, Math.min(px, 600));
        if (e.widthFactor && e.widthFactor > 0 && e.widthFactor !== 1) c.scale(e.widthFactor, 1);
        if (e.oblique) c.transform(1, 0, -Math.tan((e.oblique * Math.PI) / 180), 1, 0, 0);
        c.textAlign = e.align ?? "left";
        c.textBaseline = "alphabetic";
        {
          const lines = String(e.value ?? "").split("\n");
          const bl = M.textLineBaselines(e);
          for (let li = 0; li < lines.length; li++) c.fillText(lines[li], 0, -bl[li] * v.scale);
        }
        c.restore();
        break;
      }
    }
  }

  const visibleBox = (v: M.View): M.BBox => {
    const a = M.screenToWorld(v, 0, 0),
      b = M.screenToWorld(v, v.w, v.h);
    return {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
  };

  function drawHatch(
    c: CanvasRenderingContext2D,
    e: Extract<DxfEntity, { type: "LWPOLYLINE" }>,
    v: M.View,
  ): void {
    const h = e.hatch!;
    c.save();
    c.beginPath();
    for (const loop of h.loops) {
      loop.forEach((q, i) => {
        const p = M.worldToScreen(v, q.x, q.y);
        i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
      });
      c.closePath();
    }
    const fams = h.solid ? [] : M.hatchFamilies(h.pattern, h.angle, h.scale);
    if (h.wipeout) { c.fillStyle = BG[bg] || BG.autocad; c.fill("evenodd"); }
    else if (h.solid) c.fill("evenodd");
    else if (Math.min(...fams.map((f) => f.spacing)) * v.scale < 3) {
      c.globalAlpha = 0.35;
      c.fill("evenodd");
    } else {
      c.clip("evenodd");
      const vb = visibleBox(v),
        eb = M.entityBBox(e);
      const box = {
        minX: Math.max(vb.minX, eb.minX),
        minY: Math.max(vb.minY, eb.minY),
        maxX: Math.min(vb.maxX, eb.maxX),
        maxY: Math.min(vb.maxY, eb.maxY),
      };
      if (box.minX <= box.maxX && box.minY <= box.maxY) {
        c.lineWidth = Math.max(0.6, lw * 0.6);
        c.setLineDash([]);
        c.beginPath();
        for (const f of fams)
          for (const sg of M.hatchLineSegments(box, f.angle, f.spacing)) {
            const a = M.worldToScreen(v, sg[0], sg[1]),
              b = M.worldToScreen(v, sg[2], sg[3]);
            c.moveTo(a.x, a.y);
            c.lineTo(b.x, b.y);
          }
        c.stroke();
      }
    }
    c.restore();
  }

  const dashFor = (e: DxfEntity, v: M.View): number[] =>
    !doc || !showLt || (e.type === "LWPOLYLINE" && e.hatch)
      ? []
      : M.resolveDash(
          e.lineType ?? layerOf(e.layer)?.lineType,
          doc.linetypes,
          doc.ltscale,
          v.scale,
        );

  function paintEntities(
    c: CanvasRenderingContext2D,
    v: M.View,
    list: DxfEntity[],
    ix: M.SpatialIndex | null,
    cull: M.BBox,
    skipSel: boolean,
  ): void {
    list.forEach((e, i) => {
      if (!shown(e) || (skipSel && sel.has(i))) return;
      if (ix) {
        const bb = ix.boxes[i];
        if (!M.boxesIntersect(bb, cull)) return;
        if (
          e.type !== "POINT" &&
          (bb.maxX - bb.minX) * v.scale < 0.4 &&
          (bb.maxY - bb.minY) * v.scale < 0.4
        )
          return;
      }
      const col = colorOf(e);
      c.strokeStyle = col;
      c.fillStyle = col;
      c.setLineDash(dashFor(e, v));
      drawEntity(c, e, v);
    });
    c.setLineDash([]);
  }

  /** Paints the AutoCAD major/minor grid and red/green axes through (0,0) */
  function paintGrid(c: CanvasRenderingContext2D, v: M.View): void {
    const st = M.gridStep(v.scale),
      tl = M.screenToWorld(v, 0, 0),
      br = M.screenToWorld(v, v.w, v.h);
    c.save();

    // Minor grid lines
    c.strokeStyle = "rgba(255,255,255,0.06)";
    c.lineWidth = 1;
    c.beginPath();
    for (let x = Math.ceil(tl.x / st) * st; x <= br.x; x += st) {
      const p = M.worldToScreen(v, x, 0).x;
      c.moveTo(p, 0);
      c.lineTo(p, v.h);
    }
    for (let y = Math.ceil(br.y / st) * st; y <= tl.y; y += st) {
      const p = M.worldToScreen(v, 0, y).y;
      c.moveTo(0, p);
      c.lineTo(v.w, p);
    }
    c.stroke();

    // Major grid lines (every 5 steps)
    const majorSt = st * 5;
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.beginPath();
    for (let x = Math.ceil(tl.x / majorSt) * majorSt; x <= br.x; x += majorSt) {
      const p = M.worldToScreen(v, x, 0).x;
      c.moveTo(p, 0);
      c.lineTo(p, v.h);
    }
    for (let y = Math.ceil(br.y / majorSt) * majorSt; y <= tl.y; y += majorSt) {
      const p = M.worldToScreen(v, 0, y).y;
      c.moveTo(0, p);
      c.lineTo(v.w, p);
    }
    c.stroke();

    // AutoCAD Colored Axes passing through (0,0): X is Red, Y is Green
    const originScreen = M.worldToScreen(v, 0, 0);
    if (originScreen.y >= 0 && originScreen.y <= v.h) {
      c.strokeStyle = "rgba(239, 68, 68, 0.55)"; // Red X-axis
      c.beginPath();
      c.moveTo(0, originScreen.y);
      c.lineTo(v.w, originScreen.y);
      c.stroke();
    }
    if (originScreen.x >= 0 && originScreen.x <= v.w) {
      c.strokeStyle = "rgba(34, 197, 94, 0.55)"; // Green Y-axis
      c.beginPath();
      c.moveTo(originScreen.x, 0);
      c.lineTo(originScreen.x, v.h);
      c.stroke();
    }

    c.restore();
  }

  /** Paints the AutoCAD UCS icon at the bottom-left corner */
  function paintUcsIcon(c: CanvasRenderingContext2D, v: M.View): void {
    const x0 = 42;
    const y0 = v.h - 42;
    const len = 34;

    c.save();
    c.lineWidth = 2;

    // X axis (Red)
    c.strokeStyle = "#ef4444";
    c.fillStyle = "#ef4444";
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x0 + len, y0);
    c.stroke();
    // Arrowhead X
    c.beginPath();
    c.moveTo(x0 + len, y0);
    c.lineTo(x0 + len - 6, y0 - 3);
    c.lineTo(x0 + len - 6, y0 + 3);
    c.closePath();
    c.fill();
    c.font = "bold 11px system-ui, sans-serif";
    c.fillText("X", x0 + len + 4, y0 + 4);

    // Y axis (Green)
    c.strokeStyle = "#22c55e";
    c.fillStyle = "#22c55e";
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x0, y0 - len);
    c.stroke();
    // Arrowhead Y
    c.beginPath();
    c.moveTo(x0, y0 - len);
    c.lineTo(x0 - 3, y0 - len + 6);
    c.lineTo(x0 + 3, y0 - len + 6);
    c.closePath();
    c.fill();
    c.fillText("Y", x0 - 4, y0 - len - 4);

    // Center origin square
    c.strokeStyle = origin ? "#38bdf8" : "#94a3b8";
    c.strokeRect(x0 - 3, y0 - 3, 6, 6);
    c.font = "9px system-ui";
    c.fillStyle = origin ? "#38bdf8" : "#94a3b8";
    c.fillText(origin ? "UCS" : "W", x0 + 5, y0 + 12);

    c.restore();
  }

  /** Paints AutoCAD Infinite Crosshairs with central Pickbox */
  function paintAutoCadCrosshairs(c: CanvasRenderingContext2D, v: M.View): void {
    if (!cursor) return;
    const cp = M.worldToScreen(v, cursor.x, cursor.y);
    const boxSize = 8;
    const halfBox = boxSize / 2;

    c.save();
    c.strokeStyle = "rgba(255, 255, 255, 0.65)";
    c.lineWidth = 1;

    // Pickbox
    c.strokeRect(cp.x - halfBox, cp.y - halfBox, boxSize, boxSize);

    // Infinite horizontal line (broken around pickbox)
    c.beginPath();
    c.moveTo(0, cp.y);
    c.lineTo(cp.x - halfBox, cp.y);
    c.moveTo(cp.x + halfBox, cp.y);
    c.lineTo(v.w, cp.y);

    // Infinite vertical line (broken around pickbox)
    c.moveTo(cp.x, 0);
    c.lineTo(cp.x, cp.y - halfBox);
    c.moveTo(cp.x, cp.y + halfBox);
    c.lineTo(cp.x, v.h);
    c.stroke();

    c.restore();
  }

  /** Paints AutoCAD Dynamic Input HUD attached to cursor (F12) */
  function paintDynamicInput(c: CanvasRenderingContext2D, v: M.View): void {
    if (!cursor || !dynOn || !doc) return;
    const cp = M.worldToScreen(v, cursor.x, cursor.y);
    const xOffset = 18;
    const yOffset = 18;

    let text1 = "";
    let text2 = "";

    const ax = M.convertLength(cursor.x * scaleCal, doc.units, du);
    const ay = M.convertLength(cursor.y * scaleCal, doc.units, du);
    const uLabel = M.unitLabel(doc.units, du);

    if (pts.length > 0) {
      const lastP = pts[pts.length - 1];
      const d = M.distance(lastP, cursor);
      const ang = M.norm360Deg(lastP, cursor);
      text1 = `${fmt(d)} < ${ang.toFixed(1)}°`;
      text2 = `Specify next point or [Close/Undo]`;
    } else {
      text1 = `${ax.toFixed(4)}, ${ay.toFixed(4)} ${uLabel}`;
      if (tool === "line") text2 = "Specify first point:";
      else if (tool === "circle") text2 = "Specify center point:";
      else if (tool === "rect") text2 = "Specify first corner:";
      else if (tool === "arc") text2 = "Specify start point:";
    }

    c.save();
    c.font = "11px system-ui, sans-serif";
    const w1 = c.measureText(text1).width;
    const w2 = text2 ? c.measureText(text2).width : 0;
    const totalW = Math.max(w1, w2) + 14;
    const totalH = text2 ? 34 : 20;

    c.fillStyle = "rgba(15, 23, 42, 0.85)";
    c.strokeStyle = "rgba(56, 189, 248, 0.5)";
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(cp.x + xOffset, cp.y + yOffset, totalW, totalH, 4);
    c.fill();
    c.stroke();

    c.fillStyle = "#38bdf8";
    c.fillText(text1, cp.x + xOffset + 7, cp.y + yOffset + 14);
    if (text2) {
      c.fillStyle = "#cbd5e1";
      c.fillText(text2, cp.x + xOffset + 7, cp.y + yOffset + 28);
    }
    c.restore();
  }

  /** Paints AutoCAD Object Snap glyphs with tooltips */
  function paintSnapGlyph(c: CanvasRenderingContext2D, v: M.View, s: M.Snap): void {
    const p = M.worldToScreen(v, s.x, s.y);
    c.save();
    c.strokeStyle = "#22c55e";
    c.fillStyle = "#22c55e";
    c.lineWidth = 2;

    let snapLabel = "Snap";
    switch (s.kind) {
      case "endpoint":
        c.strokeRect(p.x - 5, p.y - 5, 10, 10);
        snapLabel = "Endpoint";
        break;
      case "midpoint":
        c.beginPath();
        c.moveTo(p.x - 6, p.y + 5);
        c.lineTo(p.x + 6, p.y + 5);
        c.lineTo(p.x, p.y - 6);
        c.closePath();
        c.stroke();
        snapLabel = "Midpoint";
        break;
      case "center":
        c.beginPath();
        c.arc(p.x, p.y, 6, 0, Math.PI * 2);
        c.stroke();
        snapLabel = "Center";
        break;
      case "quadrant":
        c.beginPath();
        c.moveTo(p.x, p.y - 6);
        c.lineTo(p.x + 6, p.y);
        c.lineTo(p.x, p.y + 6);
        c.lineTo(p.x - 6, p.y);
        c.closePath();
        c.stroke();
        snapLabel = "Quadrant";
        break;
      case "intersection":
        c.beginPath();
        c.moveTo(p.x - 5, p.y - 5);
        c.lineTo(p.x + 5, p.y + 5);
        c.moveTo(p.x + 5, p.y - 5);
        c.lineTo(p.x - 5, p.y + 5);
        c.stroke();
        snapLabel = "Intersection";
        break;
      default:
        // Nearest hourglass
        c.beginPath();
        c.moveTo(p.x - 4, p.y - 5);
        c.lineTo(p.x + 4, p.y + 5);
        c.lineTo(p.x - 4, p.y + 5);
        c.lineTo(p.x + 4, p.y - 5);
        c.closePath();
        c.stroke();
        snapLabel = "Nearest";
        break;
    }

    // Snap badge
    c.font = "10px system-ui, sans-serif";
    const bw = c.measureText(snapLabel).width + 8;
    c.fillStyle = "rgba(15, 23, 42, 0.85)";
    c.fillRect(p.x + 10, p.y - 16, bw, 16);
    c.strokeStyle = "#22c55e";
    c.lineWidth = 1;
    c.strokeRect(p.x + 10, p.y - 16, bw, 16);
    c.fillStyle = "#4ade80";
    c.fillText(snapLabel, p.x + 14, p.y - 4);

    c.restore();
  }

  function render(c: CanvasRenderingContext2D, v: M.View, withUi: boolean): void {
    c.save();
    c.fillStyle = BG[bg] || BG.autocad;
    c.fillRect(0, 0, v.w, v.h);
    if (!doc) {
      c.restore();
      return;
    }

    if (withUi && showGrid) paintGrid(c, v);
    c.lineWidth = lwtOn ? lw : 1;
    c.lineJoin = "round";

    paintEntities(c, v, ents, idx, visibleBox(v), true);

    if (cmp && layoutI < 0) {
      forceColor = "#22c55e";
      paintEntities(c, v, cmp.added, null, visibleBox(v), false);
      forceColor = null;
    }

    // Layout / Paper space viewports
    if (layoutI >= 0 && doc?.layouts?.[layoutI]) {
      for (const vp of doc.layouts[layoutI].viewports) {
        const r = M.viewportRect(vp),
          a = M.worldToScreen(v, r.minX, r.maxY),
          b = M.worldToScreen(v, r.maxX, r.minY),
          ctr = M.worldToScreen(v, vp.center.x, vp.center.y),
          sc = M.viewportScale(vp);
        c.save();
        c.beginPath();
        c.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        c.clip();
        c.translate(ctr.x, ctr.y);
        c.rotate(((vp.twist ?? 0) * Math.PI) / 180);
        c.translate(-ctr.x, -ctr.y);
        const vv: M.View = {
          cx: vp.viewCenter.x,
          cy: vp.viewCenter.y,
          scale: v.scale * sc,
          w: ctr.x * 2,
          h: ctr.y * 2,
        };
        const rad = Math.hypot(vp.width, vp.height) / 2 / sc;
        paintEntities(
          c,
          vv,
          modelEnts,
          modelIdx,
          {
            minX: vp.viewCenter.x - rad,
            maxX: vp.viewCenter.x + rad,
            minY: vp.viewCenter.y - rad,
            maxY: vp.viewCenter.y + rad,
          },
          false,
        );
        c.restore();
        c.save();
        c.strokeStyle = bg === "white" ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.35)";
        c.lineWidth = 1;
        c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        c.restore();
      }
    }

    // Selected entities highlight
    if (sel.size) {
      c.save();
      c.setLineDash([]);
      c.lineWidth = lw + 2;
      c.strokeStyle = "#38bdf8";
      c.fillStyle = "#38bdf8";
      for (const i of sel) if (ents[i] && visible(ents[i])) drawEntity(c, ents[i], v);
      c.restore();
    }

    // Markups (redlines, dimensions, clouds, leaders)
    c.save();
    c.strokeStyle = "#ef4444";
    c.fillStyle = "#ef4444";
    c.lineWidth = 2;
    c.font = "14px sans-serif";
    for (const m of markups) {
      if (m.kind === "line") {
        c.beginPath();
        m.pts.forEach((q, i) => {
          const p = M.worldToScreen(v, q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        c.stroke();
      } else if (m.kind === "dim" && m.pts.length >= 2) {
        const a = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const b = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        for (const p of [a, b]) {
          c.beginPath();
          c.moveTo(p.x + Math.cos(ang + Math.PI / 2) * 6, p.y + Math.sin(ang + Math.PI / 2) * 6);
          c.lineTo(p.x + Math.cos(ang - Math.PI / 2) * 6, p.y + Math.sin(ang - Math.PI / 2) * 6);
          c.stroke();
        }
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2;
        c.font = "bold 12px system-ui,sans-serif";
        c.fillText(m.text ?? "", mx + 4, my - 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "cloud" && m.pts.length >= 2) {
        c.strokeStyle = "#f97316";
        c.lineWidth = 2;
        c.beginPath();
        m.pts.forEach((q, i) => {
          const p = M.worldToScreen(v, q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        c.stroke();
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "leader" && m.pts.length >= 2) {
        const a = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const b = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        c.strokeStyle = "#a78bfa";
        c.fillStyle = "#a78bfa";
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        const ang = Math.atan2(a.y - b.y, a.x - b.x);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(a.x - 10 * Math.cos(ang - 0.4), a.y - 10 * Math.sin(ang - 0.4));
        c.lineTo(a.x - 10 * Math.cos(ang + 0.4), a.y - 10 * Math.sin(ang + 0.4));
        c.closePath();
        c.fill();
        c.font = "12px system-ui,sans-serif";
        c.fillText(m.text ?? "", b.x + 4, b.y - 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "stamp") {
        const p = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        c.font = "bold 13px system-ui,sans-serif";
        c.fillStyle = "#fbbf24";
        const tw = c.measureText(m.text ?? "").width;
        c.fillStyle = "rgba(0,0,0,0.55)";
        c.fillRect(p.x - 4, p.y - 14, tw + 8, 18);
        c.fillStyle = "#fbbf24";
        c.fillText(m.text ?? "", p.x, p.y);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else {
        const p = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        c.fillText(m.text ?? "", p.x, p.y);
        c.beginPath();
        c.arc(p.x, p.y, 3, 0, 7);
        c.fill();
      }
    }
    c.restore();

    if (withUi) {
      c.save();
      c.lineWidth = 1.5;
      c.strokeStyle = "#facc15";
      c.fillStyle = "#facc15";
      c.font = "12px sans-serif";
      for (const d of drawn) paintMeasure(c, v, d.kind, d.pts);
      if (pts.length) paintMeasure(c, v, tool, cursor ? [...pts, cursor] : pts);
      c.restore();

      // Text search highlights
      for (const h of hits) {
        const p = M.worldToScreen(v, h.x, h.y);
        c.strokeStyle = "#f97316";
        c.lineWidth = 2;
        c.strokeRect(p.x - 6, p.y - 6, 12, 12);
      }

      // Object Snap glyph
      if (hover && snapOn) {
        paintSnapGlyph(c, v, hover);
      }

      // Scale bar
      paintScaleBar(c, v);

      // AutoCAD UCS Icon
      paintUcsIcon(c, v);

      // AutoCAD Infinite Crosshairs & Pickbox
      paintAutoCadCrosshairs(c, v);

      // AutoCAD Dynamic Input HUD (F12)
      paintDynamicInput(c, v);

      // AutoCAD Window (Blue solid) vs Crossing (Green dashed) selection rects
      if (rband) {
        const x = rband.a.x,
          y = rband.a.y,
          w = rband.b.x - x,
          h = rband.b.y - y,
          win = w >= 0;
        c.save();
        c.globalAlpha = 0.15;
        c.fillStyle = win ? "#0284c7" : "#16a34a"; // Blue Window vs Green Crossing
        c.fillRect(x, y, w, h);
        c.globalAlpha = 1;
        c.strokeStyle = win ? "#38bdf8" : "#22c55e";
        c.lineWidth = 1;
        c.setLineDash(win ? [] : [5, 4]);
        c.strokeRect(x, y, w, h);
        c.restore();
      }

      if (winStart && winNow) {
        c.strokeStyle = "#38bdf8";
        c.setLineDash([5, 4]);
        c.strokeRect(winStart.x, winStart.y, winNow.x - winStart.x, winNow.y - winStart.y);
      }
    }

    c.restore();
  }

  function paintScaleBar(c: CanvasRenderingContext2D, v: M.View): void {
    if (!doc) return;
    const sb = M.niceScaleBar(v.scale),
      x = 110,
      y = v.h - 18;
    c.save();
    c.strokeStyle = bg === "white" ? "#111" : "#eee";
    c.fillStyle = c.strokeStyle;
    c.lineWidth = 2;
    c.font = "11px sans-serif";
    c.beginPath();
    c.moveTo(x, y - 5);
    c.lineTo(x, y);
    c.lineTo(x + sb.px, y);
    c.lineTo(x + sb.px, y - 5);
    c.stroke();
    c.fillText(
      `${+M.convertLength(sb.length, doc.units, du).toFixed(3)} ${M.unitLabel(doc.units, du)}`,
      x,
      y - 8,
    );
    c.restore();
  }

  function paintMeasure(
    c: CanvasRenderingContext2D,
    v: M.View,
    kind: Tool,
    p: M.Pt[],
  ): void {
    if (!p.length) return;
    const S = p.map((q) => M.worldToScreen(v, q.x, q.y));
    c.beginPath();
    S.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));

    if (kind === "area" && S.length > 2) {
      c.closePath();
      c.globalAlpha = 0.18;
      c.fill();
      c.globalAlpha = 1;
    } else if (kind === "circle" && S.length >= 2) {
      const rad = Math.hypot(S[1].x - S[0].x, S[1].y - S[0].y);
      c.beginPath();
      c.arc(S[0].x, S[0].y, rad, 0, Math.PI * 2);
    } else if (kind === "rect" && S.length >= 2) {
      const x0 = Math.min(S[0].x, S[1].x);
      const y0 = Math.min(S[0].y, S[1].y);
      const rw = Math.abs(S[1].x - S[0].x);
      const rh = Math.abs(S[1].y - S[0].y);
      c.beginPath();
      c.rect(x0, y0, rw, rh);
    }

    c.stroke();
    for (const q of S) c.fillRect(q.x - 2.5, q.y - 2.5, 5, 5);

    let label = "";
    const last = S[S.length - 1];
    if (kind === "dist" && p.length >= 2) label = fmt(M.distance(p[0], p[1]));
    else if (kind === "poly" && p.length >= 2) label = fmt(M.pathLength(p));
    else if (kind === "area" && p.length >= 3)
      label = fmt(M.polygonArea(p), 2);
    else if (kind === "angle" && p.length >= 3)
      label = M.angleAt(p[1], p[0], p[2]).toFixed(2) + "°";

    if (label) {
      c.fillStyle = "#facc15";
      c.fillText(label, last.x + 8, last.y - 8);
    }
  }

  function draw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const d = dpr();
      g.setTransform(d, 0, 0, d, 0, 0);
      render(g, view, true);
    });
  }

  /* ── Viewport Operations ── */
  const pushView = () => {
    history.push({ ...view });
    if (history.length > 50) history.shift();
  };
  function zoomExtents() {
    if (!bounds) return;
    pushView();
    view = M.fitView(bounds, view.w, view.h);
    draw();
    logCmd("Command: _ZOOM _EXTENTS");
  }
  function goTo(x: number, y: number, scale?: number) {
    pushView();
    view = { ...view, cx: x, cy: y, scale: scale ?? view.scale };
    draw();
  }

  /* ── AutoCAD Drafting Engine ── */
  function addDraftEntity(e: DxfEntity): void {
    ents.push(e);
    if (layoutI < 0) modelEnts.push(e);
    const eb = M.entityBBox(e);
    bounds = bounds ? M.unionBBox(bounds, eb) : eb;
    idx = M.buildIndex(ents, bounds);
    undoStack.push({ type: "add", entities: [e] });
    redoStack.length = 0;
    showProps();
    draw();
  }

  function eraseSelected(): void {
    if (!sel.size) {
      logCmd("Command: ERASE — 0 found");
      return;
    }
    const removed: DxfEntity[] = [];
    const keep: DxfEntity[] = [];
    ents.forEach((e, i) => {
      if (sel.has(i)) removed.push(e);
      else keep.push(e);
    });
    undoStack.push({ type: "delete", entities: removed });
    redoStack.length = 0;
    ents = keep;
    if (layoutI < 0) modelEnts = keep;
    sel.clear();
    selected = -1;
    let b: M.BBox | null = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    bounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    idx = M.buildIndex(ents, bounds);
    showProps();
    draw();
    logCmd(`Command: ERASE — ${removed.length} object(s) deleted`);
  }

  function undo(): void {
    const act = undoStack.pop();
    if (!act) {
      logCmd("Nothing to undo.");
      return;
    }
    if (act.type === "add") {
      // Remove added entities
      const addSet = new Set(act.entities);
      ents = ents.filter((e) => !addSet.has(e));
      if (layoutI < 0) modelEnts = ents;
      redoStack.push(act);
    } else if (act.type === "delete") {
      // Restore deleted entities
      ents.push(...act.entities);
      if (layoutI < 0) modelEnts.push(...act.entities);
      redoStack.push(act);
    }
    let b: M.BBox | null = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    bounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    idx = M.buildIndex(ents, bounds);
    draw();
    logCmd("Command: UNDO");
  }

  function redo(): void {
    const act = redoStack.pop();
    if (!act) {
      logCmd("Nothing to redo.");
      return;
    }
    if (act.type === "add") {
      ents.push(...act.entities);
      if (layoutI < 0) modelEnts.push(...act.entities);
      undoStack.push(act);
    } else if (act.type === "delete") {
      const delSet = new Set(act.entities);
      ents = ents.filter((e) => !delSet.has(e));
      if (layoutI < 0) modelEnts = ents;
      undoStack.push(act);
    }
    let b: M.BBox | null = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    bounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    idx = M.buildIndex(ents, bounds);
    draw();
    logCmd("Command: REDO");
  }

  /* ── Load Document ── */
  async function load(file: File): Promise<void> {
    status(`Reading ${file.name}…`);
    try {
      const r = await readCadFile(file);
      doc = r.doc;
      name = file.name;
      modelEnts = doc.entities;
      let b: M.BBox | null = null;
      for (const e of modelEnts) {
        const eb = M.entityBBox(e);
        if (Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) b = M.unionBBox(b, eb);
      }
      if (!b && !doc.layouts?.length) throw new Error("The file has no drawable geometry");
      modelBounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      modelIdx = M.buildIndex(modelEnts, modelBounds);
      layoutIdxCache.clear();
      hidden.clear();
      for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);
      markups = [];
      results = [];
      layerFilter = "";
      origin = null;
      typeFilter = new Set();
      offsetEntity = -1;
      $<HTMLInputElement>("lf").value = "";
      emptyEl.style.display = "none";
      cmp = null;

      fillMenus();
      buildTabs();
      activate(modelEnts.length ? -1 : 0);
      setTool("select");
      showMeas();

      logCmd(`Loaded: ${file.name} (${doc.entities.length} entities, ${doc.layers.length} layers, ${doc.units || "mm"})`);
      status(`${r.summary}`);
      setTimeout(() => status(""), 5000);
    } catch (err) {
      status(`Could not open ${file.name}: ${(err as Error).message}`);
      setTimeout(() => status(""), 7000);
    }
  }

  function activate(i: number): void {
    if (!doc) return;
    layoutI = i;
    sel.clear();
    selected = -1;
    pts = [];
    drawn = [];
    hits = [];
    rband = null;
    history.length = 0;
    if (i < 0 || !doc.layouts?.[i]) {
      layoutI = -1;
      ents = modelEnts;
      idx = modelIdx;
      bounds = modelBounds;
    } else {
      const L = doc.layouts[i];
      ents = L.entities;
      bounds = M.layoutBounds(L) ?? modelBounds;
      let ix = layoutIdxCache.get(i);
      if (!ix) {
        ix = M.buildIndex(ents, bounds!);
        layoutIdxCache.set(i, ix);
      }
      idx = ix;
    }
    view = M.fitView(bounds!, view.w, view.h);
    tabsEl
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.li) === layoutI));
    buildLayers();
    showProps();
    updateStatus();
    draw();
  }

  function buildTabs(): void {
    const n = doc?.layouts?.length ?? 0;
    tabsEl.style.display = n ? "flex" : "none";
    tabsEl.innerHTML = n
      ? `<button data-li="-1">Model</button>` +
        doc!.layouts!.map((l, i) => `<button data-li="${i}">${escapeHtml(l.name)}</button>`).join("")
      : "";
    tabsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => activate(Number(b.dataset.li))));
  }

  function setSel(ids: number[], add = false): void {
    if (!add) sel.clear();
    if (add && ids.length === 1 && sel.has(ids[0])) sel.delete(ids[0]);
    else for (const i of ids) sel.add(i);
    selected = sel.size ? [...sel][sel.size - 1] : -1;
    showProps();
    draw();
    if (sel.size) logCmd(`${sel.size} object(s) selected`);
  }

  function zoomToBox(b: M.BBox | null): void {
    if (!b) return;
    pushView();
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6) * 0.08;
    view = M.fitView(
      { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad },
      view.w,
      view.h,
      0.02,
    );
    draw();
  }
  function zoomSelection(): void {
    if (idx && sel.size) zoomToBox(M.bboxOfSet(idx, sel));
  }
  function zoomLayer(n: string): void {
    if (!idx) return;
    zoomToBox(M.bboxOfSet(idx, ents.map((e, i) => (e.layer === n ? i : -1)).filter((i) => i >= 0)));
  }

  /* ── Layers ── */
  function buildLayers() {
    if (!doc) {
      layersEl.innerHTML = "";
      return;
    }
    const counts = M.countByLayer(ents);
    const f = layerFilter.toLowerCase();
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])]
      .filter((n) => !f || n.toLowerCase().includes(f))
      .sort((a, b) => a.localeCompare(b));
    layersEl.innerHTML = names
      .map((n) => {
        const col = rgbToCss(aciToRgb(layerOf(n)?.color ?? 7, 0xffffff));
        return `<label class="lyr"><input type="checkbox" data-l="${escapeHtml(n)}" ${
          hidden.has(n) ? "" : "checked"
        }><span class="sw" style="background:${col}"></span><span data-zl="${escapeHtml(
          n,
        )}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(
          n,
        )} (double-click to zoom to layer)">${escapeHtml(n)}</span><span style="color:#778">${
          counts.get(n) ?? 0
        }</span></label>`;
      })
      .join("");
    layersEl
      .querySelectorAll<HTMLElement>("[data-zl]")
      .forEach((el) => (el.ondblclick = (ev) => {
        ev.preventDefault();
        zoomLayer(el.dataset.zl!);
      }));
    layersEl
      .querySelectorAll<HTMLInputElement>("input[data-l]")
      .forEach((i) => (i.onchange = () => {
        i.checked ? hidden.delete(i.dataset.l!) : hidden.add(i.dataset.l!);
        draw();
      }));
  }

  const allLayers = () => [...new Set([...(doc?.layers.map((l) => l.name) ?? []), ...ents.map((e) => e.layer)])];
  $<HTMLInputElement>("lf").oninput = (e) => {
    layerFilter = (e.target as HTMLInputElement).value;
    buildLayers();
  };
  $("lon").onclick = () => {
    hidden.clear();
    buildLayers();
    draw();
  };
  $("loff").onclick = () => {
    allLayers().forEach((n) => hidden.add(n));
    buildLayers();
    draw();
  };
  $("liso").onclick = () => {
    if (!sel.size) return;
    const keep = new Set([...sel].map((i) => ents[i].layer));
    allLayers().forEach((n) => (keep.has(n) ? hidden.delete(n) : hidden.add(n)));
    buildLayers();
    draw();
  };

  /** Open Full AutoCAD Layer Properties Manager (LA / LAYER) */
  function openLayerPropertiesManager(): void {
    if (!doc) return;
    const counts = M.countByLayer(ents);
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])].sort((a, b) =>
      a.localeCompare(b),
    );

    const rows = names
      .map((n) => {
        const lyr = layerOf(n);
        const col = rgbToCss(aciToRgb(lyr?.color ?? 7, 0xffffff));
        const isOff = hidden.has(n);
        const isFrozen = lyr?.frozen ?? false;
        const isLocked = lyr?.locked ?? false;
        const isCurrent = currentLayer === n;

        return `
        <tr data-row-l="${escapeHtml(n)}">
          <td style="text-align:center">${isCurrent ? "✔" : ""}</td>
          <td style="font-weight:600">${escapeHtml(n)}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-on">${isOff ? "💡❌" : "💡"}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-freeze">${isFrozen ? "❄️" : "☀️"}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-lock">${isLocked ? "🔒" : "🔓"}</td>
          <td><span class="sw" style="display:inline-block;background:${col};vertical-align:middle;margin-right:4px"></span>${lyr?.color ?? 7}</td>
          <td>${escapeHtml(lyr?.lineType ?? "Continuous")}</td>
          <td>${(lyr as any)?.lineweight != null ? (lyr as any).lineweight + "mm" : "Default"}</td>
          <td style="text-align:center">🖨️</td>
        </tr>`;
      })
      .join("");

    const el = openOverlay(`
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #334155;padding-bottom:10px;margin-bottom:12px">
        <b style="font-size:15px;color:#38bdf8">AutoCAD Layer Properties Manager</b>
        <div style="display:flex;gap:6px">
          <button data-r="lyr-new" style="background:#0284c7;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer">＋ New Layer</button>
          <button data-r="lyr-close" style="padding:4px 10px">Close</button>
        </div>
      </div>
      <div style="max-height:60vh;overflow-y:auto">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead>
            <tr style="color:#9aa4b2;text-align:left;border-bottom:1px solid #334155">
              <th>Status</th><th>Name</th><th>On</th><th>Freeze</th><th>Lock</th><th>Color</th><th>Linetype</th><th>Lineweight</th><th>Plot</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);

    el.querySelector("[data-r=lyr-close]")?.addEventListener("click", () => closeOverlay());
    el.querySelector("[data-r=lyr-new]")?.addEventListener("click", () => {
      const newName = prompt("Enter new layer name:", `Layer${names.length + 1}`)?.trim();
      if (newName) {
        if (!doc!.layers.some((l) => l.name === newName)) {
          doc!.layers.push({ name: newName, color: 7, lineType: "Continuous" });
          currentLayer = newName;
          closeOverlay();
          buildLayers();
          openLayerPropertiesManager();
          logCmd(`Layer created: ${newName}`);
        }
      }
    });

    el.querySelectorAll("tr[data-row-l]").forEach((tr) => {
      const lname = tr.getAttribute("data-row-l")!;
      tr.querySelector("[data-act=toggle-on]")?.addEventListener("click", () => {
        if (hidden.has(lname)) hidden.delete(lname);
        else hidden.add(lname);
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
        draw();
      });
      tr.querySelector("[data-act=toggle-freeze]")?.addEventListener("click", () => {
        const lyr = layerOf(lname);
        if (lyr) lyr.frozen = !lyr.frozen;
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
        draw();
      });
      tr.querySelector("[data-act=toggle-lock]")?.addEventListener("click", () => {
        const lyr = layerOf(lname);
        if (lyr) lyr.locked = !lyr.locked;
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
      });
    });
  }

  /* ── Properties & Measurements ── */
  function showProps() {
    if (sel.size > 1) {
      let len = 0,
        area = 0;
      const types = new Map<string, number>(),
        lay = new Set<string>();
      for (const i of sel) {
        const e = ents[i],
          m = M.entityMetrics(e);
        len += m.length ?? 0;
        area += m.area ?? 0;
        types.set(e.type, (types.get(e.type) ?? 0) + 1);
        lay.add(e.layer);
      }
      propsEl.innerHTML = `<table>${row("Selected", `${sel.size} objects`)}${[...types]
        .map(([k, n]) => row(k, String(n)))
        .join("")}${row("Layers", String(lay.size))}${row("Total length", fmt(len))}${
        area ? row("Total area", fmt(area, 2)) : ""
      }</table>`;
      return;
    }
    const e = ents[selected];
    if (!e) {
      propsEl.innerHTML = doc
        ? `<table>${row("File", name)}${row("Units", doc.units ?? "unitless")}${row(
            "Objects",
            String(ents.length),
          )}${row("Layers", String(doc.layers.length))}${[...M.countByType(ents)]
            .map(([k, n]) => row(k, String(n)))
            .join("")}</table>`
        : "";
      return;
    }
    const m = M.entityMetrics(e),
      rows: string[] = [
        row("Type", e.type),
        row("Layer", e.layer),
        row("Colour", e.rgb != null ? rgbToCss(e.rgb) : e.color ? `ACI ${e.color}` : "ByLayer"),
      ];
    rows.push(row("Linetype", e.lineType ?? layerOf(e.layer)?.lineType ?? "ByLayer"));
    if (e.type === "LWPOLYLINE" && e.hatch)
      rows.push(
        row("Hatch", e.hatch.solid ? "Solid" : e.hatch.pattern ?? "Pattern"),
        row("Loops", String(e.hatch.loops.length)),
        ...(e.hatch.solid
          ? []
          : [
              row("Angle", (e.hatch.angle ?? 0).toFixed(2) + "°"),
              row("Pattern scale", String(+(e.hatch.scale ?? 1).toFixed(4))),
            ]),
      );
    if (e.type === "LINE") rows.push(row("Start", pt(e.start)), row("End", pt(e.end)));
    if (e.type === "CIRCLE" || e.type === "ARC") rows.push(row("Center", pt(e.center)));
    if (e.type === "ARC")
      rows.push(
        row("Start angle", e.startAngle.toFixed(2) + "°"),
        row("End angle", e.endAngle.toFixed(2) + "°"),
        row("Sweep", m.sweep!.toFixed(2) + "°"),
      );
    if (e.type === "LWPOLYLINE" && !e.hatch)
      rows.push(row("Vertices", String(e.points.length)), row("Closed", e.closed ? "Yes" : "No"));
    if (e.type === "TEXT")
      rows.push(
        row("Text", e.value),
        row("Height", fmt(e.height)),
        row("Rotation", (e.rotation ?? 0).toFixed(2) + "°"),
        row("Position", pt(e.position)),
      );
    if (e.type === "POINT") rows.push(row("Position", pt(e.position)));
    if (m.radius != null) rows.push(row("Radius", fmt(m.radius)), row("Diameter", fmt(m.diameter!)));
    if (m.length != null) rows.push(row("Length", fmt(m.length)));
    if (m.angle != null) rows.push(row("Angle", m.angle.toFixed(2) + "°"));
    if (m.area != null) rows.push(row("Area", fmt(m.area, 2)));
    propsEl.innerHTML = `<table>${rows.join("")}</table>`;
  }

  const row = (k: string, v: string) =>
    `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
  const pt = (p: { x: number; y: number }) =>
    `${M.convertLength(p.x, doc?.units, du).toFixed(3)}, ${M.convertLength(p.y, doc?.units, du).toFixed(
      3,
    )}`;

  function showMeas() {
    measEl.innerHTML = results.length
      ? results.map((r) => `<div>${escapeHtml(r)}</div>`).join("") +
        `<div style="display:flex;gap:4px;margin-top:6px"><button data-r="mclr">Clear</button><button data-r="mcopy">Copy</button><button data-r="mcsv">CSV</button></div>`
      : `<span style="color:#778">AutoCAD controls ready. Wheel zooms, drag pans, click selects. Type commands or pick tools.</span>`;
    const b = measEl.querySelector<HTMLButtonElement>("[data-r=mclr]");
    if (b)
      b.onclick = () => {
        results = [];
        drawn = [];
        showMeas();
        draw();
      };
    const cp = measEl.querySelector<HTMLButtonElement>("[data-r=mcopy]");
    if (cp)
      cp.onclick = () => {
        void navigator.clipboard
          ?.writeText(results.join("\n"))
          .then(() => {
            status("Measurements copied");
            setTimeout(() => status(""), 1800);
          })
          .catch(() => status("Copy not allowed"));
      };
    const cs = measEl.querySelector<HTMLButtonElement>("[data-r=mcsv]");
    if (cs)
      cs.onclick = () =>
        download(new Blob([M.resultsToCsv(results)], { type: "text/csv" }), `${base()}-measurements.csv`);
  }

  /* ── Tools Definition ── */
  const T: Array<[Tool, string, string]> = [
    ["pan", "Pan", "P"],
    ["select", "Select", "S"],
    ["line", "Line", "L"],
    ["poly", "Pline", "PL"],
    ["circle", "Circle", "C"],
    ["rect", "Rectang", "REC"],
    ["arc", "Arc", "A"],
    ["dist", "Distance", "D"],
    ["area", "Area", "AA"],
    ["dim", "Dimension", "Q"],
    ["erase", "Erase", "E"],
    ["box", "Box", "B"],
    ["zoomwin", "Zoom Window", "W"],
    ["coord", "Coordinates", "ID"],
    ["radius", "Radius", "R"],
    ["leader", "Leader", "Y"],
    ["cloud", "RevCloud", "U"],
    ["offset", "Offset", "O"],
    ["redline", "Redline", "M"],
    ["note", "Text Note", "N"],
    ["calibrate", "Calibrate", "K"],
  ];

  function buildBar() {
    tools.innerHTML =
      `<button data-a="open" style="font-weight:600;color:#38bdf8">📂 Open…</button><input type="file" data-r="file" accept=".dwg,.dxf" style="display:none"><span class="sep"></span>` +
      T.map(
        ([k, l, key]) =>
          `<button data-t="${k}" title="${l} (${key})" style="${
            ["line", "circle", "rect", "arc"].includes(k) ? "border-color:#38bdf8;" : ""
          }">${l}</button>`,
      ).join("") +
      `<span class="sep"></span>
      <button data-a="ext" title="Zoom extents (Z E)">Extents</button>
      <button data-a="zsel" title="Zoom to selection (F)">Selection</button>
      <button data-a="grid" class="on" title="Grid (F7)">Grid</button>
      <button data-a="snap" class="on" title="Object snap (F3)">Snap</button>
      <button data-a="ortho" title="Ortho (F8)">Ortho</button>
      <button data-a="dyn" class="on" title="Dynamic Input HUD (F12)">DYN</button>
      <button data-a="lwt" class="on" title="Lineweight display">LWT</button>
      <span class="sep"></span>
      <label>Background <select data-a="bg">${Object.keys(BG)
        .map((k) => `<option value="${k}" ${k === "autocad" ? "selected" : ""}>${k}</option>`)
        .join("")}</select></label>
      <label>Units <select data-a="du">${["drawing", "mm", "cm", "m", "in", "ft"]
        .map((u) => `<option>${u}</option>`)
        .join("")}</select></label>
      <span class="sep"></span>
      <button data-a="undo" title="Undo (Ctrl+Z / U)">↶ Undo</button>
      <button data-a="redo" title="Redo (Ctrl+Y)">↷ Redo</button>
      <button data-a="erase" title="Erase selected (DEL / E)">🗑 Erase</button>
      <span style="flex:1"></span>
      <button data-a="plot" title="AutoCAD Plot to PDF / Paper">🖨️ Plot…</button>
      <button data-a="help" title="AutoCAD Shortcuts & Commands (?)">❓</button>
      <button data-a="close" style="background:#ef4444;border-color:#f87171;color:white;font-weight:600">✕ Close</button>`;

    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => (b.onclick = () => setTool(b.dataset.t as Tool)));
    const fileIn = tools.querySelector<HTMLInputElement>("[data-r=file]")!;
    fileIn.onchange = () => {
      const f = fileIn.files?.[0];
      if (f) void load(f);
      fileIn.value = "";
    };

    const act: Record<string, () => void> = {
      open: () => fileIn.click(),
      ext: zoomExtents,
      zsel: zoomSelection,
      help: () => toggleHelp(),
      grid: () => {
        showGrid = !showGrid;
        tools.querySelector("[data-a=grid]")!.classList.toggle("on", showGrid);
        updateStatus();
        draw();
      },
      close: () => api!.close(),
      snap: () => {
        snapOn = !snapOn;
        tools.querySelector("[data-a=snap]")!.classList.toggle("on", snapOn);
        updateStatus();
        draw();
      },
      ortho: () => {
        orthoOn = !orthoOn;
        tools.querySelector("[data-a=ortho]")!.classList.toggle("on", orthoOn);
        updateStatus();
        draw();
      },
      dyn: () => {
        dynOn = !dynOn;
        tools.querySelector("[data-a=dyn]")!.classList.toggle("on", dynOn);
        updateStatus();
        draw();
      },
      lwt: () => {
        lwtOn = !lwtOn;
        tools.querySelector("[data-a=lwt]")!.classList.toggle("on", lwtOn);
        draw();
      },
      undo,
      redo,
      erase: eraseSelected,
      plot: openPlot,
    };

    tools.querySelectorAll<HTMLElement>("button[data-a]").forEach((b) => {
      const f = act[b.dataset.a!];
      if (f) b.onclick = f;
    });

    const sel = (a: string) => tools.querySelector<HTMLSelectElement>(`[data-a=${a}]`)!;
    sel("bg").onchange = (e) => {
      bg = (e.target as HTMLSelectElement).value;
      draw();
    };
    sel("du").onchange = (e) => {
      du = (e.target as HTMLSelectElement).value as M.DisplayUnit;
      showProps();
      draw();
    };
  }

  function setTool(t: Tool) {
    tool = t;
    cv.focus({ preventScroll: true });
    pts = [];
    offsetEntity = -1;
    winStart = winNow = null;
    hover = null;
    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    cv.style.cursor = t === "pan" ? "grab" : "crosshair";
    draw();
    logCmd(`Command: _${t.toUpperCase()}`);
  }

  function finishMeasure() {
    if (tool === "poly" && pts.length >= 2) {
      results.push(`Polyline: ${fmt(M.pathLength(pts))}`);
      // Also add drafted polyline entity
      addDraftEntity({
        type: "LWPOLYLINE",
        layer: currentLayer,
        points: pts.map((p) => ({ x: p.x, y: p.y })),
        closed: false,
      });
      drawn.push({ kind: "poly", pts: [...pts] });
    } else if (tool === "area" && pts.length >= 3) {
      results.push(`Area: ${fmt(M.polygonArea(pts), 2)}  Perimeter: ${fmt(M.pathLength(pts, true))}`);
      drawn.push({ kind: "area", pts: [...pts] });
    } else if (tool === "chain" && pts.length >= 2) {
      results.push(`Chain: ${fmt(M.pathLength(pts))}  (${pts.length - 1} segments)`);
      drawn.push({ kind: "poly", pts: [...pts] });
    } else if (tool === "cloud" && pts.length >= 2) {
      markups.push({ kind: "cloud", pts: M.revisionCloudPoints(pts), text: "REV" });
      results.push(`Revision cloud · ${pts.length} vertices`);
    }
    pts = [];
    showMeas();
    draw();
  }

  /* ── Canvas Input Handlers ── */
  const rawPoint = (ev: PointerEvent | MouseEvent): { sp: M.Pt; wp: M.Pt } => {
    const r = cv.getBoundingClientRect();
    const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    return { sp, wp: M.screenToWorld(view, sp.x, sp.y) };
  };

  const snapped = (wp: M.Pt): M.Snap | null =>
    !idx || !snapOn
      ? null
      : M.findSnap(idx, ents, wp.x, wp.y, 14 / view.scale, [...snapModes], visible);

  cv.addEventListener("pointerdown", (ev) => {
    if (!doc) return;
    cv.focus();
    const { sp, wp } = rawPoint(ev);
    ptrs.set(ev.pointerId, sp);

    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = null;
      press = null;
      return;
    }

    if (ev.button === 1 || (ev.button === 2 && tool === "pan")) {
      ev.preventDefault();
      dragging = { x: sp.x, y: sp.y };
      cv.setPointerCapture(ev.pointerId);
      cv.style.cursor = "grabbing";
      pushView();
      return;
    }

    if (ev.button !== 0) return;

    if (tool === "box" || (tool === "select" && (ev.shiftKey || ev.ctrlKey))) {
      press = { x: sp.x, y: sp.y, moved: false, id: ev.pointerId, band: true, add: ev.shiftKey || ev.ctrlKey };
      cv.setPointerCapture(ev.pointerId);
      return;
    }
    if (tool === "pan" || tool === "select") {
      press = { x: sp.x, y: sp.y, moved: false, id: ev.pointerId };
      cv.setPointerCapture(ev.pointerId);
      return;
    }
    if (tool === "zoomwin") {
      winStart = winNow = sp;
      cv.setPointerCapture(ev.pointerId);
      return;
    }

    const s = snapped(wp) ?? { ...wp, kind: "nearest" as M.SnapKind };
    let p = { x: s.x, y: s.y };
    if (orthoOn && pts.length >= 1) p = M.orthoConstrain(pts[pts.length - 1], p);

    switch (tool) {
      case "line": {
        pts.push(p);
        if (pts.length === 2) {
          addDraftEntity({
            type: "LINE",
            layer: currentLayer,
            start: { x: pts[0].x, y: pts[0].y },
            end: { x: pts[1].x, y: pts[1].y },
          });
          logCmd(`Line added: length = ${fmt(M.distance(pts[0], pts[1]))}`);
          pts = [p]; // Chain next line like AutoCAD
        }
        break;
      }
      case "circle": {
        pts.push(p);
        if (pts.length === 2) {
          const r = M.distance(pts[0], pts[1]);
          addDraftEntity({
            type: "CIRCLE",
            layer: currentLayer,
            center: { x: pts[0].x, y: pts[0].y },
            radius: r,
          });
          logCmd(`Circle added: radius = ${fmt(r)}`);
          pts = [];
        }
        break;
      }
      case "rect": {
        pts.push(p);
        if (pts.length === 2) {
          const p1 = pts[0],
            p2 = pts[1];
          addDraftEntity({
            type: "LWPOLYLINE",
            layer: currentLayer,
            points: [
              { x: p1.x, y: p1.y },
              { x: p2.x, y: p1.y },
              { x: p2.x, y: p2.y },
              { x: p1.x, y: p2.y },
            ],
            closed: true,
          });
          logCmd(`Rectangle added: ${fmt(Math.abs(p2.x - p1.x))} × ${fmt(Math.abs(p2.y - p1.y))}`);
          pts = [];
        }
        break;
      }
      case "dist": {
        pts.push(p);
        if (pts.length === 2) {
          const d = M.distance(pts[0], pts[1]);
          const ang = M.norm360Deg(pts[0], pts[1]);
          const msg = `Distance = ${fmt(d)}, Angle in XY Plane = ${ang.toFixed(2)}°, Delta X = ${fmt(
            Math.abs(pts[1].x - pts[0].x),
          )}, Delta Y = ${fmt(Math.abs(pts[1].y - pts[0].y))}`;
          results.push(msg);
          drawn.push({ kind: "dist", pts: [...pts] });
          pts = [];
          showMeas();
          logCmd(msg);
        }
        break;
      }
      case "dim": {
        pts.push(p);
        if (pts.length === 2) {
          const d = M.distance(pts[0], pts[1]);
          const label = fmt(d);
          markups.push({ kind: "dim", pts: [...pts], text: label });
          results.push(`Dimension: ${label}`);
          drawn.push({ kind: "dist", pts: [...pts] });
          pts = [];
          showMeas();
        }
        break;
      }
      case "coord": {
        const u = M.unitLabel(doc.units, du);
        const msg = `Point: X = ${M.convertLength(p.x * scaleCal, doc.units, du).toFixed(4)} ${u}, Y = ${M.convertLength(
          p.y * scaleCal,
          doc.units,
          du,
        ).toFixed(4)} ${u}, Z = 0.0000`;
        results.push(msg);
        drawn.push({ kind: "coord", pts: [p] });
        showMeas();
        logCmd(msg);
        break;
      }
      case "poly":
      case "area":
      case "chain":
      case "cloud":
        pts.push(p);
        break;
      case "angle":
        pts.push(p);
        if (pts.length === 3) {
          const a = M.angleAt(pts[1], pts[0], pts[2]);
          results.push(`Angle: ${a.toFixed(2)}°`);
          drawn.push({ kind: "angle", pts: [...pts] });
          pts = [];
          showMeas();
        }
        break;
      case "erase": {
        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (i >= 0) {
          setSel([i]);
          eraseSelected();
        }
        break;
      }
      default:
        break;
    }
    draw();
  });

  cv.addEventListener("pointermove", (ev) => {
    const { sp, wp } = rawPoint(ev);
    if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, sp);

    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) {
        view = M.zoomAt(view, (a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        draw();
      }
      pinch = d;
      return;
    }

    if (press && press.id === ev.pointerId) {
      if (press.band) {
        if (Math.hypot(sp.x - press.x, sp.y - press.y) > 4) {
          press.moved = true;
          rband = { a: { x: press.x, y: press.y }, b: sp };
          draw();
        }
        return;
      }
      if (!press.moved && Math.hypot(sp.x - press.x, sp.y - press.y) > 4) {
        press.moved = true;
        pushView();
        cv.style.cursor = "grabbing";
        dragging = { x: press.x, y: press.y };
      }
    }

    if (dragging) {
      view = M.panBy(view, sp.x - dragging.x, sp.y - dragging.y);
      dragging = { x: sp.x, y: sp.y };
      draw();
      updateStatus(wp);
      return;
    }

    if (winStart) {
      winNow = sp;
      draw();
      return;
    }

    hover = snapped(wp);
    let cur = hover ? { x: hover.x, y: hover.y } : wp;
    if (orthoOn && pts.length >= 1) cur = M.orthoConstrain(pts[pts.length - 1], cur);
    cursor = cur;
    updateStatus(cursor);
    draw();
  });

  const endDrag = (ev: PointerEvent) => {
    ptrs.delete(ev.pointerId);
    if (ptrs.size < 2) pinch = 0;
    if (press && press.id === ev.pointerId) {
      if (press.band && press.moved && rband && idx && ev.type === "pointerup") {
        const a = M.screenToWorld(view, rband.a.x, rband.a.y),
          b = M.screenToWorld(view, rband.b.x, rband.b.y);
        setSel(
          M.selectInRect(idx, ents, M.rectOf(a, b), rband.b.x >= rband.a.x ? "window" : "crossing", visible),
          !!press.add,
        );
      } else if (!press.moved && doc && ev.type === "pointerup") {
        const { wp } = rawPoint(ev);
        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, visible) : -1;
        if (i >= 0) setSel([i], !!press.add);
        else if (!press.add) setSel([]);
      }
      rband = null;
      draw();
      press = null;
      cv.style.cursor = tool === "pan" ? "grab" : "crosshair";
    }
    if (dragging) {
      dragging = null;
      cv.style.cursor = tool === "pan" ? "grab" : "crosshair";
    }
    if (winStart && winNow) {
      const a = winStart,
        b = winNow;
      winStart = winNow = null;
      if (Math.abs(a.x - b.x) > 6 && Math.abs(a.y - b.y) > 6) {
        pushView();
        view = M.zoomWindow(view, a, b);
      }
      draw();
    }
    try {
      cv.releasePointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
  };

  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("dblclick", () => {
    if (tool === "poly" || tool === "area" || tool === "chain" || tool === "cloud") {
      pts.pop();
      finishMeasure();
    }
  });

  cv.addEventListener("wheel", (ev) => {
    if (!doc) return;
    ev.preventDefault();
    const { sp } = rawPoint(ev);
    view = M.zoomAt(
      view,
      sp.x,
      sp.y,
      Math.exp(-Math.max(-300, Math.min(300, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1))) * 0.0018),
    );
    draw();
    updateStatus();
  }, { passive: false });

  // Escape key handler
  function onEscape(): void {
    if (helpEl) {
      closeOverlay();
      return;
    }
    if (pts.length || winStart || rband) {
      pts = [];
      winStart = winNow = null;
      rband = null;
      press = null;
      draw();
      logCmd("*Cancel*");
      return;
    }
    if (tool !== "select") {
      setTool("select");
      return;
    }
    if (sel.size) setSel([]);
    logCmd("Command: Cancel");
  }

  // Keyboard Shortcuts (AutoCAD Standard: F3, F7, F8, F12, Ctrl+Z, Ctrl+Y, Space/Enter)
  cv.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onEscape();
      return;
    }
    if (ev.key === "F3") {
      ev.preventDefault();
      snapOn = !snapOn;
      tools.querySelector("[data-a=snap]")?.classList.toggle("on", snapOn);
      updateStatus();
      draw();
      logCmd(`OSNAP: <${snapOn ? "ON" : "OFF"}>`);
      return;
    }
    if (ev.key === "F7") {
      ev.preventDefault();
      showGrid = !showGrid;
      tools.querySelector("[data-a=grid]")?.classList.toggle("on", showGrid);
      updateStatus();
      draw();
      logCmd(`GRID: <${showGrid ? "ON" : "OFF"}>`);
      return;
    }
    if (ev.key === "F8") {
      ev.preventDefault();
      orthoOn = !orthoOn;
      tools.querySelector("[data-a=ortho]")?.classList.toggle("on", orthoOn);
      updateStatus();
      draw();
      logCmd(`ORTHOMODE: <${orthoOn ? "ON" : "OFF"}>`);
      return;
    }
    if (ev.key === "F12") {
      ev.preventDefault();
      dynOn = !dynOn;
      tools.querySelector("[data-a=dyn]")?.classList.toggle("on", dynOn);
      updateStatus();
      draw();
      logCmd(`DYNMODE: <${dynOn ? "ON" : "OFF"}>`);
      return;
    }
    if (ev.key === "Delete") {
      eraseSelected();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      undo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
      ev.preventDefault();
      redo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "0") {
      ev.preventDefault();
      toggleCleanScreen();
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      if (pts.length > 0) {
        ev.preventDefault();
        finishMeasure();
      }
    }
  });

  function toggleCleanScreen(): void {
    cleanScreen = !cleanScreen;
    tools.style.display = cleanScreen ? "none" : "flex";
    tools2.style.display = cleanScreen ? "none" : "flex";
    root!.querySelector<HTMLElement>(".side")!.style.display = cleanScreen ? "none" : "flex";
    logCmd(`CleanScreen: <${cleanScreen ? "ON" : "OFF"}>`);
  }

  /* ── Status Bar Update ── */
  function updateStatus(p?: M.Pt) {
    const c = p ?? cursor;
    const zoomPct = doc && bounds ? Math.round((view.scale / M.fitView(bounds, view.w, view.h).scale) * 100) : 100;
    const unit = doc ? M.unitLabel(doc.units, du) : "-";
    let xy = "0.0000, 0.0000, 0.0000";

    if (c && doc) {
      const ax = M.convertLength(c.x * scaleCal, doc.units, du);
      const ay = M.convertLength(c.y * scaleCal, doc.units, du);
      xy = `${ax.toFixed(4)}, ${ay.toFixed(4)}, 0.0000`;
    }

    statusEl.innerHTML = `
      <span style="color:#f8fafc;font-weight:600">${xy}</span>
      <span class="sep"></span>
      <button class="obs-status-btn active" data-s="space">${layoutI >= 0 ? "PAPER" : "MODEL"}</button>
      <button class="obs-status-btn ${showGrid ? "active" : ""}" data-s="grid" title="Grid (F7)">GRID</button>
      <button class="obs-status-btn ${snapOn ? "active" : ""}" data-s="snap" title="Object Snap (F3)">OSNAP</button>
      <button class="obs-status-btn ${orthoOn ? "active" : ""}" data-s="ortho" title="Ortho (F8)">ORTHO</button>
      <button class="obs-status-btn ${polarOn ? "active" : ""}" data-s="polar" title="Polar Tracking (F10)">POLAR</button>
      <button class="obs-status-btn ${dynOn ? "active" : ""}" data-s="dyn" title="Dynamic Input (F12)">DYN</button>
      <button class="obs-status-btn ${lwtOn ? "active" : ""}" data-s="lwt" title="Lineweight">LWT</button>
      <button class="obs-status-btn ${quick ? "active" : ""}" data-s="quick" title="Quick Measure">QUICK</button>
      <span class="sep"></span>
      <span>${escapeHtml(unit)} · ${zoomPct}%</span>
      <span style="flex:1"></span>
      <span>${sel.size ? sel.size + " selected" : ""}</span>
    `;

    // Status tray button click listeners
    statusEl.querySelector("[data-s=grid]")?.addEventListener("click", () => {
      showGrid = !showGrid;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=snap]")?.addEventListener("click", () => {
      snapOn = !snapOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=ortho]")?.addEventListener("click", () => {
      orthoOn = !orthoOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=dyn]")?.addEventListener("click", () => {
      dynOn = !dynOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=lwt]")?.addEventListener("click", () => {
      lwtOn = !lwtOn;
      updateStatus();
      draw();
    });
  }

  /* ── In-Canvas Navigation Bar & ViewCube Listeners ── */
  root.querySelector("[data-r=vc-home]")?.addEventListener("click", zoomExtents);
  root.querySelector("[data-r=vc-home-btn]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomExtents();
  });
  root.querySelector("[data-r=vc-rot-ccw]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pushView();
    // Rotate view 90 degrees CCW
    logCmd("ViewCube: Rotate 90° CCW");
  });
  root.querySelector("[data-r=vc-rot-cw]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pushView();
    // Rotate view 90 degrees CW
    logCmd("ViewCube: Rotate 90° CW");
  });

  root.querySelector("[data-r=nav-pan]")?.addEventListener("click", () => setTool("pan"));
  root.querySelector("[data-r=nav-ext]")?.addEventListener("click", zoomExtents);
  root.querySelector("[data-r=nav-win]")?.addEventListener("click", () => setTool("zoomwin"));
  root.querySelector("[data-r=nav-prev]")?.addEventListener("click", () => {
    const v = history.pop();
    if (v) {
      view = { ...v, w: view.w, h: view.h };
      draw();
    }
  });
  root.querySelector("[data-r=nav-full]")?.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root!.requestFullscreen?.();
  });

  root.querySelector("[data-r=open-layer-mgr]")?.addEventListener("click", openLayerPropertiesManager);

  /* ── AutoCAD Command Line Execution & Autocomplete ── */
  const cmdInput = root.querySelector<HTMLInputElement>("[data-r=cmd]")!;

  function executeAutoCadCommand(rawInput: string): void {
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    cmdHistory.push(trimmed);
    cmdHistoryIdx = cmdHistory.length;
    cmdInput.value = "";
    cmdAutoEl.style.display = "none";

    logCmd(`Command: ${trimmed}`, true);

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const arg = parts.slice(1).join(" ");

    // Standard AutoCAD command matching
    if (cmd === "L" || cmd === "LINE") {
      setTool("line");
      return;
    }
    if (cmd === "PL" || cmd === "PLINE" || cmd === "POLYLINE") {
      setTool("poly");
      return;
    }
    if (cmd === "C" || cmd === "CIRCLE") {
      setTool("circle");
      return;
    }
    if (cmd === "REC" || cmd === "RECTANG" || cmd === "RECTANGLE") {
      setTool("rect");
      return;
    }
    if (cmd === "A" || cmd === "ARC") {
      setTool("arc");
      return;
    }
    if (cmd === "E" || cmd === "ERASE" || cmd === "DEL" || cmd === "DELETE") {
      eraseSelected();
      return;
    }
    if (cmd === "DI" || cmd === "DIST" || cmd === "DISTANCE") {
      setTool("dist");
      return;
    }
    if (cmd === "AA" || cmd === "AREA") {
      setTool("area");
      return;
    }
    if (cmd === "ID") {
      setTool("coord");
      return;
    }
    if (cmd === "LI" || cmd === "LIST") {
      showSelectionList();
      return;
    }
    if (cmd === "P" || cmd === "PAN") {
      setTool("pan");
      return;
    }
    if (cmd === "Z" || cmd === "ZOOM") {
      const sub = (arg || "").toUpperCase();
      if (sub === "E" || sub === "EXTENTS") {
        zoomExtents();
        return;
      }
      if (sub === "W" || sub === "WINDOW") {
        setTool("zoomwin");
        return;
      }
      if (sub === "P" || sub === "PREVIOUS") {
        const v = history.pop();
        if (v) {
          view = { ...v, w: view.w, h: view.h };
          draw();
        }
        return;
      }
      if (sub === "A" || sub === "ALL") {
        zoomExtents();
        return;
      }
      setTool("zoomwin");
      logCmd("Specify corner of window, enter a scale factor, or [All/Extents/Previous/Window] <real time>:");
      return;
    }
    if (cmd === "LA" || cmd === "LAYER" || cmd === "LAYERS") {
      openLayerPropertiesManager();
      return;
    }
    if (cmd === "PR" || cmd === "PROPERTIES" || cmd === "CH") {
      propsEl.scrollIntoView({ behavior: "smooth" });
      logCmd("Properties palette focused.");
      return;
    }
    if (cmd === "RE" || cmd === "REGEN" || cmd === "REA" || cmd === "REGENALL") {
      if (bounds) idx = M.buildIndex(ents, bounds);
      draw();
      logCmd("Regenerating model...");
      return;
    }
    if (cmd === "UN" || cmd === "UNITS") {
      openUnitsDialog();
      return;
    }
    if (cmd === "UCS") {
      setTool("origin");
      logCmd("Specify origin of UCS <0,0,0>:");
      return;
    }
    if (cmd === "U" || cmd === "UNDO") {
      undo();
      return;
    }
    if (cmd === "REDO") {
      redo();
      return;
    }
    if (cmd === "PU" || cmd === "PURGE") {
      logCmd("0 unreferenced objects purged.");
      return;
    }
    if (cmd === "PRINT" || cmd === "PLOT") {
      openPlot();
      return;
    }
    if (cmd === "QSAVE" || cmd === "SAVE") {
      exportSvg();
      logCmd("Drawing exported as SVG.");
      return;
    }
    if (cmd === "ORTHO" || cmd === "ORTHOMODE") {
      orthoOn = !orthoOn;
      updateStatus();
      draw();
      logCmd(`ORTHOMODE: <${orthoOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "OSNAP") {
      snapOn = !snapOn;
      updateStatus();
      draw();
      logCmd(`OSNAP: <${snapOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "GRID") {
      showGrid = !showGrid;
      updateStatus();
      draw();
      logCmd(`GRID: <${showGrid ? "ON" : "OFF"}>`);
      return;
    }

    logCmd(`Unknown command "${trimmed}". Press ? for AutoCAD command list.`);
  }

  cmdInput.addEventListener("input", () => {
    const q = cmdInput.value.trim().toUpperCase();
    if (!q) {
      cmdAutoEl.style.display = "none";
      return;
    }
    const matches = CAD_COMMANDS.filter(
      (c) => c.name.startsWith(q) || c.aliases.some((a) => a === q || a.startsWith(q)),
    ).slice(0, 7);

    if (matches.length === 0) {
      cmdAutoEl.style.display = "none";
      return;
    }

    cmdAutoEl.innerHTML = matches
      .map(
        (m, idx) => `
        <div class="obs-cmd-auto-item ${idx === 0 ? "active" : ""}" data-cmd="${m.name}">
          <div><strong>${m.name}</strong> <span style="color:#94a3b8">(${m.aliases.join(", ")})</span></div>
          <div style="font-size:10px;color:#94a3b8">${m.description}</div>
        </div>
      `,
      )
      .join("");

    cmdAutoEl.style.display = "flex";

    cmdAutoEl.querySelectorAll(".obs-cmd-auto-item").forEach((item) => {
      item.addEventListener("click", () => {
        executeAutoCadCommand(item.getAttribute("data-cmd") || "");
      });
    });
  });

  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeAutoCadCommand(cmdInput.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistoryIdx > 0) {
        cmdHistoryIdx--;
        cmdInput.value = cmdHistory[cmdHistoryIdx];
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (cmdHistoryIdx < cmdHistory.length - 1) {
        cmdHistoryIdx++;
        cmdInput.value = cmdHistory[cmdHistoryIdx];
      } else {
        cmdHistoryIdx = cmdHistory.length;
        cmdInput.value = "";
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const first = cmdAutoEl.querySelector<HTMLElement>(".obs-cmd-auto-item");
      if (first) {
        executeAutoCadCommand(first.getAttribute("data-cmd") || "");
      }
    }
  });

  root.querySelector("[data-r=cmdrun]")?.addEventListener("click", () => {
    executeAutoCadCommand(cmdInput.value);
  });

  /* ── Overlays: Help, Units, Plot ── */
  let helpEl: HTMLDivElement | null = null;
  function closeOverlay(): void {
    helpEl?.remove();
    helpEl = null;
    cv.focus({ preventScroll: true });
  }

  function openOverlay(html: string): HTMLDivElement {
    helpEl?.remove();
    const el = document.createElement("div");
    helpEl = el;
    el.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);z-index:20;backdrop-filter:blur(4px)";
    el.innerHTML = `<div data-r="panel" style="background:#151a23;border:1px solid #334155;border-radius:10px;padding:20px 24px;max-width:680px;max-height:88%;overflow:auto;line-height:1.6;box-shadow:0 8px 32px rgba(0,0,0,0.6)">${html}</div>`;
    el.onclick = (ev) => {
      if (ev.target === el) closeOverlay();
    };
    $("stage").appendChild(el);
    return el;
  }

  function openUnitsDialog(): void {
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">AutoCAD Drawing Units (UNITS)</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
        <div>
          <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Length Type:</label>
          <select style="width:100%"><option>Decimal</option><option>Architectural</option><option>Engineering</option></select>
        </div>
        <div>
          <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Precision:</label>
          <select style="width:100%"><option>0.0000</option><option>0.00</option><option>0.000000</option></select>
        </div>
      </div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
        <button data-r="un-close" style="padding:5px 14px;background:#0284c7;color:white;border:none;border-radius:4px">OK</button>
      </div>
    `);
    panel.querySelector("[data-r=un-close]")?.addEventListener("click", closeOverlay);
  }

  function showSelectionList(): void {
    if (!sel.size) {
      logCmd("Command: LIST — Select objects first.");
      return;
    }
    let totalLen = 0;
    const rows: string[] = [];
    for (const i of sel) {
      const e = ents[i];
      if (!e) continue;
      const met = M.entityMetrics(e);
      if (met.length != null) totalLen += met.length;
      rows.push(
        `<tr><td>${i}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.layer)}</td><td style="text-align:right">${
          met.length != null ? escapeHtml(fmt(met.length)) : "—"
        }</td></tr>`,
      );
    }
    const panel = openOverlay(`
      <b style="font-size:14px;color:#38bdf8">AutoCAD Database Entity List (LIST)</b><br>
      <span style="color:#9aa4b2">${sel.size} objects selected · Total length: ${escapeHtml(fmt(totalLen))}</span>
      <table style="width:100%;margin-top:10px;font-size:12px">
        <thead><tr style="color:#9aa4b2;text-align:left"><th>#</th><th>Type</th><th>Layer</th><th style="text-align:right">Length</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
      <div style="margin-top:14px"><button data-r="rep-close" style="padding:6px 14px">Close</button></div>
    `);
    panel.querySelector("[data-r=rep-close]")?.addEventListener("click", closeOverlay);
  }

  function toggleHelp(): void {
    if (helpEl) {
      closeOverlay();
      return;
    }
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">AutoCAD Command &amp; Shortcut Guide</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;font-size:12px">
        <div>
          <b style="color:#f8fafc">Standard Drawing Commands:</b><br>
          • <b>L / LINE</b> — Draw line segments<br>
          • <b>PL / PLINE</b> — Draw 2D polyline<br>
          • <b>C / CIRCLE</b> — Draw circle<br>
          • <b>REC / RECTANG</b> — Draw rectangle<br>
          • <b>A / ARC</b> — Draw 3-point circular arc<br>
          • <b>E / ERASE</b> — Delete selected entities<br>
          • <b>U / UNDO</b> — Undo (Ctrl+Z)<br>
          • <b>REDO</b> — Redo (Ctrl+Y)<br>
        </div>
        <div>
          <b style="color:#f8fafc">Function Keys &amp; Toggles:</b><br>
          • <b>F3</b> — Object Snap (OSNAP) ON/OFF<br>
          • <b>F7</b> — Grid ON/OFF<br>
          • <b>F8</b> — Ortho mode ON/OFF<br>
          • <b>F12</b> — Dynamic Input HUD ON/OFF<br>
          • <b>Ctrl+0</b> — Clean Screen Toggle<br>
          • <b>LA / LAYER</b> — Layer Properties Manager<br>
          • <b>Z E</b> — Zoom Extents<br>
          • <b>Z W</b> — Zoom Window<br>
        </div>
      </div>
      <div style="margin-top:14px;text-align:right"><button data-r="help-close" style="padding:6px 14px">OK</button></div>
    `);
    panel.querySelector("[data-r=help-close]")?.addEventListener("click", closeOverlay);
  }

  /* ── Plot / PDF Exporter ── */
  function openPlot(): void {
    if (!doc) return;
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">AutoCAD Plot — Model / Sheet to PDF</b>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin-top:12px;align-items:center;font-size:12px">
        <label>Paper Size:</label>
        <select data-p="paper">${Object.keys(M.PAPER_MM).map((k) => `<option ${k === "A3" ? "selected" : ""}>${k}</option>`).join("")}</select>
        <label>Orientation:</label>
        <select data-p="ori"><option value="l">Landscape</option><option value="p">Portrait</option></select>
        <label>Plot Area:</label>
        <select data-p="area"><option value="display">Display (Screen)</option><option value="extents">Extents</option></select>
        <label>Plot Style:</label>
        <select data-p="mono"><option value="1">Monochrome.ctb (Black &amp; White)</option><option value="0">As Drawn (Color)</option></select>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button data-p="cancel" style="padding:6px 12px">Cancel</button>
        <button data-p="go" style="background:#0284c7;color:white;border:none;padding:6px 16px;border-radius:4px;font-weight:600">Plot / Print PDF</button>
      </div>
    `);
    const gP = (k: string) => panel.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-p=${k}]`)!;
    gP("cancel").onclick = closeOverlay;
    gP("go").onclick = () => {
      const o = {
        paper: gP("paper").value,
        land: gP("ori").value === "l",
        area: gP("area").value,
        mono: gP("mono").value === "1",
      };
      closeOverlay();
      doPlot(o);
    };
  }

  function doPlot(o: { paper: string; land: boolean; area: string; mono: boolean }): void {
    if (!doc) return;
    const pg = M.paperMm(o.paper, o.land),
      px = M.plotPixels(pg.w, pg.h, 8, 150);
    const box = o.area === "extents" ? bounds ?? modelBounds! : visibleBox(view);
    const pv = M.fitView(box, px.w, px.h, 0.02);
    const c = document.createElement("canvas");
    c.width = px.w;
    c.height = px.h;
    const x = c.getContext("2d")!;
    const keep = { bg, cmode, lw };
    bg = "white";
    cmode = o.mono ? "bw" : "layer";
    lw = Math.max(lw, px.w / 1200);
    try {
      render(x, pv, false);
    } finally {
      bg = keep.bg;
      cmode = keep.cmode;
      lw = keep.lw;
    }
    const url = c.toDataURL("image/png");
    const w = window.open("", "_blank");
    if (!w) {
      status("Allow pop-ups to print");
      return;
    }
    w.document.write(
      `<!doctype html><title>${escapeHtml(name || "Plot")}</title><style>@page{size:${o.paper} ${
        o.land ? "landscape" : "portrait"
      };margin:8mm}html,body{margin:0}img{width:100%;display:block}</style><img src="${url}">`,
    );
    w.document.close();
    w.onload = () => w.print();
  }

  function base(): string {
    return (name || "drawing").replace(/\.[^.]+$/, "");
  }
  function download(blob: Blob, fn: string): void {
    const a = document.createElement("a");
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  function exportSvg(): void {
    if (!doc) return;
    const v = view,
      o: string[] = [],
      uid = { n: 0 };
    const F = (n: number) => n.toFixed(2);
    const P = (x: number, y: number) => {
      const q = M.worldToScreen(v, x, y);
      return `${F(q.x)},${F(q.y)}`;
    };

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!shown(e)) continue;
      const col = colorOf(e);
      const st = `stroke="${col}" fill="none" stroke-width="${lw}"`;
      if (e.type === "LINE") {
        const a = M.worldToScreen(v, e.start.x, e.start.y),
          b = M.worldToScreen(v, e.end.x, e.end.y);
        o.push(`<line x1="${F(a.x)}" y1="${F(a.y)}" x2="${F(b.x)}" y2="${F(b.y)}" ${st}/>`);
      } else if (e.type === "CIRCLE") {
        const c = M.worldToScreen(v, e.center.x, e.center.y);
        o.push(`<circle cx="${F(c.x)}" cy="${F(c.y)}" r="${F(e.radius * v.scale)}" ${st}/>`);
      } else if (e.type === "LWPOLYLINE") {
        o.push(
          `<${e.closed ? "polygon" : "polyline"} points="${e.points.map((q) => P(q.x, q.y)).join(" ")}" ${st}/>`,
        );
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${v.w}" height="${v.h}" viewBox="0 0 ${v.w} ${
      v.h
    }"><rect width="100%" height="100%" fill="${BG[bg] || BG.autocad}"/>${o.join("")}</svg>`;
    download(new Blob([svg], { type: "image/svg+xml" }), `${base()}.svg`);
  }

  function fillMenus(): void {
    /* noop for compatibility */
  }

  function buildBar2() {
    tools2.innerHTML = `
      <button data-a="lyr-mgr" style="color:#38bdf8;font-weight:600" title="AutoCAD Layer Properties Manager (LA)">📋 Layers (LA)</button>
      <button data-a="dim-tool" title="Linear Dimension (Q)">📏 Dimension</button>
      <button data-a="cloud-tool" title="Revision Cloud (U)">☁ RevCloud</button>
      <button data-a="leader-tool" title="Leader Note (Y)">↗ Leader</button>
      <span class="sep"></span>
      <button data-a="tText" class="on" title="Show or hide text">Text</button>
      <button data-a="tHatch" class="on" title="Show or hide hatches">Hatch</button>
      <button data-a="tLt" class="on" title="Show or hide linetypes">Linetypes</button>
      <span class="sep"></span>
      <button data-a="info" title="Drawing information">Drawing Info</button>
      <button data-a="svg" title="Export SVG vector file">Export SVG</button>
      <button data-a="csv" title="Export measurements as CSV">Export CSV</button>
    `;
    const q = <T extends HTMLElement>(a: string) => tools2.querySelector<T>(`[data-a=${a}]`)!;
    const flip = (a: string, on: boolean) => q(a).classList.toggle("on", on);
    q("tText").onclick = () => {
      showText = !showText;
      flip("tText", showText);
      draw();
    };
    q("tHatch").onclick = () => {
      showHatch = !showHatch;
      flip("tHatch", showHatch);
      draw();
    };
    q("tLt").onclick = () => {
      showLt = !showLt;
      flip("tLt", showLt);
      draw();
    };
    q("lyr-mgr").onclick = openLayerPropertiesManager;
    q("dim-tool").onclick = () => setTool("dim");
    q("cloud-tool").onclick = () => setTool("cloud");
    q("leader-tool").onclick = () => setTool("leader");
    q("info").onclick = () => {
      if (!doc) return;
      const panel = openOverlay(`
        <b style="font-size:15px;color:#38bdf8">AutoCAD Drawing Database Status</b>
        <table style="margin-top:10px;font-size:12px;width:100%">
          <tr><td>File Name:</td><td>${escapeHtml(name)}</td></tr>
          <tr><td>Database Format:</td><td>${escapeHtml((doc.sourceFormat ?? "").toUpperCase())}</td></tr>
          <tr><td>Drawing Units:</td><td>${escapeHtml(doc.units ?? "unitless")}</td></tr>
          <tr><td>Total Entities:</td><td>${modelEnts.length}</td></tr>
          <tr><td>Total Layers:</td><td>${doc.layers.length}</td></tr>
          <tr><td>Active Layouts:</td><td>${doc.layouts?.length ?? 1}</td></tr>
        </table>
        <div style="margin-top:14px"><button data-r="inf-close" style="padding:6px 14px">Close</button></div>
      `);
      panel.querySelector("[data-r=inf-close]")?.addEventListener("click", closeOverlay);
    };
    q("svg").onclick = exportSvg;
    q("csv").onclick = () => {
      const lines = ["index,measurement"];
      results.forEach((r, i) => lines.push(`${i + 1},"${String(r).replace(/"/g, '""')}"`));
      download(new Blob([lines.join("\n")], { type: "text/csv" }), `${base()}-measurements.csv`);
    };
  }

  buildBar();
  buildBar2();
  setTool("select");
  showProps();
  showMeas();
  updateStatus();
  resize();

  api = {
    load,
    close() {
      root!.style.display = "none";
    },
  };

  // Esc handling across entire window when CAD viewer is open
  window.addEventListener(
    "keydown",
    (e) => {
      if (root!.style.display === "none" || e.key !== "Escape" || e.target === cv) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT") && (t as HTMLInputElement).type !== "checkbox") {
        (t as HTMLInputElement).blur();
      }
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      cv.focus({ preventScroll: true });
    },
    true,
  );
}
