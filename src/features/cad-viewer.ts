/**
 * CAD Viewer – a standalone 2D DWG/DXF viewer (DWG TrueView style) inside the app.
 * Pure geometry lives in modules/cad-viewer/viewer-math.ts; this file is canvas rendering + UI only.
 */
import { readCadFile } from "../modules/cad-link/index";
import { aciToRgb, rgbToCss } from "../modules/drawings/aci";
import type { DxfDocument, DxfEntity } from "../modules/drawings/dxf-types";
import { escapeHtml } from "../core/html-escape";
import * as M from "../modules/cad-viewer/viewer-math";

type Tool = "pan" | "select" | "box" | "dist" | "poly" | "area" | "angle" | "coord" | "radius" | "zoomwin" | "redline" | "note";
type ColorMode = "layer" | "bw" | "invert";
interface Markup { kind: "line" | "note"; pts: M.Pt[]; text?: string }

const BG: Record<string, string> = { black: "#000000", dark: "#1c2128", grey: "#808080", white: "#ffffff" };
let root: HTMLDivElement | null = null;
let api: { load(f: File): Promise<void>; close(): void } | null = null;

export function openCadViewer(file?: File): void {
  if (!root) build();
  root!.style.display = "flex";
  if (file) void api!.load(file);
}
export function closeCadViewer(): void { api?.close(); }

function build(): void {
  root = document.createElement("div");
  root.id = "obs-cad-viewer"; root.setAttribute("data-obs-own-wheel", "");
  root.style.cssText = "position:fixed;inset:0;z-index:10050;display:none;flex-direction:column;background:#0f1218;color:#e5e7eb;font:12px/1.35 system-ui,sans-serif";
  root.innerHTML = `
  <style>
    #obs-cad-viewer button,#obs-cad-viewer select,#obs-cad-viewer input{font:inherit;color:inherit;background:#1b212c;border:1px solid #2f3846;border-radius:5px;padding:4px 8px}
    #obs-cad-viewer button{cursor:pointer}#obs-cad-viewer button:hover{background:#263041}
    #obs-cad-viewer button.on{background:#2563eb;border-color:#3b82f6}
    #obs-cad-viewer .bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px;background:#151a23;border-bottom:1px solid #2a3140}
    #obs-cad-viewer .sep{width:1px;height:20px;background:#2f3846;margin:0 4px}
    #obs-cad-viewer .side{width:260px;display:flex;flex-direction:column;background:#151a23;border-left:1px solid #2a3140;min-height:0}
    #obs-cad-viewer .side h4{margin:0;padding:6px 8px;background:#1b212c;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa4b2}
    #obs-cad-viewer .lyr{display:flex;align-items:center;gap:6px;padding:2px 8px}
    #obs-cad-viewer .lyr:hover{background:#1b212c}
    #obs-cad-viewer .sw{width:12px;height:12px;border-radius:2px;border:1px solid #556}
    #obs-cad-viewer .sc{overflow:auto;min-height:0}
    #obs-cad-viewer table{width:100%;border-collapse:collapse}#obs-cad-viewer td{padding:2px 8px;border-bottom:1px solid #222a37}
    #obs-cad-viewer td:first-child{color:#9aa4b2}
  </style>
  <div class="bar" data-r="tools"></div>
  <div class="bar" data-r="tools2"></div>
  <div style="display:flex;flex:1;min-height:0">
    <div style="flex:1;position:relative;min-width:0" data-r="stage">
      <canvas data-r="cv" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none" tabindex="0"></canvas>
      <div data-r="empty" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9aa4b2;pointer-events:none">
        <div style="font-size:18px">Drop a DWG or DXF file here</div><div>or use Open</div></div>
      <div data-r="busy" style="display:none;position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#1b212c;padding:6px 12px;border-radius:6px"></div>
    </div>
    <div class="side">
      <h4>Layers</h4>
      <div style="padding:6px 8px 0"><input data-r="lf" placeholder="Filter layers…" style="width:100%;box-sizing:border-box"></div><div style="display:flex;gap:4px;padding:6px 8px"><button data-r="lon">All on</button><button data-r="loff">All off</button><button data-r="liso" title="Isolate the selected object's layer">Isolate</button></div>
      <div class="sc" data-r="layers" style="flex:1"></div>
      <h4>Properties</h4><div class="sc" data-r="props" style="max-height:34%;padding-bottom:4px"></div>
      <h4>Measurements</h4><div class="sc" data-r="meas" style="max-height:24%;padding:4px 8px"></div>
    </div>
  </div>
  <div data-r="tabs" style="display:none;gap:2px;padding:3px 8px 0;background:#151a23;border-top:1px solid #2a3140"></div>
  <div data-r="status" style="display:flex;gap:16px;padding:4px 10px;background:#151a23;border-top:1px solid #2a3140;color:#9aa4b2;font-variant-numeric:tabular-nums"></div>`;
  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(k: string) => root!.querySelector(`[data-r="${k}"]`) as T;
  const cv = $<HTMLCanvasElement>("cv"), g = cv.getContext("2d")!;
  const tools2 = $("tools2"), tabsEl = $("tabs"), tools = $("tools"), layersEl = $("layers"), propsEl = $("props"), measEl = $("meas"), statusEl = $("status"), emptyEl = $("empty"), busyEl = $("busy");

  let doc: DxfDocument | null = null, name = "";
  let ents: DxfEntity[] = [], idx: M.SpatialIndex | null = null, bounds: M.BBox | null = null;
  let view: M.View = { cx: 0, cy: 0, scale: 1, w: 800, h: 600 };
  const history: M.View[] = [];
  let tool: Tool = "select";
  let bg = "black", cmode: ColorMode = "layer", lw = 1, du: M.DisplayUnit = "drawing";
  const hidden = new Set<string>();
  let snapOn = true; const snapModes = new Set<M.SnapKind>(M.ALL_SNAPS);
  let selected = -1, hover: M.Snap | null = null, cursor: M.Pt | null = null;
  let pts: M.Pt[] = []; let results: string[] = []; let drawn: Array<{ kind: Tool; pts: M.Pt[] }> = [];
  let markups: Markup[] = []; let hits: M.TextHit[] = [], hitI = -1;
  let dragging: { x: number; y: number } | null = null, winStart: { x: number; y: number } | null = null, winNow: { x: number; y: number } | null = null;
  let raf = 0;
  let modelEnts: DxfEntity[] = [], modelIdx: M.SpatialIndex | null = null, modelBounds: M.BBox | null = null;
  let showText = true, showHatch = true, showLt = true, quick = false, forceColor: string | null = null;
  let cmp: { removed: Set<DxfEntity>; added: DxfEntity[] } | null = null; let tipEl: HTMLDivElement | null = null;
  let layoutI = -1; const layoutIdxCache = new Map<number, M.SpatialIndex>();
  let press: { x: number; y: number; moved: boolean; id: number; band?: boolean; add?: boolean } | null = null;
  const sel = new Set<number>(); let showGrid = false; let rband: { a: M.Pt; b: M.Pt } | null = null; let layerFilter = "";
  const ptrs = new Map<number, M.Pt>(); let pinch = 0;

  const inv = () => cmode === "invert";
  const fg = () => (bg === "white" || inv() ? 0x000000 : 0xffffff);
  const visible = (e: DxfEntity) => !hidden.has(e.layer);
  const shown = (e: DxfEntity) => visible(e) && !(e.type === "TEXT" && !showText) && !(e.type === "LWPOLYLINE" && e.hatch && !showHatch);
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
  const fmt = (v: number, p = 1) => M.formatQty(v, doc?.units, du, p);
  const dpr = () => window.devicePixelRatio || 1;
  const status = (m: string) => { busyEl.textContent = m; busyEl.style.display = m ? "block" : "none"; };

  function resize() {
    const r = cv.getBoundingClientRect(), d = dpr();
    cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d));
    view = { ...view, w: r.width, h: r.height }; draw();
  }
  const ro = new ResizeObserver(resize); ro.observe(cv);

  /* ── rendering ── */
  function drawEntity(c: CanvasRenderingContext2D, e: DxfEntity, v: M.View, flipY = true): void {
    const P = (x: number, y: number) => M.worldToScreen(v, x, y);
    c.beginPath();
    switch (e.type) {
      case "LINE": { const a = P(e.start.x, e.start.y), b = P(e.end.x, e.end.y); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); break; }
      case "CIRCLE": { const p = P(e.center.x, e.center.y); c.arc(p.x, p.y, e.radius * v.scale, 0, Math.PI * 2); c.stroke(); break; }
      case "ARC": { const p = P(e.center.x, e.center.y); const sw = M.arcSweepDeg(e.startAngle, e.endAngle) * Math.PI / 180, s = -e.startAngle * Math.PI / 180; c.arc(p.x, p.y, e.radius * v.scale, s, s - sw, true); c.stroke(); break; }
      case "LWPOLYLINE": { if (e.hatch) { drawHatch(c, e, v); break; } e.points.forEach((q, i) => { const p = P(q.x, q.y); i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); }); if (e.closed) c.closePath(); c.stroke(); break; }
      case "POINT": { const p = P(e.position.x, e.position.y); c.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); break; }
      case "TEXT": {
        const px = e.height * v.scale; const o = M.textOrigin(e);
        if (px < 3) { const p = P(e.position.x, e.position.y); const w = M.textBox(e).w * v.scale; const ox = o.dx * v.scale; c.moveTo(p.x + ox, p.y); c.lineTo(p.x + ox + w, p.y); c.stroke(); break; }
        const p = P(e.position.x, e.position.y); c.save(); c.translate(p.x, p.y); c.rotate(-(e.rotation ?? 0) * Math.PI / 180);
        c.font = `${Math.min(px, 600)}px sans-serif`; c.textAlign = e.align ?? "left";
        c.textBaseline = e.valign === "top" ? "top" : e.valign === "middle" ? "middle" : e.valign === "bottom" ? "bottom" : "alphabetic";
        c.fillText(e.value, 0, 0); c.restore(); break;
      }
    }
  }
  const visibleBox = (v: M.View): M.BBox => { const a = M.screenToWorld(v, 0, 0), b = M.screenToWorld(v, v.w, v.h); return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }; };
  function drawHatch(c: CanvasRenderingContext2D, e: Extract<DxfEntity, { type: "LWPOLYLINE" }>, v: M.View): void {
    const h = e.hatch!; c.save(); c.beginPath();
    for (const loop of h.loops) { loop.forEach((q, i) => { const p = M.worldToScreen(v, q.x, q.y); i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); }); c.closePath(); }
    const fams = h.solid ? [] : M.hatchFamilies(h.pattern, h.angle, h.scale);
    if (h.solid) c.fill("evenodd");
    else if (Math.min(...fams.map((f) => f.spacing)) * v.scale < 3) { c.globalAlpha = 0.35; c.fill("evenodd"); } // too dense to resolve: tint
    else {
      c.clip("evenodd");
      const vb = visibleBox(v), eb = M.entityBBox(e);
      const box = { minX: Math.max(vb.minX, eb.minX), minY: Math.max(vb.minY, eb.minY), maxX: Math.min(vb.maxX, eb.maxX), maxY: Math.min(vb.maxY, eb.maxY) };
      if (box.minX <= box.maxX && box.minY <= box.maxY) {
        c.lineWidth = Math.max(0.6, lw * 0.6); c.setLineDash([]); c.beginPath();
        for (const f of fams) for (const sg of M.hatchLineSegments(box, f.angle, f.spacing)) { const a = M.worldToScreen(v, sg[0], sg[1]), b = M.worldToScreen(v, sg[2], sg[3]); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); }
        c.stroke();
      }
    }
    c.restore();
  }
  const dashFor = (e: DxfEntity, v: M.View): number[] => (!doc || !showLt || (e.type === "LWPOLYLINE" && e.hatch) ? [] : M.resolveDash(e.lineType ?? layerOf(e.layer)?.lineType, doc.linetypes, doc.ltscale, v.scale));
  function paintEntities(c: CanvasRenderingContext2D, v: M.View, list: DxfEntity[], ix: M.SpatialIndex | null, cull: M.BBox, skipSel: boolean): void {
    list.forEach((e, i) => {
      if (!shown(e) || (skipSel && sel.has(i))) return;
      if (ix) { const bb = ix.boxes[i]; if (!M.boxesIntersect(bb, cull)) return; if (e.type !== "POINT" && (bb.maxX - bb.minX) * v.scale < 0.4 && (bb.maxY - bb.minY) * v.scale < 0.4) return; }
      const col = colorOf(e); c.strokeStyle = col; c.fillStyle = col; c.setLineDash(dashFor(e, v)); drawEntity(c, e, v);
    });
    c.setLineDash([]);
  }
  function render(c: CanvasRenderingContext2D, v: M.View, withUi: boolean): void {
    c.save(); c.fillStyle = BG[bg]; c.fillRect(0, 0, v.w, v.h);
    if (!doc) { c.restore(); return; }
    if (withUi && showGrid) paintGrid(c, v);
    c.lineWidth = lw; c.lineJoin = "round";
    paintEntities(c, v, ents, idx, visibleBox(v), true);
    if (cmp && layoutI < 0) { forceColor = "#22c55e"; paintEntities(c, v, cmp.added, null, visibleBox(v), false); forceColor = null; }
    if (layoutI >= 0 && doc?.layouts?.[layoutI]) {
      for (const vp of doc.layouts[layoutI].viewports) {
        const r = M.viewportRect(vp), a = M.worldToScreen(v, r.minX, r.maxY), b = M.worldToScreen(v, r.maxX, r.minY), ctr = M.worldToScreen(v, vp.center.x, vp.center.y), sc = M.viewportScale(vp);
        c.save(); c.beginPath(); c.rect(a.x, a.y, b.x - a.x, b.y - a.y); c.clip();
        c.translate(ctr.x, ctr.y); c.rotate((vp.twist ?? 0) * Math.PI / 180); c.translate(-ctr.x, -ctr.y);
        const vv: M.View = { cx: vp.viewCenter.x, cy: vp.viewCenter.y, scale: v.scale * sc, w: ctr.x * 2, h: ctr.y * 2 };
        const rad = Math.hypot(vp.width, vp.height) / 2 / sc;
        paintEntities(c, vv, modelEnts, modelIdx, { minX: vp.viewCenter.x - rad, maxX: vp.viewCenter.x + rad, minY: vp.viewCenter.y - rad, maxY: vp.viewCenter.y + rad }, false);
        c.restore();
        c.save(); c.strokeStyle = bg === "white" ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.35)"; c.lineWidth = 1; c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); c.restore();
      }
    }
    if (sel.size) { c.save(); c.setLineDash([]); c.lineWidth = lw + 2; c.strokeStyle = "#38bdf8"; c.fillStyle = "#38bdf8"; for (const i of sel) if (ents[i] && visible(ents[i])) drawEntity(c, ents[i], v); c.restore(); }
    // markups
    c.save(); c.strokeStyle = "#ef4444"; c.fillStyle = "#ef4444"; c.lineWidth = 2; c.font = "14px sans-serif";
    for (const m of markups) {
      if (m.kind === "line") { c.beginPath(); m.pts.forEach((q, i) => { const p = M.worldToScreen(v, q.x, q.y); i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); }); c.stroke(); }
      else { const p = M.worldToScreen(v, m.pts[0].x, m.pts[0].y); c.fillText(m.text ?? "", p.x, p.y); c.beginPath(); c.arc(p.x, p.y, 3, 0, 7); c.fill(); }
    }
    c.restore();
    if (withUi) {
      c.save(); c.lineWidth = 1.5; c.strokeStyle = "#facc15"; c.fillStyle = "#facc15"; c.font = "12px sans-serif";
      for (const d of drawn) paintMeasure(c, v, d.kind, d.pts);
      if (pts.length) paintMeasure(c, v, tool, cursor ? [...pts, cursor] : pts);
      c.restore();
      for (const h of hits) { const p = M.worldToScreen(v, h.x, h.y); c.strokeStyle = "#f97316"; c.lineWidth = 2; c.strokeRect(p.x - 6, p.y - 6, 12, 12); }
      if (hover && snapOn) {
        const p = M.worldToScreen(v, hover.x, hover.y); c.strokeStyle = "#22c55e"; c.lineWidth = 2;
        if (hover.kind === "midpoint") { c.beginPath(); c.moveTo(p.x - 6, p.y + 5); c.lineTo(p.x + 6, p.y + 5); c.lineTo(p.x, p.y - 6); c.closePath(); c.stroke(); }
        else if (hover.kind === "center" || hover.kind === "quadrant") { c.beginPath(); c.arc(p.x, p.y, 6, 0, 7); c.stroke(); }
        else if (hover.kind === "intersection") { c.beginPath(); c.moveTo(p.x - 6, p.y - 6); c.lineTo(p.x + 6, p.y + 6); c.moveTo(p.x + 6, p.y - 6); c.lineTo(p.x - 6, p.y + 6); c.stroke(); }
        else c.strokeRect(p.x - 5, p.y - 5, 10, 10);
      }
      paintScaleBar(c, v);
      if (cmp) { c.save(); c.font = "12px sans-serif"; c.fillStyle = "#ef4444"; c.fillText("■ only in this drawing", 12, 20); c.fillStyle = "#22c55e"; c.fillText("■ only in the compared drawing", 12, 36); c.fillStyle = "#9ca3af"; c.fillText("■ unchanged", 12, 52); c.restore(); }
      if (rband) { const x = rband.a.x, y = rband.a.y, w = rband.b.x - x, h = rband.b.y - y, win = w >= 0; c.save(); c.globalAlpha = 0.15; c.fillStyle = win ? "#38bdf8" : "#22c55e"; c.fillRect(x, y, w, h); c.globalAlpha = 1; c.strokeStyle = win ? "#38bdf8" : "#22c55e"; c.lineWidth = 1; c.setLineDash(win ? [] : [5, 4]); c.strokeRect(x, y, w, h); c.restore(); }
      if (winStart && winNow) { c.strokeStyle = "#38bdf8"; c.setLineDash([5, 4]); c.strokeRect(winStart.x, winStart.y, winNow.x - winStart.x, winNow.y - winStart.y); }
    }
    c.restore();
  }
  function paintGrid(c: CanvasRenderingContext2D, v: M.View): void {
    const st = M.gridStep(v.scale), tl = M.screenToWorld(v, 0, 0), br = M.screenToWorld(v, v.w, v.h);
    c.save(); c.strokeStyle = bg === "white" ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.12)"; c.lineWidth = 1; c.beginPath();
    for (let x = Math.ceil(tl.x / st) * st; x <= br.x; x += st) { const p = M.worldToScreen(v, x, 0).x; c.moveTo(p, 0); c.lineTo(p, v.h); }
    for (let y = Math.ceil(br.y / st) * st; y <= tl.y; y += st) { const p = M.worldToScreen(v, 0, y).y; c.moveTo(0, p); c.lineTo(v.w, p); }
    c.stroke(); c.restore();
  }
  function paintScaleBar(c: CanvasRenderingContext2D, v: M.View): void {
    if (!doc) return; const sb = M.niceScaleBar(v.scale), x = 16, y = v.h - 22;
    c.save(); c.strokeStyle = bg === "white" ? "#111" : "#eee"; c.fillStyle = c.strokeStyle; c.lineWidth = 2; c.font = "11px sans-serif";
    c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x, y); c.lineTo(x + sb.px, y); c.lineTo(x + sb.px, y - 5); c.stroke();
    c.fillText(`${+M.convertLength(sb.length, doc.units, du).toFixed(3)} ${M.unitLabel(doc.units, du)}`, x, y - 9); c.restore();
  }
  function paintMeasure(c: CanvasRenderingContext2D, v: M.View, kind: Tool, p: M.Pt[]): void {
    if (!p.length) return;
    const S = p.map((q) => M.worldToScreen(v, q.x, q.y));
    c.beginPath(); S.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    if (kind === "area" && S.length > 2) { c.closePath(); c.globalAlpha = 0.18; c.fill(); c.globalAlpha = 1; }
    c.stroke(); for (const q of S) c.fillRect(q.x - 2.5, q.y - 2.5, 5, 5);
    let label = ""; const last = S[S.length - 1];
    if (kind === "dist" && p.length >= 2) label = fmt(M.distance(p[0], p[1]));
    else if (kind === "poly" && p.length >= 2) label = fmt(M.pathLength(p));
    else if (kind === "area" && p.length >= 3) label = fmt(M.polygonArea(p), 2);
    else if (kind === "angle" && p.length >= 3) label = M.angleAt(p[1], p[0], p[2]).toFixed(2) + "°";
    else if (kind === "coord" || kind === "radius") label = "";
    if (label) { c.fillStyle = "#facc15"; c.fillText(label, last.x + 8, last.y - 8); }
  }
  function draw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; const d = dpr(); g.setTransform(d, 0, 0, d, 0, 0); render(g, view, true); }); }

  /* ── view ops ── */
  const pushView = () => { history.push({ ...view }); if (history.length > 50) history.shift(); };
  function zoomExtents() { if (!bounds) return; pushView(); view = M.fitView(bounds, view.w, view.h); draw(); }
  function goTo(x: number, y: number, scale?: number) { pushView(); view = { ...view, cx: x, cy: y, scale: scale ?? view.scale }; draw(); }

  /* ── load ── */
  async function load(file: File): Promise<void> {
    status(`Reading ${file.name}…`);
    try {
      const r = await readCadFile(file);
      doc = r.doc; name = file.name; modelEnts = doc.entities;
      let b: M.BBox | null = null; for (const e of modelEnts) { const eb = M.entityBBox(e); if (Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) b = M.unionBBox(b, eb); }
      if (!b && !doc.layouts?.length) throw new Error("The file has no drawable geometry");
      modelBounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 }; modelIdx = M.buildIndex(modelEnts, modelBounds); layoutIdxCache.clear();
      hidden.clear(); for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);
      markups = []; results = []; layerFilter = ""; $<HTMLInputElement>("lf").value = ""; emptyEl.style.display = "none";
      cmp = null; { const cb = tools2.querySelector("[data-a=compare]"); if (cb) { cb.textContent = "Compare…"; cb.classList.remove("on"); } }
      fillMenus();
      buildTabs(); activate(modelEnts.length ? -1 : 0); setTool("select"); showMeas();
      const sk = doc.skipped && Object.keys(doc.skipped).length ? `  (not drawn: ${Object.entries(doc.skipped).map(([k, n]) => `${k}×${n}`).join(", ")})` : "";
      status(`${r.summary}${sk}`); setTimeout(() => status(""), 5000);
    } catch (err) { status(`Could not open ${file.name}: ${(err as Error).message}`); setTimeout(() => status(""), 7000); }
  }

  /** Switch between model space (-1) and a paper-space layout. */
  function activate(i: number): void {
    if (!doc) return;
    layoutI = i; sel.clear(); selected = -1; pts = []; drawn = []; hits = []; rband = null; history.length = 0;
    if (i < 0 || !doc.layouts?.[i]) { layoutI = -1; ents = modelEnts; idx = modelIdx; bounds = modelBounds; }
    else {
      const L = doc.layouts[i]; ents = L.entities; bounds = M.layoutBounds(L) ?? modelBounds;
      let ix = layoutIdxCache.get(i); if (!ix) { ix = M.buildIndex(ents, bounds!); layoutIdxCache.set(i, ix); } idx = ix;
    }
    view = M.fitView(bounds!, view.w, view.h);
    tabsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.li) === layoutI));
    buildLayers(); showProps(); updateStatus(); draw();
  }
  function buildTabs(): void {
    const n = doc?.layouts?.length ?? 0;
    tabsEl.style.display = n ? "flex" : "none";
    tabsEl.innerHTML = n ? `<button data-li="-1">Model</button>` + doc!.layouts!.map((l, i) => `<button data-li="${i}">${escapeHtml(l.name)}</button>`).join("") : "";
    tabsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.onclick = () => activate(Number(b.dataset.li)));
  }

  function setSel(ids: number[], add = false): void {
    if (!add) sel.clear();
    if (add && ids.length === 1 && sel.has(ids[0])) sel.delete(ids[0]); else for (const i of ids) sel.add(i);
    selected = sel.size ? [...sel][sel.size - 1] : -1; showProps(); draw();
  }
  function zoomToBox(b: M.BBox | null): void { if (!b) return; pushView(); const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6) * 0.08; view = M.fitView({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }, view.w, view.h, 0.02); draw(); }
  function zoomSelection(): void { if (idx && sel.size) zoomToBox(M.bboxOfSet(idx, sel)); }
  function zoomLayer(n: string): void { if (!idx) return; zoomToBox(M.bboxOfSet(idx, ents.map((e, i) => (e.layer === n ? i : -1)).filter((i) => i >= 0))); }

  /* ── layers ── */
  function buildLayers() {
    if (!doc) { layersEl.innerHTML = ""; return; }
    const counts = M.countByLayer(ents);
    const f = layerFilter.toLowerCase();
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])].filter((n) => !f || n.toLowerCase().includes(f)).sort((a, b) => a.localeCompare(b));
    layersEl.innerHTML = names.map((n) => {
      const col = rgbToCss(aciToRgb(layerOf(n)?.color ?? 7, 0xffffff));
      return `<label class="lyr"><input type="checkbox" data-l="${escapeHtml(n)}" ${hidden.has(n) ? "" : "checked"}><span class="sw" style="background:${col}"></span><span data-zl="${escapeHtml(n)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(n)} (double-click to zoom to layer)">${escapeHtml(n)}</span><span style="color:#778">${counts.get(n) ?? 0}</span></label>`;
    }).join("");
    layersEl.querySelectorAll<HTMLElement>("[data-zl]").forEach((el) => el.ondblclick = (ev) => { ev.preventDefault(); zoomLayer(el.dataset.zl!); });
    layersEl.querySelectorAll<HTMLInputElement>("input[data-l]").forEach((i) => i.onchange = () => { i.checked ? hidden.delete(i.dataset.l!) : hidden.add(i.dataset.l!); draw(); });
  }
  const allLayers = () => [...new Set([...(doc?.layers.map((l) => l.name) ?? []), ...ents.map((e) => e.layer)])];
  $<HTMLInputElement>("lf").oninput = (e) => { layerFilter = (e.target as HTMLInputElement).value; buildLayers(); };
  $("lon").onclick = () => { hidden.clear(); buildLayers(); draw(); };
  $("loff").onclick = () => { allLayers().forEach((n) => hidden.add(n)); buildLayers(); draw(); };
  $("liso").onclick = () => { if (!sel.size) return; const keep = new Set([...sel].map((i) => ents[i].layer)); allLayers().forEach((n) => (keep.has(n) ? hidden.delete(n) : hidden.add(n))); buildLayers(); draw(); };

  /* ── properties & measurements ── */
  function showProps() {
    if (sel.size > 1) {
      let len = 0, area = 0; const types = new Map<string, number>(), lay = new Set<string>();
      for (const i of sel) { const e = ents[i], m = M.entityMetrics(e); len += m.length ?? 0; area += m.area ?? 0; types.set(e.type, (types.get(e.type) ?? 0) + 1); lay.add(e.layer); }
      propsEl.innerHTML = `<table>${row("Selected", `${sel.size} objects`)}${[...types].map(([k, n]) => row(k, String(n))).join("")}${row("Layers", String(lay.size))}${row("Total length", fmt(len))}${area ? row("Total area", fmt(area, 2)) : ""}</table>`; return;
    }
    const e = ents[selected];
    if (!e) { propsEl.innerHTML = doc ? `<table>${row("File", name)}${row("Units", doc.units ?? "unitless")}${row("Objects", String(ents.length))}${row("Layers", String(doc.layers.length))}${[...M.countByType(ents)].map(([k, n]) => row(k, String(n))).join("")}</table>` : ""; return; }
    const m = M.entityMetrics(e), rows: string[] = [row("Type", e.type), row("Layer", e.layer), row("Colour", e.rgb != null ? rgbToCss(e.rgb) : e.color ? `ACI ${e.color}` : "ByLayer")];
    rows.push(row("Linetype", e.lineType ?? layerOf(e.layer)?.lineType ?? "ByLayer"));
    if (e.type === "LWPOLYLINE" && e.hatch) rows.push(row("Hatch", e.hatch.solid ? "Solid" : (e.hatch.pattern ?? "Pattern")), row("Loops", String(e.hatch.loops.length)), ...(e.hatch.solid ? [] : [row("Angle", (e.hatch.angle ?? 0).toFixed(2) + "°"), row("Pattern scale", String(+(e.hatch.scale ?? 1).toFixed(4)))]));
    if (e.type === "LINE") rows.push(row("Start", pt(e.start)), row("End", pt(e.end)));
    if (e.type === "CIRCLE" || e.type === "ARC") rows.push(row("Center", pt(e.center)));
    if (e.type === "ARC") rows.push(row("Start angle", e.startAngle.toFixed(2) + "°"), row("End angle", e.endAngle.toFixed(2) + "°"), row("Sweep", m.sweep!.toFixed(2) + "°"));
    if (e.type === "LWPOLYLINE" && !e.hatch) rows.push(row("Vertices", String(e.points.length)), row("Closed", e.closed ? "Yes" : "No"));
    if (e.type === "TEXT") rows.push(row("Text", e.value), row("Height", fmt(e.height)), row("Rotation", (e.rotation ?? 0).toFixed(2) + "°"), row("Position", pt(e.position)));
    if (e.type === "POINT") rows.push(row("Position", pt(e.position)));
    if (m.radius != null) rows.push(row("Radius", fmt(m.radius)), row("Diameter", fmt(m.diameter!)));
    if (m.length != null) rows.push(row("Length", fmt(m.length)));
    if (m.angle != null) rows.push(row("Angle", m.angle.toFixed(2) + "°"));
    if (m.area != null) rows.push(row("Area", fmt(m.area, 2)));
    propsEl.innerHTML = `<table>${rows.join("")}</table>`;
  }
  const row = (k: string, v: string) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
  const pt = (p: { x: number; y: number }) => `${M.convertLength(p.x, doc?.units, du).toFixed(3)}, ${M.convertLength(p.y, doc?.units, du).toFixed(3)}`;
  function showMeas() {
    measEl.innerHTML = results.length ? results.map((r) => `<div>${escapeHtml(r)}</div>`).join("") + `<div style="display:flex;gap:4px;margin-top:6px"><button data-r="mclr">Clear</button><button data-r="mcopy">Copy</button><button data-r="mcsv">CSV</button></div>` : `<span style="color:#778">Wheel zooms, drag pans, click selects. Pick a measure tool, then click points. Enter or double-click finishes, Esc cancels.</span>`;
    const b = measEl.querySelector<HTMLButtonElement>("[data-r=mclr]"); if (b) b.onclick = () => { results = []; drawn = []; showMeas(); draw(); };
    const cp = measEl.querySelector<HTMLButtonElement>("[data-r=mcopy]"); if (cp) cp.onclick = () => { void navigator.clipboard?.writeText(results.join("\n")).then(() => { status("Measurements copied"); setTimeout(() => status(""), 1800); }).catch(() => status("Copy not allowed by the browser")); };
    const cs = measEl.querySelector<HTMLButtonElement>("[data-r=mcsv]"); if (cs) cs.onclick = () => download(new Blob([M.resultsToCsv(results)], { type: "text/csv" }), `${base()}-measurements.csv`);
  }

  /* ── tools ── */
  const T: Array<[Tool, string, string]> = [["pan", "Pan", "P"], ["select", "Select", "S"], ["box", "Box select", "B"], ["zoomwin", "Zoom window", "W"], ["dist", "Distance", "D"], ["poly", "Polyline length", "L"], ["area", "Area", "A"], ["angle", "Angle", "G"], ["coord", "Coordinates", "I"], ["radius", "Radius", "R"], ["redline", "Redline", "M"], ["note", "Note", "N"]];
  function buildBar() {
    tools.innerHTML = `<button data-a="open">Open…</button><input type="file" data-r="file" accept=".dwg,.dxf" style="display:none"><span class="sep"></span>` +
      T.map(([k, l, key]) => `<button data-t="${k}" title="${l} (${key})">${l}</button>`).join("") + `<span class="sep"></span>
      <button data-a="ext" title="Zoom extents (E)">Extents</button><button data-a="zsel" title="Zoom to selection (F)">Selection</button><button data-a="grid" title="Grid (F7)">Grid</button><button data-a="help" title="Shortcuts (?)">?</button><button data-a="in">＋</button><button data-a="out">－</button><button data-a="prev" title="Previous view (Backspace)">Previous</button><span class="sep"></span>
      <button data-a="snap" class="on" title="Object snap (F3)">Snap</button><select data-a="snapset" title="Snap types"><option value="all">All snaps</option>${M.ALL_SNAPS.map((s) => `<option>${s}</option>`).join("")}</select><span class="sep"></span>
      <label>Background <select data-a="bg">${Object.keys(BG).map((k) => `<option>${k}</option>`).join("")}</select></label>
      <label>Colours <select data-a="cm"><option value="layer">As drawn</option><option value="bw">Black / white</option><option value="invert">Inverted</option></select></label>
      <label>Line <select data-a="lw"><option>1</option><option>1.5</option><option>2</option><option>3</option></select></label>
      <label>Units <select data-a="du">${["drawing", "mm", "cm", "m", "in", "ft"].map((u) => `<option>${u}</option>`).join("")}</select></label><span class="sep"></span>
      <input data-r="q" placeholder="Find text…" style="width:130px"><button data-a="qprev">◀</button><button data-a="qnext">▶</button><span data-r="qc" style="color:#9aa4b2"></span><span class="sep"></span>
      <button data-a="png">PNG</button><button data-a="svg">SVG</button><button data-a="clrmk">Clear markup</button>
      <span style="flex:1"></span><button data-a="close">Close ✕</button>`;
    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.onclick = () => setTool(b.dataset.t as Tool));
    const fileIn = tools.querySelector<HTMLInputElement>("[data-r=file]")!;
    fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) void load(f); fileIn.value = ""; };
    const act: Record<string, () => void> = {
      open: () => fileIn.click(), ext: zoomExtents, zsel: zoomSelection, help: () => toggleHelp(),
      grid: () => { showGrid = !showGrid; tools.querySelector("[data-a=grid]")!.classList.toggle("on", showGrid); draw(); }, close: () => api!.close(),
      in: () => { pushView(); view = M.zoomAt(view, view.w / 2, view.h / 2, 1.5); draw(); },
      out: () => { pushView(); view = M.zoomAt(view, view.w / 2, view.h / 2, 1 / 1.5); draw(); },
      prev: () => { const v = history.pop(); if (v) { view = { ...v, w: view.w, h: view.h }; draw(); } },
      snap: () => { snapOn = !snapOn; tools.querySelector("[data-a=snap]")!.classList.toggle("on", snapOn); draw(); },
      png: () => exportPng(), svg: () => exportSvg(),
      clrmk: () => { markups = []; draw(); },
      qprev: () => stepHit(-1), qnext: () => stepHit(1),
    };
    tools.querySelectorAll<HTMLElement>("button[data-a]").forEach((b) => { const f = act[b.dataset.a!]; if (f) b.onclick = f; });
    const sel = (a: string) => tools.querySelector<HTMLSelectElement>(`[data-a=${a}]`)!;
    sel("bg").onchange = (e) => { bg = (e.target as HTMLSelectElement).value; draw(); };
    sel("cm").onchange = (e) => { cmode = (e.target as HTMLSelectElement).value as ColorMode; draw(); };
    sel("lw").onchange = (e) => { lw = Number((e.target as HTMLSelectElement).value); draw(); };
    sel("du").onchange = (e) => { du = (e.target as HTMLSelectElement).value as M.DisplayUnit; showProps(); draw(); };
    sel("snapset").onchange = (e) => { const v = (e.target as HTMLSelectElement).value; snapModes.clear(); (v === "all" ? M.ALL_SNAPS : [v as M.SnapKind]).forEach((s) => snapModes.add(s)); };
    const q = tools.querySelector<HTMLInputElement>("[data-r=q]")!;
    q.oninput = () => { hits = M.searchText(ents, q.value, visible); hitI = -1; tools.querySelector("[data-r=qc]")!.textContent = q.value ? `${hits.length} found` : ""; draw(); };
    q.onkeydown = (e) => { if (e.key === "Enter") { e.stopPropagation(); stepHit(e.shiftKey ? -1 : 1); } };
  }
  function stepHit(d: number) { if (!hits.length) return; hitI = (hitI + d + hits.length) % hits.length; const h = hits[hitI]; goTo(h.x, h.y, Math.max(view.scale, 40 / Math.max(M.textBox(ents[h.index] as any).h, 1e-9))); const el = tools.querySelector("[data-r=qc]")!; el.textContent = `${hitI + 1} / ${hits.length}`; setSel([h.index]); }
  /** Esc: cancel the pick in progress, then leave the active command, then clear the selection. */
  function onEscape(): void {
    if (helpEl) { toggleHelp(); return; }
    if (pts.length || winStart || rband) { pts = []; winStart = winNow = null; rband = null; press = null; draw(); return; }
    if (tool !== "select") { setTool("select"); return; }
    if (sel.size) setSel([]);
  }
  function setTool(t: Tool) { tool = t; cv.focus({ preventScroll: true }); pts = []; winStart = winNow = null; hover = null; tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); cv.style.cursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair"; draw(); }
  function finishMeasure() {
    if (tool === "poly" && pts.length >= 2) { results.push(`Polyline: ${fmt(M.pathLength(pts))}`); drawn.push({ kind: "poly", pts: [...pts] }); }
    else if (tool === "area" && pts.length >= 3) { results.push(`Area: ${fmt(M.polygonArea(pts), 2)}  Perimeter: ${fmt(M.pathLength(pts, true))}`); drawn.push({ kind: "area", pts: [...pts] }); }
    pts = []; showMeas(); draw();
  }

  /* ── input ── */
  const rawPoint = (ev: PointerEvent | MouseEvent): { sp: M.Pt; wp: M.Pt } => { const r = cv.getBoundingClientRect(); const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top }; return { sp, wp: M.screenToWorld(view, sp.x, sp.y) }; };
  const snapped = (wp: M.Pt): M.Snap | null => (!idx || !snapOn || ["pan", "select", "box", "zoomwin", "redline", "note"].includes(tool) && tool !== "redline") ? null : M.findSnap(idx, ents, wp.x, wp.y, 12 / view.scale, [...snapModes], visible);
  cv.addEventListener("pointerdown", (ev) => {
    if (!doc) return; cv.focus(); const { sp, wp } = rawPoint(ev);
    ptrs.set(ev.pointerId, sp);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); dragging = null; press = null; return; }
    if (ev.button === 1 || ev.button === 2) { ev.preventDefault(); dragging = { x: sp.x, y: sp.y }; cv.setPointerCapture(ev.pointerId); cv.style.cursor = "grabbing"; pushView(); return; }
    if (ev.button !== 0) return;
    if (tool === "box" || (tool === "select" && (ev.shiftKey || ev.ctrlKey))) { press = { x: sp.x, y: sp.y, moved: false, id: ev.pointerId, band: true, add: ev.shiftKey || ev.ctrlKey }; cv.setPointerCapture(ev.pointerId); return; }
    if (tool === "pan" || tool === "select") { press = { x: sp.x, y: sp.y, moved: false, id: ev.pointerId }; cv.setPointerCapture(ev.pointerId); return; }
    if (tool === "zoomwin") { winStart = winNow = sp; cv.setPointerCapture(ev.pointerId); return; }
    const s = snapped(wp) ?? { ...wp, kind: "nearest" as M.SnapKind }; const p = { x: s.x, y: s.y };
    switch (tool) {
      case "coord": results.push(`X ${M.convertLength(p.x, doc.units, du).toFixed(3)}  Y ${M.convertLength(p.y, doc.units, du).toFixed(3)} ${M.unitLabel(doc.units, du)}`); drawn.push({ kind: "coord", pts: [p] }); showMeas(); break;
      case "dist": pts.push(p); if (pts.length === 2) { const d = M.distance(pts[0], pts[1]); results.push(`Distance: ${fmt(d)}  ΔX ${fmt(Math.abs(pts[1].x - pts[0].x))}  ΔY ${fmt(Math.abs(pts[1].y - pts[0].y))}  Angle ${M.norm360Deg(pts[0], pts[1]).toFixed(2)}°`); drawn.push({ kind: "dist", pts: [...pts] }); pts = []; showMeas(); } break;
      case "poly": case "area": pts.push(p); break;
      case "angle": pts.push(p); if (pts.length === 3) { results.push(`Angle: ${M.angleAt(pts[1], pts[0], pts[2]).toFixed(2)}°`); drawn.push({ kind: "angle", pts: [...pts] }); pts = []; showMeas(); } break;
      case "radius": { const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1; const e = ents[i]; if (e && (e.type === "CIRCLE" || e.type === "ARC")) { setSel([i]); results.push(`Radius ${fmt(e.radius)}  Diameter ${fmt(e.radius * 2)}`); showProps(); showMeas(); } break; }
      case "redline": if (!pts.length) pts = [wp]; else pts.push(wp); break;
      case "note": { const t = prompt("Note text"); if (t) markups.push({ kind: "note", pts: [wp], text: t }); break; }
    }
    draw();
  });
  cv.addEventListener("pointermove", (ev) => {
    const { sp, wp } = rawPoint(ev);
    if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, sp);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch > 0 && d > 0) { view = M.zoomAt(view, (a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch); draw(); } pinch = d; return; }
    if (press && press.id === ev.pointerId) {
      if (press.band) { if (Math.hypot(sp.x - press.x, sp.y - press.y) > 4) { press.moved = true; rband = { a: { x: press.x, y: press.y }, b: sp }; draw(); } return; }
      if (!press.moved && Math.hypot(sp.x - press.x, sp.y - press.y) > 4) { press.moved = true; pushView(); cv.style.cursor = "grabbing"; dragging = { x: press.x, y: press.y }; }
    }
    if (dragging) { view = M.panBy(view, sp.x - dragging.x, sp.y - dragging.y); dragging = { x: sp.x, y: sp.y }; draw(); updateStatus(wp); return; }
    if (winStart) { winNow = sp; draw(); return; }
    hover = snapped(wp); cursor = hover ? { x: hover.x, y: hover.y } : wp; updateStatus(cursor); if (pts.length || hover || hits.length) draw();
  });
  const endDrag = (ev: PointerEvent) => {
    ptrs.delete(ev.pointerId); if (ptrs.size < 2) pinch = 0;
    if (press && press.id === ev.pointerId) {
      if (press.band && press.moved && rband && idx && ev.type === "pointerup") {
        const a = M.screenToWorld(view, rband.a.x, rband.a.y), b = M.screenToWorld(view, rband.b.x, rband.b.y);
        setSel(M.selectInRect(idx, ents, M.rectOf(a, b), rband.b.x >= rband.a.x ? "window" : "crossing", visible), !!press.add);
      } else if (!press.moved && doc && ev.type === "pointerup") { const { wp } = rawPoint(ev); const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, visible) : -1; if (i >= 0) setSel([i], !!press.add); else if (!press.add) setSel([]); }
      rband = null; draw();
      press = null; cv.style.cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";
    }
    if (dragging) { dragging = null; cv.style.cursor = tool === "pan" ? "grab" : "crosshair"; }
    if (winStart && winNow) { const a = winStart, b = winNow; winStart = winNow = null; if (Math.abs(a.x - b.x) > 6 && Math.abs(a.y - b.y) > 6) { pushView(); view = M.zoomWindow(view, a, b); } draw(); }
    try { cv.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  };
  cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("dblclick", () => { if (tool === "poly" || tool === "area") { pts.pop(); finishMeasure(); } else if (tool === "redline" && pts.length > 1) { markups.push({ kind: "line", pts: [...pts] }); pts = []; draw(); } });
  cv.addEventListener("auxclick", (ev) => { if (ev.button === 1 && ev.detail >= 2) zoomExtents(); });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("wheel", (ev) => { if (!doc) return; ev.preventDefault(); const { sp } = rawPoint(ev); view = M.zoomAt(view, sp.x, sp.y, Math.exp(-Math.max(-300, Math.min(300, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1))) * 0.0018)); draw(); updateStatus(); }, { passive: false });
  cv.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); onEscape(); return; }
    if (ev.key === "F7") { ev.preventDefault(); (tools.querySelector("[data-a=grid]") as HTMLButtonElement).click(); return; }
    if (ev.key === "?" ) { toggleHelp(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a" && doc) { ev.preventDefault(); setSel(ents.map((_, i) => i).filter((i) => visible(ents[i]))); return; }
    if (ev.key === "Enter") { if (tool === "poly" || tool === "area") finishMeasure(); else if (tool === "redline" && pts.length > 1) { markups.push({ kind: "line", pts: [...pts] }); pts = []; draw(); } return; }
    if (ev.key === "F3") { ev.preventDefault(); (tools.querySelector("[data-a=snap]") as HTMLButtonElement).click(); return; }
    if (ev.key === "Backspace" && !pts.length) { ev.preventDefault(); (tools.querySelector("[data-a=prev]") as HTMLButtonElement).click(); return; }
    if (ev.key === "Backspace" && pts.length) { pts.pop(); draw(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const step = ev.shiftKey ? 200 : 60;
    if (ev.key.startsWith("Arrow")) { ev.preventDefault(); view = M.panBy(view, ev.key === "ArrowLeft" ? step : ev.key === "ArrowRight" ? -step : 0, ev.key === "ArrowUp" ? step : ev.key === "ArrowDown" ? -step : 0); draw(); return; }
    if (ev.key === "+" || ev.key === "=") { view = M.zoomAt(view, view.w / 2, view.h / 2, 1.3); draw(); return; }
    if (ev.key === "-" || ev.key === "_") { view = M.zoomAt(view, view.w / 2, view.h / 2, 1 / 1.3); draw(); return; }
    const k = ev.key.toLowerCase();
    if (k === "e") zoomExtents(); else if (k === "f") zoomSelection(); else { const t = T.find(([, , key]) => key.toLowerCase() === k); if (t) setTool(t[0]); }
  });
  function updateStatus(p?: M.Pt) {
    const c = p ?? cursor; const zoomPct = doc && bounds ? Math.round((view.scale / M.fitView(bounds, view.w, view.h).scale) * 100) : 100;
    statusEl.innerHTML = `<span>${escapeHtml(name || "No file")}</span><span>${c && doc ? `X ${M.convertLength(c.x, doc.units, du).toFixed(3)}  Y ${M.convertLength(c.y, doc.units, du).toFixed(3)}` : ""}</span><span>${escapeHtml(layoutI >= 0 && doc?.layouts?.[layoutI] ? doc.layouts[layoutI].name : "Model")}</span><span>Units: ${escapeHtml(doc ? M.unitLabel(doc.units, du) : "-")}</span><span>Zoom ${zoomPct}%</span><span>Tool: ${escapeHtml(T.find(([k]) => k === tool)?.[1] ?? tool)}</span><span style="flex:1"></span><span>Snap ${snapOn ? "on" : "off"}</span>`;
  }

  /* ── drop ── */
  const stage = $("stage");
  stage.addEventListener("dragover", (e) => { e.preventDefault(); });
  stage.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void load(f); });

  let helpEl: HTMLDivElement | null = null;
  function closeOverlay(): void { helpEl?.remove(); helpEl = null; cv.focus({ preventScroll: true }); }
  function openOverlay(html: string): HTMLDivElement {
    helpEl?.remove();
    const el = document.createElement("div"); helpEl = el;
    el.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:5";
    el.innerHTML = `<div data-r="panel" style="background:#151a23;border:1px solid #2f3846;border-radius:10px;padding:16px 22px;max-width:620px;max-height:90%;overflow:auto;line-height:1.7">${html}</div>`;
    el.onclick = (ev) => { if (ev.target === el) closeOverlay(); };
    stage.appendChild(el); return el;
  }
  function toggleHelp(): void {
    if (helpEl) { closeOverlay(); return; }
    openOverlay(`<b style="font-size:14px">Mouse & keyboard</b><br>
      Wheel: zoom at cursor · Drag: pan · Middle / right drag: pan · Middle double-click: extents<br>
      Click: select · Shift/Ctrl+click: add or remove · Shift+drag or <b>B</b>: box select (→ window, ← crossing) · Ctrl+A: select all<br>
      P pan · S select · W zoom window · D distance · L polyline · A area · G angle · I coordinate · R radius · M redline · N note<br>
      E extents · F zoom to selection · F3 snaps · F7 grid · Backspace previous view · Arrows pan · + / − zoom<br>
      Esc: cancel the pick, then leave the command, then clear the selection · Ctrl+C: copy the view as an image<br>
      Double-click a layer name: zoom to that layer<br><span style="color:#9aa4b2">Press ? or Esc to close.</span>`);
  }

  /* ── saved views, layer states ── */
  const storeKey = () => `obs.cadviewer.v1.${name}`;
  type Saved = { views: Array<{ n: string; cx: number; cy: number; s: number }>; states: Array<{ n: string; hidden: string[] }> };
  function loadSaved(): Saved { try { const r = localStorage.getItem(storeKey()); if (r) { const j = JSON.parse(r); return { views: Array.isArray(j.views) ? j.views : [], states: Array.isArray(j.states) ? j.states : [] }; } } catch { /* storage unavailable */ } return { views: [], states: [] }; }
  function persist(sv: Saved): void { try { localStorage.setItem(storeKey(), JSON.stringify(sv)); } catch { /* storage unavailable */ } }
  function fillMenus(): void {
    const sv = doc ? loadSaved() : { views: [], states: [] };
    const opts = (head: string, names: string[]) => `<option value="">${head}</option>${names.map((n) => `<option value="go:${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}<option value="save:">＋ Save current…</option>${names.map((n) => `<option value="del:${escapeHtml(n)}">✕ Delete ${escapeHtml(n)}</option>`).join("")}`;
    const v = tools2.querySelector<HTMLSelectElement>("[data-a=views]"), l = tools2.querySelector<HTMLSelectElement>("[data-a=lstates]");
    if (v) v.innerHTML = opts("Named views", sv.views.map((x) => x.n));
    if (l) l.innerHTML = opts("Layer states", sv.states.map((x) => x.n));
  }
  function menuAction(kind: "views" | "states", value: string): void {
    if (!doc || !value) return; const sv = loadSaved(); const i = value.indexOf(":"), op = value.slice(0, i), nm = value.slice(i + 1);
    const list = kind === "views" ? sv.views : sv.states;
    if (op === "save") {
      const n = prompt(kind === "views" ? "Name for this view" : "Name for this layer state")?.trim(); if (!n) return;
      const at = list.findIndex((x) => x.n === n); if (at >= 0) list.splice(at, 1);
      if (kind === "views") sv.views.push({ n, cx: view.cx, cy: view.cy, s: view.scale }); else sv.states.push({ n, hidden: [...hidden] });
      persist(sv);
    } else if (op === "del") { const at = list.findIndex((x) => x.n === nm); if (at >= 0) list.splice(at, 1); persist(sv); }
    else if (op === "go") {
      if (kind === "views") { const x = sv.views.find((q) => q.n === nm); if (x) { pushView(); view = { ...view, cx: x.cx, cy: x.cy, scale: x.s }; draw(); } }
      else { const x = sv.states.find((q) => q.n === nm); if (x) { hidden.clear(); x.hidden.forEach((h) => hidden.add(h)); buildLayers(); draw(); } }
    }
    fillMenus();
  }

  /* ── quick measure tooltip ── */
  function quickTip(sx: number, sy: number, wp: M.Pt): void {
    if (!quick || !doc || !idx) { if (tipEl) tipEl.style.display = "none"; return; }
    const i = M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, shown);
    if (i < 0) { if (tipEl) tipEl.style.display = "none"; return; }
    const parts = M.quickMeasureParts(ents[i]);
    if (!parts.length) { if (tipEl) tipEl.style.display = "none"; return; }
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.style.cssText = "position:absolute;pointer-events:none;background:#0b0e14;border:1px solid #38bdf8;border-radius:5px;padding:3px 7px;font-size:11px;white-space:nowrap;z-index:4"; stage.appendChild(tipEl); }
    tipEl.innerHTML = parts.map((q) => `${escapeHtml(q.label)} ${q.power === 0 ? q.value.toFixed(2) + "°" : escapeHtml(fmt(q.value, q.power))}`).join(" · ");
    tipEl.style.left = `${sx + 14}px`; tipEl.style.top = `${sy + 14}px`; tipEl.style.display = "block";
  }

  /* ── drawing info ── */
  function showInfo(): void {
    if (!doc) return;
    const types = [...M.countByType(modelEnts)].map(([k, n]) => `${escapeHtml(k)} ${n}`).join(" · ");
    const b = modelBounds, w = b ? b.maxX - b.minX : 0, h = b ? b.maxY - b.minY : 0;
    const lts = doc.linetypes ? Object.keys(doc.linetypes).join(", ") : "none defined";
    const sk = doc.skipped ? Object.entries(doc.skipped).map(([k, n]) => `${escapeHtml(k)}×${n}`).join(", ") : "none";
    const rows: Array<[string, string]> = [
      ["File", escapeHtml(name)], ["Format", escapeHtml((doc.sourceFormat ?? "").toUpperCase())], ["Units", escapeHtml(doc.units ?? "unitless")],
      ["Extents", b ? `${fmt(w)} × ${fmt(h)}` : "empty"], ["Model objects", String(modelEnts.length)], ["Object types", types || "none"],
      ["Layers", String(doc.layers.length)], ["Layouts", doc.layouts?.length ? doc.layouts.map((l) => `${escapeHtml(l.name)} (${l.entities.length} objects, ${l.viewports.length} viewports)`).join("<br>") : "none"],
      ["Linetypes", escapeHtml(lts)], ["Linetype scale", String(doc.ltscale ?? 1)], ["Not drawn", sk],
    ];
    openOverlay(`<b style="font-size:14px">Drawing information</b><table style="margin-top:6px">${rows.map(([k, v]) => `<tr><td style="vertical-align:top;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join("")}</table><div style="color:#9aa4b2;margin-top:6px">Press Esc to close.</div>`);
  }

  /* ── compare ── */
  async function runCompare(file: File): Promise<void> {
    if (!doc || !modelBounds) return; status(`Reading ${file.name}…`);
    try {
      const r = await readCadFile(file);
      const d = M.diffEntities(modelEnts, r.doc.entities, M.compareTolerance(modelBounds));
      cmp = { removed: new Set(d.removed.map((i) => modelEnts[i])), added: d.added.map((i) => r.doc.entities[i]) };
      if (layoutI >= 0) activate(-1); else draw();
      tools2.querySelector("[data-a=compare]")!.textContent = "Clear compare"; tools2.querySelector("[data-a=compare]")!.classList.add("on");
      const unitNote = (r.doc.units ?? "unitless") !== (doc.units ?? "unitless") ? "  ⚠ different units" : "";
      status(`Compared with ${file.name}: ${d.added.length} added, ${d.removed.length} removed, ${d.same} unchanged${unitNote}`); setTimeout(() => status(""), 9000);
    } catch (err) { status(`Could not compare: ${(err as Error).message}`); setTimeout(() => status(""), 6000); }
  }
  function clearCompare(): void { cmp = null; const b = tools2.querySelector("[data-a=compare]"); if (b) { b.textContent = "Compare…"; b.classList.remove("on"); } draw(); }

  /* ── plot ── */
  function openPlot(): void {
    if (!doc) return;
    const el = openOverlay(`<b style="font-size:14px">Plot</b>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin-top:8px;align-items:center">
        <label>Paper</label><select data-p="paper">${Object.keys(M.PAPER_MM).map((k) => `<option ${k === "A3" ? "selected" : ""}>${k}</option>`).join("")}</select>
        <label>Orientation</label><select data-p="ori"><option value="l">Landscape</option><option value="p">Portrait</option></select>
        <label>Plot area</label><select data-p="area"><option value="display">Display (what you see)</option><option value="extents">Extents</option></select>
        <label>Colours</label><select data-p="mono"><option value="1">Monochrome (black on white)</option><option value="0">As drawn on white</option></select>
        <label>Title</label><input data-p="title" placeholder="Optional" value="${escapeHtml(name)}">
      </div>
      <div style="display:flex;gap:8px;margin-top:12px"><button data-p="go">Plot / save as PDF</button><button data-p="cancel">Cancel</button></div>
      <div style="color:#9aa4b2;margin-top:6px">Fits the plot area to the sheet. In the print dialog choose “Save as PDF” to get a file.</div>`);
    const g = (k: string) => el.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-p=${k}]`)!;
    g("cancel").onclick = closeOverlay;
    g("go").onclick = () => { const o = { paper: g("paper").value, land: g("ori").value === "l", area: g("area").value, mono: g("mono").value === "1", title: g("title").value }; closeOverlay(); doPlot(o); };
  }
  function doPlot(o: { paper: string; land: boolean; area: string; mono: boolean; title: string }): void {
    if (!doc) return;
    const pg = M.paperMm(o.paper, o.land), px = M.plotPixels(pg.w, pg.h, 8, 150);
    const box = o.area === "extents" ? (bounds ?? modelBounds!) : visibleBox(view);
    const pv = M.fitView(box, px.w, px.h, 0.02);
    const c = document.createElement("canvas"); c.width = px.w; c.height = px.h; const x = c.getContext("2d")!;
    const keep = { bg, cmode, lw }; bg = "white"; cmode = o.mono ? "bw" : "layer"; lw = Math.max(lw, px.w / 1200);
    try { render(x, pv, false); } finally { bg = keep.bg; cmode = keep.cmode; lw = keep.lw; }
    const url = c.toDataURL("image/png");
    const w = window.open("", "_blank"); if (!w) { status("Allow pop-ups to plot"); setTimeout(() => status(""), 4000); return; }
    w.document.write(`<!doctype html><title>${escapeHtml(o.title || name)}</title><style>@page{size:${o.paper} ${o.land ? "landscape" : "portrait"};margin:8mm}html,body{margin:0}img{width:100%;display:block}.t{font:11px sans-serif;margin-top:2mm}</style><img src="${url}">${o.title ? `<div class="t">${escapeHtml(o.title)}</div>` : ""}`);
    w.document.close(); w.onload = () => w.print();
  }
  async function copyImage(): Promise<void> {
    if (!doc) return;
    try { const blob = await new Promise<Blob | null>((res) => offscreen(2).toBlob(res, "image/png")); if (!blob) throw new Error("no image"); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); status("View copied as an image"); }
    catch { status("Copy blocked by the browser; use PNG instead"); }
    setTimeout(() => status(""), 2500);
  }

  /* ── export ── */
  const base = () => (name || "drawing").replace(/\.[^.]+$/, "");
  const download = (blob: Blob, fn: string) => { const a = document.createElement("a"); const u = URL.createObjectURL(blob); a.href = u; a.download = fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  function offscreen(scale: number): HTMLCanvasElement { const c = document.createElement("canvas"); c.width = Math.round(view.w * scale); c.height = Math.round(view.h * scale); const x = c.getContext("2d")!; x.scale(scale, scale); render(x, view, false); return c; }
  function exportPng() { if (!doc) return; offscreen(2).toBlob((b) => b && download(b, `${base()}.png`), "image/png"); }
  /** SVG markup for a list of entities seen through view `v` (pixel space). */
  function svgEntities(list: DxfEntity[], ix: M.SpatialIndex | null, v: M.View, cull: M.BBox, o: string[], uid: { n: number }): void {
    const F = (n: number) => n.toFixed(2);
    const P = (x: number, y: number) => { const q = M.worldToScreen(v, x, y); return `${F(q.x)},${F(q.y)}`; };
    for (let i = 0; i < list.length; i++) {
      const e = list[i]; if (!shown(e)) continue;
      if (ix && !M.boxesIntersect(ix.boxes[i], cull)) continue;
      const col = colorOf(e), dash = dashFor(e, v), da = dash.length ? ` stroke-dasharray="${dash.map(F).join(" ")}"` : "";
      const st = `stroke="${col}" fill="none" stroke-width="${lw}"${da}`;
      if (e.type === "LINE") { const a = M.worldToScreen(v, e.start.x, e.start.y), b = M.worldToScreen(v, e.end.x, e.end.y); o.push(`<line x1="${F(a.x)}" y1="${F(a.y)}" x2="${F(b.x)}" y2="${F(b.y)}" ${st}/>`); }
      else if (e.type === "CIRCLE") { const c = M.worldToScreen(v, e.center.x, e.center.y); o.push(`<circle cx="${F(c.x)}" cy="${F(c.y)}" r="${F(e.radius * v.scale)}" ${st}/>`); }
      else if (e.type === "ARC") { const r = e.radius * v.scale, s0 = e.startAngle * Math.PI / 180, en = e.endAngle * Math.PI / 180; const a = M.worldToScreen(v, e.center.x + e.radius * Math.cos(s0), e.center.y + e.radius * Math.sin(s0)), b = M.worldToScreen(v, e.center.x + e.radius * Math.cos(en), e.center.y + e.radius * Math.sin(en)); o.push(`<path d="M${F(a.x)},${F(a.y)} A${F(r)},${F(r)} 0 ${M.arcSweepDeg(e.startAngle, e.endAngle) > 180 ? 1 : 0} 0 ${F(b.x)},${F(b.y)}" ${st}/>`); }
      else if (e.type === "LWPOLYLINE" && e.hatch) {
        const d = e.hatch.loops.map((l) => "M" + l.map((q) => P(q.x, q.y)).join(" L") + "Z").join(" ");
        const fams = e.hatch.solid ? [] : M.hatchFamilies(e.hatch.pattern, e.hatch.angle, e.hatch.scale);
        if (e.hatch.solid || Math.min(...fams.map((f) => f.spacing)) * v.scale < 3) o.push(`<path d="${d}" fill="${col}" fill-opacity="${e.hatch.solid ? 1 : 0.35}" fill-rule="evenodd" stroke="none"/>`);
        else {
          const id = `h${uid.n++}`, vb = visibleBox(v), eb = M.entityBBox(e);
          const box = { minX: Math.max(vb.minX, eb.minX), minY: Math.max(vb.minY, eb.minY), maxX: Math.min(vb.maxX, eb.maxX), maxY: Math.min(vb.maxY, eb.maxY) };
          let ls = ""; for (const f of fams) for (const sg of M.hatchLineSegments(box, f.angle, f.spacing)) { const a = M.worldToScreen(v, sg[0], sg[1]), b = M.worldToScreen(v, sg[2], sg[3]); ls += `M${F(a.x)},${F(a.y)}L${F(b.x)},${F(b.y)}`; }
          o.push(`<clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath><path d="${ls}" clip-path="url(#${id})" stroke="${col}" fill="none" stroke-width="${Math.max(0.6, lw * 0.6)}"/>`);
        }
      }
      else if (e.type === "LWPOLYLINE") o.push(`<${e.closed ? "polygon" : "polyline"} points="${e.points.map((q) => P(q.x, q.y)).join(" ")}" ${st}/>`);
      else if (e.type === "TEXT") {
        const p = M.worldToScreen(v, e.position.x, e.position.y);
        const anchor = e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
        const base = e.valign === "top" ? "hanging" : e.valign === "middle" ? "central" : e.valign === "bottom" ? "text-after-edge" : "alphabetic";
        o.push(`<text x="${F(p.x)}" y="${F(p.y)}" font-size="${F(e.height * v.scale)}" fill="${col}" text-anchor="${anchor}" dominant-baseline="${base}" transform="rotate(${-(e.rotation ?? 0)} ${F(p.x)} ${F(p.y)})" font-family="sans-serif">${escapeHtml(e.value)}</text>`);
      }
      else if (e.type === "POINT") { const p = M.worldToScreen(v, e.position.x, e.position.y); o.push(`<circle cx="${F(p.x)}" cy="${F(p.y)}" r="1.5" fill="${col}"/>`); }
    }
  }
  function exportSvg() {
    if (!doc) return; const v = view, o: string[] = [], uid = { n: 0 };
    svgEntities(ents, idx, v, visibleBox(v), o, uid);
    if (layoutI >= 0 && doc.layouts?.[layoutI]) {
      for (const vp of doc.layouts[layoutI].viewports) {
        const r = M.viewportRect(vp), a = M.worldToScreen(v, r.minX, r.maxY), b = M.worldToScreen(v, r.maxX, r.minY), ctr = M.worldToScreen(v, vp.center.x, vp.center.y), sc = M.viewportScale(vp);
        const id = `vp${uid.n++}`, vv: M.View = { cx: vp.viewCenter.x, cy: vp.viewCenter.y, scale: v.scale * sc, w: ctr.x * 2, h: ctr.y * 2 }, rad = Math.hypot(vp.width, vp.height) / 2 / sc;
        o.push(`<clipPath id="${id}"><rect x="${a.x.toFixed(2)}" y="${a.y.toFixed(2)}" width="${(b.x - a.x).toFixed(2)}" height="${(b.y - a.y).toFixed(2)}"/></clipPath><g clip-path="url(#${id})"><g transform="rotate(${vp.twist ?? 0} ${ctr.x.toFixed(2)} ${ctr.y.toFixed(2)})">`);
        svgEntities(modelEnts, modelIdx, vv, { minX: vp.viewCenter.x - rad, maxX: vp.viewCenter.x + rad, minY: vp.viewCenter.y - rad, maxY: vp.viewCenter.y + rad }, o, uid);
        o.push("</g></g>");
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${v.w}" height="${v.h}" viewBox="0 0 ${v.w} ${v.h}"><rect width="100%" height="100%" fill="${BG[bg]}"/>${o.join("")}</svg>`;
    download(new Blob([svg], { type: "image/svg+xml" }), `${base()}${layoutI >= 0 ? "-" + (doc.layouts?.[layoutI]?.name ?? "layout") : ""}.svg`);
  }
  function doPrint() {
    if (!doc) return; const url = offscreen(2).toDataURL("image/png");
    const w = window.open("", "_blank"); if (!w) { status("Allow pop-ups to print"); setTimeout(() => status(""), 4000); return; }
    w.document.write(`<!doctype html><title>${escapeHtml(name)}</title><style>@page{margin:8mm}body{margin:0}img{width:100%}</style><img src="${url}">`); w.document.close(); w.onload = () => w.print();
  }

  function buildBar2() {
    tools2.innerHTML = `<select data-a="views" title="Named views"></select><select data-a="lstates" title="Layer states"></select><span class="sep"></span>
      <button data-a="quick" title="Quick measure: hover an object to read its size">Quick measure</button>
      <button data-a="compare" title="Highlight differences against another DWG/DXF">Compare…</button><input type="file" data-r="cmpfile" accept=".dwg,.dxf" style="display:none"><span class="sep"></span>
      <button data-a="tText" class="on" title="Show or hide text">Text</button><button data-a="tHatch" class="on" title="Show or hide hatches">Hatch</button><button data-a="tLt" class="on" title="Show or hide linetypes">Linetypes</button><span class="sep"></span>
      <button data-a="info" title="Drawing information">Info</button><button data-a="copy" title="Copy the view as an image (Ctrl+C)">Copy image</button><button data-a="plot" title="Plot to a sheet / PDF">Plot…</button><button data-a="full" title="Full screen">Full screen</button>`;
    const q = <T extends HTMLElement>(a: string) => tools2.querySelector<T>(`[data-a=${a}]`)!;
    const flip = (a: string, on: boolean) => q(a).classList.toggle("on", on);
    q("tText").onclick = () => { showText = !showText; flip("tText", showText); draw(); };
    q("tHatch").onclick = () => { showHatch = !showHatch; flip("tHatch", showHatch); draw(); };
    q("tLt").onclick = () => { showLt = !showLt; flip("tLt", showLt); draw(); };
    q("quick").onclick = () => { quick = !quick; flip("quick", quick); if (!quick && tipEl) tipEl.style.display = "none"; };
    q("info").onclick = showInfo; q("copy").onclick = () => void copyImage(); q("plot").onclick = openPlot;
    q("full").onclick = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void root!.requestFullscreen?.(); };
    const cf = tools2.querySelector<HTMLInputElement>("[data-r=cmpfile]")!;
    q("compare").onclick = () => { if (cmp) clearCompare(); else if (doc) cf.click(); };
    cf.onchange = () => { const f = cf.files?.[0]; if (f) void runCompare(f); cf.value = ""; };
    q<HTMLSelectElement>("views").onchange = (e) => { const sel2 = e.target as HTMLSelectElement; menuAction("views", sel2.value); sel2.value = ""; };
    q<HTMLSelectElement>("lstates").onchange = (e) => { const sel2 = e.target as HTMLSelectElement; menuAction("states", sel2.value); sel2.value = ""; };
    fillMenus();
  }
  buildBar(); buildBar2(); setTool("select"); showProps(); showMeas(); updateStatus(); resize();
  api = {
    load,
    close() { root!.style.display = "none"; },
  };
  // Esc works wherever the focus is (toolbar button, layer list...), not only on the canvas.
  window.addEventListener("keydown", (e) => {
    if (root!.style.display === "none" || e.key !== "Escape" || e.target === cv) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT") && (t as HTMLInputElement).type !== "checkbox") { (t as HTMLInputElement).blur(); }
    e.preventDefault(); e.stopPropagation(); onEscape(); cv.focus({ preventScroll: true });
  }, true);
}
