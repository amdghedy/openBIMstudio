/**
 * CAD Viewer – a standalone 2D DWG/DXF viewer (DWG TrueView style) inside the app.
 * Pure geometry lives in modules/cad-viewer/viewer-math.ts; this file is canvas rendering + UI only.
 */
import { readCadFile } from "../modules/cad-link/index";
import { aciToRgb, rgbToCss } from "../modules/drawings/aci";
import type { DxfDocument, DxfEntity } from "../modules/drawings/dxf-types";
import { escapeHtml } from "../core/html-escape";
import * as M from "../modules/cad-viewer/viewer-math";

type Tool = "pan" | "select" | "dist" | "poly" | "area" | "angle" | "coord" | "radius" | "zoomwin" | "redline" | "note";
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
  root.id = "obs-cad-viewer";
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
  <div style="display:flex;flex:1;min-height:0">
    <div style="flex:1;position:relative;min-width:0" data-r="stage">
      <canvas data-r="cv" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none" tabindex="0"></canvas>
      <div data-r="empty" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9aa4b2;pointer-events:none">
        <div style="font-size:18px">Drop a DWG or DXF file here</div><div>or use Open</div></div>
      <div data-r="busy" style="display:none;position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#1b212c;padding:6px 12px;border-radius:6px"></div>
    </div>
    <div class="side">
      <h4>Layers</h4>
      <div style="display:flex;gap:4px;padding:6px 8px"><button data-r="lon">All on</button><button data-r="loff">All off</button><button data-r="liso" title="Isolate the selected object's layer">Isolate</button></div>
      <div class="sc" data-r="layers" style="flex:1"></div>
      <h4>Properties</h4><div class="sc" data-r="props" style="max-height:34%;padding-bottom:4px"></div>
      <h4>Measurements</h4><div class="sc" data-r="meas" style="max-height:24%;padding:4px 8px"></div>
    </div>
  </div>
  <div data-r="status" style="display:flex;gap:16px;padding:4px 10px;background:#151a23;border-top:1px solid #2a3140;color:#9aa4b2;font-variant-numeric:tabular-nums"></div>`;
  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(k: string) => root!.querySelector(`[data-r="${k}"]`) as T;
  const cv = $<HTMLCanvasElement>("cv"), g = cv.getContext("2d")!;
  const tools = $("tools"), layersEl = $("layers"), propsEl = $("props"), measEl = $("meas"), statusEl = $("status"), emptyEl = $("empty"), busyEl = $("busy");

  let doc: DxfDocument | null = null, name = "";
  let ents: DxfEntity[] = [], idx: M.SpatialIndex | null = null, bounds: M.BBox | null = null;
  let view: M.View = { cx: 0, cy: 0, scale: 1, w: 800, h: 600 };
  const history: M.View[] = [];
  let tool: Tool = "pan";
  let bg = "black", cmode: ColorMode = "layer", lw = 1, du: M.DisplayUnit = "drawing";
  const hidden = new Set<string>();
  let snapOn = true; const snapModes = new Set<M.SnapKind>(M.ALL_SNAPS);
  let selected = -1, hover: M.Snap | null = null, cursor: M.Pt | null = null;
  let pts: M.Pt[] = []; let results: string[] = []; let drawn: Array<{ kind: Tool; pts: M.Pt[] }> = [];
  let markups: Markup[] = []; let hits: M.TextHit[] = [], hitI = -1;
  let dragging: { x: number; y: number } | null = null, winStart: { x: number; y: number } | null = null, winNow: { x: number; y: number } | null = null;
  let raf = 0;

  const inv = () => cmode === "invert";
  const fg = () => (bg === "white" || inv() ? 0x000000 : 0xffffff);
  const visible = (e: DxfEntity) => !hidden.has(e.layer);
  const layerOf = (n: string) => doc?.layers.find((l) => l.name === n);
  function colorOf(e: DxfEntity): string {
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
      case "LWPOLYLINE": { e.points.forEach((q, i) => { const p = P(q.x, q.y); i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); }); if (e.closed) c.closePath(); c.stroke(); break; }
      case "POINT": { const p = P(e.position.x, e.position.y); c.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); break; }
      case "TEXT": {
        const px = e.height * v.scale; if (px < 3) { const p = P(e.position.x, e.position.y); const w = M.textBox(e).w * v.scale; c.moveTo(p.x, p.y); c.lineTo(p.x + w, p.y); c.stroke(); break; }
        const p = P(e.position.x, e.position.y); c.save(); c.translate(p.x, p.y); c.rotate(-(e.rotation ?? 0) * Math.PI / 180);
        c.font = `${Math.min(px, 600)}px sans-serif`; c.textBaseline = "alphabetic"; c.fillText(e.value, 0, 0); c.restore(); break;
      }
    }
  }
  function render(c: CanvasRenderingContext2D, v: M.View, withUi: boolean): void {
    c.save(); c.fillStyle = BG[bg]; c.fillRect(0, 0, v.w, v.h);
    if (!doc) { c.restore(); return; }
    c.lineWidth = lw; c.lineJoin = "round";
    ents.forEach((e, i) => {
      if (!visible(e) || i === selected) return;
      if (idx && !M.bboxVisible(idx.boxes[i], v)) return;
      const col = colorOf(e); c.strokeStyle = col; c.fillStyle = col; drawEntity(c, e, v);
    });
    if (selected >= 0 && ents[selected]) { c.save(); c.lineWidth = lw + 2; c.strokeStyle = "#38bdf8"; c.fillStyle = "#38bdf8"; drawEntity(c, ents[selected], v); c.restore(); }
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
      if (winStart && winNow) { c.strokeStyle = "#38bdf8"; c.setLineDash([5, 4]); c.strokeRect(winStart.x, winStart.y, winNow.x - winStart.x, winNow.y - winStart.y); }
    }
    c.restore();
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
      doc = r.doc; name = file.name; ents = doc.entities;
      let b: M.BBox | null = null; for (const e of ents) { const eb = M.entityBBox(e); if (Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) b = M.unionBBox(b, eb); }
      if (!b) throw new Error("The file has no drawable geometry");
      bounds = b; idx = M.buildIndex(ents, b);
      hidden.clear(); for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);
      selected = -1; pts = []; drawn = []; markups = []; hits = []; results = []; history.length = 0;
      emptyEl.style.display = "none"; view = M.fitView(b, view.w, view.h);
      buildLayers(); showProps(); showMeas(); setTool("pan"); updateStatus(); draw();
      const sk = doc.skipped && Object.keys(doc.skipped).length ? `  (not drawn: ${Object.entries(doc.skipped).map(([k, n]) => `${k}×${n}`).join(", ")})` : "";
      status(`${r.summary}${sk}`); setTimeout(() => status(""), 5000);
    } catch (err) { status(`Could not open ${file.name}: ${(err as Error).message}`); setTimeout(() => status(""), 7000); }
  }

  /* ── layers ── */
  function buildLayers() {
    if (!doc) { layersEl.innerHTML = ""; return; }
    const counts = M.countByLayer(ents);
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])].sort((a, b) => a.localeCompare(b));
    layersEl.innerHTML = names.map((n) => {
      const col = rgbToCss(aciToRgb(layerOf(n)?.color ?? 7, 0xffffff));
      return `<label class="lyr"><input type="checkbox" data-l="${escapeHtml(n)}" ${hidden.has(n) ? "" : "checked"}><span class="sw" style="background:${col}"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(n)}">${escapeHtml(n)}</span><span style="color:#778">${counts.get(n) ?? 0}</span></label>`;
    }).join("");
    layersEl.querySelectorAll<HTMLInputElement>("input[data-l]").forEach((i) => i.onchange = () => { i.checked ? hidden.delete(i.dataset.l!) : hidden.add(i.dataset.l!); draw(); });
  }
  const allLayers = () => [...new Set([...(doc?.layers.map((l) => l.name) ?? []), ...ents.map((e) => e.layer)])];
  $("lon").onclick = () => { hidden.clear(); buildLayers(); draw(); };
  $("loff").onclick = () => { allLayers().forEach((n) => hidden.add(n)); buildLayers(); draw(); };
  $("liso").onclick = () => { if (selected < 0) return; const keep = ents[selected].layer; allLayers().forEach((n) => (n === keep ? hidden.delete(n) : hidden.add(n))); buildLayers(); draw(); };

  /* ── properties & measurements ── */
  function showProps() {
    const e = ents[selected];
    if (!e) { propsEl.innerHTML = doc ? `<table>${row("File", name)}${row("Units", doc.units ?? "unitless")}${row("Objects", String(ents.length))}${row("Layers", String(doc.layers.length))}${[...M.countByType(ents)].map(([k, n]) => row(k, String(n))).join("")}</table>` : ""; return; }
    const m = M.entityMetrics(e), rows: string[] = [row("Type", e.type), row("Layer", e.layer), row("Colour", e.rgb != null ? rgbToCss(e.rgb) : e.color ? `ACI ${e.color}` : "ByLayer")];
    if (e.type === "LINE") rows.push(row("Start", pt(e.start)), row("End", pt(e.end)));
    if (e.type === "CIRCLE" || e.type === "ARC") rows.push(row("Center", pt(e.center)));
    if (e.type === "ARC") rows.push(row("Start angle", e.startAngle.toFixed(2) + "°"), row("End angle", e.endAngle.toFixed(2) + "°"), row("Sweep", m.sweep!.toFixed(2) + "°"));
    if (e.type === "LWPOLYLINE") rows.push(row("Vertices", String(e.points.length)), row("Closed", e.closed ? "Yes" : "No"));
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
    measEl.innerHTML = results.length ? results.map((r) => `<div>${escapeHtml(r)}</div>`).join("") + `<button data-r="mclr" style="margin-top:6px">Clear</button>` : `<span style="color:#778">Pick a measure tool, then click points. Enter or double-click finishes, Esc cancels.</span>`;
    const b = measEl.querySelector<HTMLButtonElement>("[data-r=mclr]"); if (b) b.onclick = () => { results = []; drawn = []; showMeas(); draw(); };
  }

  /* ── tools ── */
  const T: Array<[Tool, string, string]> = [["pan", "Pan", "P"], ["select", "Select", "S"], ["zoomwin", "Zoom window", "W"], ["dist", "Distance", "D"], ["poly", "Polyline length", "L"], ["area", "Area", "A"], ["angle", "Angle", "G"], ["coord", "Coordinates", "I"], ["radius", "Radius", "R"], ["redline", "Redline", "M"], ["note", "Note", "N"]];
  function buildBar() {
    tools.innerHTML = `<button data-a="open">Open…</button><input type="file" data-r="file" accept=".dwg,.dxf" style="display:none"><span class="sep"></span>` +
      T.map(([k, l, key]) => `<button data-t="${k}" title="${l} (${key})">${l}</button>`).join("") + `<span class="sep"></span>
      <button data-a="ext" title="Zoom extents (E)">Extents</button><button data-a="in">＋</button><button data-a="out">－</button><button data-a="prev" title="Previous view (Backspace)">Previous</button><span class="sep"></span>
      <button data-a="snap" class="on" title="Object snap (F3)">Snap</button><select data-a="snapset" title="Snap types"><option value="all">All snaps</option>${M.ALL_SNAPS.map((s) => `<option>${s}</option>`).join("")}</select><span class="sep"></span>
      <label>Background <select data-a="bg">${Object.keys(BG).map((k) => `<option>${k}</option>`).join("")}</select></label>
      <label>Colours <select data-a="cm"><option value="layer">As drawn</option><option value="bw">Black / white</option><option value="invert">Inverted</option></select></label>
      <label>Line <select data-a="lw"><option>1</option><option>1.5</option><option>2</option><option>3</option></select></label>
      <label>Units <select data-a="du">${["drawing", "mm", "cm", "m", "in", "ft"].map((u) => `<option>${u}</option>`).join("")}</select></label><span class="sep"></span>
      <input data-r="q" placeholder="Find text…" style="width:130px"><button data-a="qprev">◀</button><button data-a="qnext">▶</button><span data-r="qc" style="color:#9aa4b2"></span><span class="sep"></span>
      <button data-a="png">PNG</button><button data-a="svg">SVG</button><button data-a="print">Print</button><button data-a="clrmk">Clear markup</button>
      <span style="flex:1"></span><button data-a="close">Close ✕</button>`;
    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.onclick = () => setTool(b.dataset.t as Tool));
    const fileIn = tools.querySelector<HTMLInputElement>("[data-r=file]")!;
    fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) void load(f); fileIn.value = ""; };
    const act: Record<string, () => void> = {
      open: () => fileIn.click(), ext: zoomExtents, close: () => api!.close(),
      in: () => { pushView(); view = M.zoomAt(view, view.w / 2, view.h / 2, 1.5); draw(); },
      out: () => { pushView(); view = M.zoomAt(view, view.w / 2, view.h / 2, 1 / 1.5); draw(); },
      prev: () => { const v = history.pop(); if (v) { view = { ...v, w: view.w, h: view.h }; draw(); } },
      snap: () => { snapOn = !snapOn; tools.querySelector("[data-a=snap]")!.classList.toggle("on", snapOn); draw(); },
      png: () => exportPng(), svg: () => exportSvg(), print: () => doPrint(),
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
  function stepHit(d: number) { if (!hits.length) return; hitI = (hitI + d + hits.length) % hits.length; const h = hits[hitI]; goTo(h.x, h.y, Math.max(view.scale, 40 / Math.max(M.textBox(ents[h.index] as any).h, 1e-9))); const el = tools.querySelector("[data-r=qc]")!; el.textContent = `${hitI + 1} / ${hits.length}`; selected = h.index; showProps(); draw(); }
  function setTool(t: Tool) { tool = t; pts = []; winStart = winNow = null; hover = null; tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); cv.style.cursor = t === "pan" ? "grab" : "crosshair"; draw(); }
  function finishMeasure() {
    if (tool === "poly" && pts.length >= 2) { results.push(`Polyline: ${fmt(M.pathLength(pts))}`); drawn.push({ kind: "poly", pts: [...pts] }); }
    else if (tool === "area" && pts.length >= 3) { results.push(`Area: ${fmt(M.polygonArea(pts), 2)}  Perimeter: ${fmt(M.pathLength(pts, true))}`); drawn.push({ kind: "area", pts: [...pts] }); }
    pts = []; showMeas(); draw();
  }

  /* ── input ── */
  const rawPoint = (ev: PointerEvent | MouseEvent): { sp: M.Pt; wp: M.Pt } => { const r = cv.getBoundingClientRect(); const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top }; return { sp, wp: M.screenToWorld(view, sp.x, sp.y) }; };
  const snapped = (wp: M.Pt): M.Snap | null => (!idx || !snapOn || ["pan", "select", "zoomwin", "redline", "note"].includes(tool) && tool !== "redline") ? null : M.findSnap(idx, ents, wp.x, wp.y, 12 / view.scale, [...snapModes], visible);
  cv.addEventListener("pointerdown", (ev) => {
    if (!doc) return; cv.focus(); const { sp, wp } = rawPoint(ev);
    if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && tool === "pan")) { dragging = { x: sp.x, y: sp.y }; cv.setPointerCapture(ev.pointerId); cv.style.cursor = "grabbing"; pushView(); return; }
    if (ev.button !== 0) return;
    if (tool === "zoomwin") { winStart = winNow = sp; cv.setPointerCapture(ev.pointerId); return; }
    if (tool === "select") { selected = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, visible) : -1; showProps(); draw(); return; }
    const s = snapped(wp) ?? { ...wp, kind: "nearest" as M.SnapKind }; const p = { x: s.x, y: s.y };
    switch (tool) {
      case "coord": results.push(`X ${M.convertLength(p.x, doc.units, du).toFixed(3)}  Y ${M.convertLength(p.y, doc.units, du).toFixed(3)} ${M.unitLabel(doc.units, du)}`); drawn.push({ kind: "coord", pts: [p] }); showMeas(); break;
      case "dist": pts.push(p); if (pts.length === 2) { const d = M.distance(pts[0], pts[1]); results.push(`Distance: ${fmt(d)}  ΔX ${fmt(Math.abs(pts[1].x - pts[0].x))}  ΔY ${fmt(Math.abs(pts[1].y - pts[0].y))}  Angle ${M.norm360Deg(pts[0], pts[1]).toFixed(2)}°`); drawn.push({ kind: "dist", pts: [...pts] }); pts = []; showMeas(); } break;
      case "poly": case "area": pts.push(p); break;
      case "angle": pts.push(p); if (pts.length === 3) { results.push(`Angle: ${M.angleAt(pts[1], pts[0], pts[2]).toFixed(2)}°`); drawn.push({ kind: "angle", pts: [...pts] }); pts = []; showMeas(); } break;
      case "radius": { const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1; const e = ents[i]; if (e && (e.type === "CIRCLE" || e.type === "ARC")) { selected = i; results.push(`Radius ${fmt(e.radius)}  Diameter ${fmt(e.radius * 2)}`); showProps(); showMeas(); } break; }
      case "redline": if (!pts.length) pts = [wp]; else pts.push(wp); break;
      case "note": { const t = prompt("Note text"); if (t) markups.push({ kind: "note", pts: [wp], text: t }); break; }
    }
    draw();
  });
  cv.addEventListener("pointermove", (ev) => {
    const { sp, wp } = rawPoint(ev);
    if (dragging) { view = M.panBy(view, sp.x - dragging.x, sp.y - dragging.y); dragging = { x: sp.x, y: sp.y }; draw(); updateStatus(wp); return; }
    if (winStart) { winNow = sp; draw(); return; }
    hover = snapped(wp); cursor = hover ? { x: hover.x, y: hover.y } : wp; updateStatus(cursor); if (pts.length || hover || hits.length) draw();
  });
  const endDrag = (ev: PointerEvent) => {
    if (dragging) { dragging = null; cv.style.cursor = tool === "pan" ? "grab" : "crosshair"; }
    if (winStart && winNow) { const a = winStart, b = winNow; winStart = winNow = null; if (Math.abs(a.x - b.x) > 6 && Math.abs(a.y - b.y) > 6) { pushView(); view = M.zoomWindow(view, a, b); } setTool("pan"); }
    try { cv.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  };
  cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("dblclick", () => { if (tool === "poly" || tool === "area") { pts.pop(); finishMeasure(); } else if (tool === "redline" && pts.length > 1) { markups.push({ kind: "line", pts: [...pts] }); pts = []; draw(); } });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("wheel", (ev) => { if (!doc) return; ev.preventDefault(); const { sp } = rawPoint(ev); view = M.zoomAt(view, sp.x, sp.y, ev.deltaY < 0 ? 1.25 : 0.8); draw(); updateStatus(); }, { passive: false });
  cv.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { if (pts.length) { pts = []; draw(); } else if (selected >= 0) { selected = -1; showProps(); draw(); } else setTool("pan"); return; }
    if (ev.key === "Enter") { if (tool === "poly" || tool === "area") finishMeasure(); else if (tool === "redline" && pts.length > 1) { markups.push({ kind: "line", pts: [...pts] }); pts = []; draw(); } return; }
    if (ev.key === "F3") { ev.preventDefault(); (tools.querySelector("[data-a=snap]") as HTMLButtonElement).click(); return; }
    if (ev.key === "Backspace" && !pts.length) { ev.preventDefault(); (tools.querySelector("[data-a=prev]") as HTMLButtonElement).click(); return; }
    if (ev.key === "Backspace" && pts.length) { pts.pop(); draw(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === "e") zoomExtents(); else { const t = T.find(([, , key]) => key.toLowerCase() === k); if (t) setTool(t[0]); }
  });
  function updateStatus(p?: M.Pt) {
    const c = p ?? cursor; const zoomPct = doc && bounds ? Math.round((view.scale / M.fitView(bounds, view.w, view.h).scale) * 100) : 100;
    statusEl.innerHTML = `<span>${escapeHtml(name || "No file")}</span><span>${c && doc ? `X ${M.convertLength(c.x, doc.units, du).toFixed(3)}  Y ${M.convertLength(c.y, doc.units, du).toFixed(3)}` : ""}</span><span>Units: ${escapeHtml(doc ? M.unitLabel(doc.units, du) : "-")}</span><span>Zoom ${zoomPct}%</span><span>Tool: ${escapeHtml(T.find(([k]) => k === tool)?.[1] ?? tool)}</span><span style="flex:1"></span><span>Snap ${snapOn ? "on" : "off"}</span>`;
  }

  /* ── drop ── */
  const stage = $("stage");
  stage.addEventListener("dragover", (e) => { e.preventDefault(); });
  stage.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void load(f); });

  /* ── export ── */
  const base = () => (name || "drawing").replace(/\.[^.]+$/, "");
  const download = (blob: Blob, fn: string) => { const a = document.createElement("a"); const u = URL.createObjectURL(blob); a.href = u; a.download = fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  function offscreen(scale: number): HTMLCanvasElement { const c = document.createElement("canvas"); c.width = Math.round(view.w * scale); c.height = Math.round(view.h * scale); const x = c.getContext("2d")!; x.scale(scale, scale); render(x, view, false); return c; }
  function exportPng() { if (!doc) return; offscreen(2).toBlob((b) => b && download(b, `${base()}.png`), "image/png"); }
  function exportSvg() {
    if (!doc) return; const v = view; const o: string[] = [];
    const P = (x: number, y: number) => { const s = M.worldToScreen(v, x, y); return `${s.x.toFixed(2)},${s.y.toFixed(2)}`; };
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]; if (!visible(e) || !M.bboxVisible(idx!.boxes[i], v)) continue; const col = colorOf(e), st = `stroke="${col}" fill="none" stroke-width="${lw}"`;
      if (e.type === "LINE") o.push(`<line x1="${P(e.start.x, e.start.y).split(",")[0]}" y1="${P(e.start.x, e.start.y).split(",")[1]}" x2="${P(e.end.x, e.end.y).split(",")[0]}" y2="${P(e.end.x, e.end.y).split(",")[1]}" ${st}/>`);
      else if (e.type === "CIRCLE") { const c = M.worldToScreen(v, e.center.x, e.center.y); o.push(`<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${(e.radius * v.scale).toFixed(2)}" ${st}/>`); }
      else if (e.type === "ARC") { const r = e.radius * v.scale, s = e.startAngle * Math.PI / 180, en = e.endAngle * Math.PI / 180; const a = M.worldToScreen(v, e.center.x + e.radius * Math.cos(s), e.center.y + e.radius * Math.sin(s)), b = M.worldToScreen(v, e.center.x + e.radius * Math.cos(en), e.center.y + e.radius * Math.sin(en)); o.push(`<path d="M${a.x.toFixed(2)},${a.y.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${M.arcSweepDeg(e.startAngle, e.endAngle) > 180 ? 1 : 0} 0 ${b.x.toFixed(2)},${b.y.toFixed(2)}" ${st}/>`); }
      else if (e.type === "LWPOLYLINE") o.push(`<${e.closed ? "polygon" : "polyline"} points="${e.points.map((q) => P(q.x, q.y)).join(" ")}" ${st}/>`);
      else if (e.type === "TEXT") { const p = M.worldToScreen(v, e.position.x, e.position.y); o.push(`<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" font-size="${(e.height * v.scale).toFixed(2)}" fill="${col}" transform="rotate(${-(e.rotation ?? 0)} ${p.x.toFixed(2)} ${p.y.toFixed(2)})" font-family="sans-serif">${escapeHtml(e.value)}</text>`); }
      else if (e.type === "POINT") { const p = M.worldToScreen(v, e.position.x, e.position.y); o.push(`<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.5" fill="${col}"/>`); }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${v.w}" height="${v.h}" viewBox="0 0 ${v.w} ${v.h}"><rect width="100%" height="100%" fill="${BG[bg]}"/>${o.join("")}</svg>`;
    download(new Blob([svg], { type: "image/svg+xml" }), `${base()}.svg`);
  }
  function doPrint() {
    if (!doc) return; const url = offscreen(2).toDataURL("image/png");
    const w = window.open("", "_blank"); if (!w) { status("Allow pop-ups to print"); setTimeout(() => status(""), 4000); return; }
    w.document.write(`<!doctype html><title>${escapeHtml(name)}</title><style>@page{margin:8mm}body{margin:0}img{width:100%}</style><img src="${url}">`); w.document.close(); w.onload = () => w.print();
  }

  buildBar(); setTool("pan"); showProps(); showMeas(); updateStatus(); resize();
  api = {
    load,
    close() { root!.style.display = "none"; },
  };
  window.addEventListener("keydown", (e) => { if (root!.style.display !== "none" && e.key === "Escape" && document.activeElement === document.body) api!.close(); });
}
