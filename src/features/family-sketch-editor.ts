/**
 * Family sketch editor: draw a plan outline on a grid, give it a depth and elevation, and add it to a family as a
 * parametric extrusion (or create a new family from it). Geometry maths and validation live in
 * src/modules/families/sketch-core.ts (tested); this file is only the drawing UI.
 * Docs: docs/FAMILY-SKETCH.md. Never exercised in a real browser while it was written.
 */
import {
  addShapeToFamily, circlePoints, newFamilyFromSketch, rectPoints, type ShapeInput, snapPt, validateSketch, type Pt,
} from "../modules/families/sketch-core";

type Any = any;
type Tool = "polygon" | "rect" | "circle";
const W = 640, H = 420;
const NS = "http://www.w3.org/2000/svg";

function familySvc(): Any {
  return (window as Any).__obsFamilyParametric ?? (window as Any).__obsFamily ?? {};
}
function toast(kind: string, message: string): void {
  try { window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout: 3500 } })); } catch { /* */ }
}

export interface SketchEditorOptions {
  /** Family the outline is added to; omit to start in "new family" mode. */
  familyId?: string;
  onDone?: (familyId: string) => void;
}

let open: HTMLElement | null = null;

export function openFamilySketchEditor(opts: SketchEditorOptions = {}): void {
  if (open) { open.remove(); open = null; }
  const svc = familySvc();
  const target: Any = opts.familyId ? svc.get?.(opts.familyId) : null;

  let tool: Tool = "polygon";
  let pts: Pt[] = [];        // polygon vertices / rect+circle result once finished
  let closed = false;
  let anchor: Pt | null = null; // first click of rect / circle
  let hover: Pt | null = null;
  let scale = 80;            // pixels per metre
  let grid = 0.25;
  let snapOn = true;
  let outer: Pt[] | null = null;   // finished outline, while holes are being drawn
  let outerShape: ShapeInput | null = null;
  let holes: Pt[][] = [];
  let lastShape: ShapeInput | null = null; // rect / circle just drawn, for parametric mode

  const root = document.createElement("div");
  root.setAttribute("data-sketch-editor", "");
  root.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(5,8,14,.72);display:flex;align-items:center;justify-content:center;font:12px system-ui,sans-serif;color:#e5e7eb";
  root.innerHTML = `
  <div style="background:#12151d;border:1px solid #2a2e3a;border-radius:8px;width:min(720px,96vw);max-height:96vh;overflow:auto;padding:12px;box-shadow:0 20px 60px #000a">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <b style="font-size:13px;flex:1">Family sketch · ${target ? "add to “" + esc(target.name) + "”" : "new family"}</b>
      <button data-x type="button" style="background:none;border:0;color:#9ca3af;font-size:16px;cursor:pointer" aria-label="Close">×</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px">
      <span style="opacity:.7">Tool</span>
      <button data-tool="polygon" type="button">Polygon</button><button data-tool="rect" type="button">Rectangle</button><button data-tool="circle" type="button">Circle</button>
      <span style="opacity:.7;margin-left:8px">Grid</span>
      <select data-grid><option>0.05</option><option>0.1</option><option selected>0.25</option><option>0.5</option><option>1</option></select> m
      <label style="display:flex;gap:3px;align-items:center"><input data-snap type="checkbox" checked> Snap</label>
      <button data-zoom="-1" type="button" title="Zoom out">−</button><button data-zoom="1" type="button" title="Zoom in">+</button>
      <button data-undo type="button">Undo point</button><button data-clear type="button">Clear</button><button data-close type="button">Close outline</button>
      <button data-hole type="button" title="Keep this shape as the outline and draw a hole inside it">Next: draw hole</button>
    </div>
    <svg data-svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#0b0e14;border:1px solid #2a2e3a;border-radius:6px;max-width:100%;touch-action:none;cursor:crosshair"></svg>
    <div data-hint style="margin:6px 0;opacity:.75"></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:6px">
      <label>Depth (m) <input data-depth type="number" value="0.3" min="0.001" max="1000" step="0.05" style="width:70px"></label>
      <label>Elevation (m) <input data-elev type="number" value="0" step="0.05" style="width:70px"></label>
      <label title="Rectangle / circle become family parameters (width, length, radius) so the shape resizes"><input data-param type="checkbox" checked> Size as parameters</label>
      ${target ? "" : `<label>Name <input data-name type="text" value="Sketch family" maxlength="100" style="width:150px"></label>
      <label>Category <select data-cat><option>generic</option><option>equipment</option><option>column</option><option>beam</option><option>slab</option><option>footing</option><option>fitting</option></select></label>`}
    </div>
    <div data-status style="min-height:30px;white-space:pre-wrap;color:#fbbf24"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button data-cancel type="button">Cancel</button>
      <button data-apply type="button" style="background:#2563eb;color:#fff;border:0;padding:5px 12px;border-radius:4px;cursor:pointer">${target ? "Add to family" : "Create family"}</button>
    </div>
  </div>`;
  document.body.appendChild(root);
  open = root;
  root.querySelectorAll("button").forEach((b) => { if (!(b as HTMLElement).style.background) (b as HTMLElement).style.cssText += ";background:#1f2430;color:#e5e7eb;border:1px solid #2a2e3a;border-radius:4px;padding:3px 8px;cursor:pointer"; });

  const svg = root.querySelector("[data-svg]") as SVGSVGElement;
  const status = root.querySelector("[data-status]") as HTMLElement;
  const hint = root.querySelector("[data-hint]") as HTMLElement;
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;

  const toScreen = (p: Pt): [number, number] => [W / 2 + p[0] * scale, H / 2 - p[1] * scale];
  const toWorld = (sx: number, sy: number): Pt => { const p: Pt = [(sx - W / 2) / scale, (H / 2 - sy) / scale]; return snapOn ? snapPt(p, grid) : p; };
  const el = (name: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text) e.textContent = text;
    return e;
  };

  function currentOutline(): Pt[] {
    if (tool === "polygon") return pts;
    return pts;
  }

  function draw(): void {
    svg.replaceChildren();
    // grid lines every `grid` m when they are at least 8 px apart; major lines each metre
    const step = grid * scale >= 8 ? grid : 1;
    for (let x = 0; x * scale < W / 2; x += step) for (const sx of x === 0 ? [W / 2] : [W / 2 + x * scale, W / 2 - x * scale]) svg.appendChild(el("line", { x1: sx, y1: 0, x2: sx, y2: H, stroke: Math.abs(x % 1) < 1e-9 ? "#2b3245" : "#1a2030", "stroke-width": 1 }));
    for (let y = 0; y * scale < H / 2; y += step) for (const sy of y === 0 ? [H / 2] : [H / 2 + y * scale, H / 2 - y * scale]) svg.appendChild(el("line", { x1: 0, y1: sy, x2: W, y2: sy, stroke: Math.abs(y % 1) < 1e-9 ? "#2b3245" : "#1a2030", "stroke-width": 1 }));
    svg.appendChild(el("line", { x1: W / 2, y1: 0, x2: W / 2, y2: H, stroke: "#3b82f6", "stroke-width": 1, opacity: 0.6 }));
    svg.appendChild(el("line", { x1: 0, y1: H / 2, x2: W, y2: H / 2, stroke: "#ef4444", "stroke-width": 1, opacity: 0.6 }));
    svg.appendChild(el("text", { x: 6, y: 14, fill: "#94a3b8", "font-size": 10 }, "Plan view · +X right · +Y up (north) · origin at centre"));
    const ring = (r: Pt[], stroke: string, fill: string) => svg.appendChild(el("path", { d: r.map((p, i) => { const [x, y] = toScreen(p); return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ") + " Z", fill, stroke, "stroke-width": 2 }));
    if (outer) ring(outer, "#60a5fa", "rgba(59,130,246,.18)");
    holes.forEach((h) => ring(h, "#f97316", "#0b0e14"));
    const outline = currentOutline();
    const preview: Pt[] = [...outline];
    if (!closed && hover) {
      if (tool === "polygon") preview.push(hover);
      else if (tool === "rect" && anchor) preview.splice(0, preview.length, ...rectPoints(anchor[0], anchor[1], hover[0], hover[1]));
      else if (tool === "circle" && anchor) preview.splice(0, preview.length, ...circlePoints(anchor[0], anchor[1], Math.hypot(hover[0] - anchor[0], hover[1] - anchor[1]) || 0.001));
    }
    if (preview.length > 1) {
      const d = preview.map((p, i) => { const [x, y] = toScreen(p); return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ") + (closed || tool !== "polygon" ? " Z" : "");
      svg.appendChild(el("path", { d, fill: closed || tool !== "polygon" ? "rgba(59,130,246,.18)" : "none", stroke: "#60a5fa", "stroke-width": 2 }));
    }
    for (const p of outline) { const [x, y] = toScreen(p); svg.appendChild(el("circle", { cx: x, cy: y, r: 3.5, fill: "#fff" })); }
    if (tool === "polygon" && !closed && outline.length >= 3) { const [x, y] = toScreen(outline[0]); svg.appendChild(el("circle", { cx: x, cy: y, r: 7, fill: "none", stroke: "#22c55e", "stroke-width": 2 })); }
    if (hover) svg.appendChild(el("text", { x: W - 8, y: H - 8, fill: "#94a3b8", "font-size": 10, "text-anchor": "end" }, `x ${hover[0].toFixed(2)}  y ${hover[1].toFixed(2)} m`));
    // result summary
    const done = closed || (tool !== "polygon" && pts.length > 0);
    const v = validateSketch(done ? pts : []);
    status.style.color = v.ok ? "#86efac" : "#fbbf24";
    if (!done) status.textContent = "";
    else if (v.ok && v.bbox) status.textContent = `${outer ? "Hole" : "Outline"} ok: ${(v.bbox.maxX - v.bbox.minX).toFixed(2)} × ${(v.bbox.maxY - v.bbox.minY).toFixed(2)} m, area ${v.area.toFixed(3)} m², ${v.points.length} points.`;
    else status.textContent = v.errors.join("\n");
    hint.textContent = tool === "polygon"
      ? (closed ? "Outline closed. Change tool or Clear to start again." : "Click to add points. Click the green first point, press Enter, or use “Close outline” to finish. Backspace removes the last point.")
      : tool === "rect" ? (anchor ? "Click the opposite corner." : "Click the first corner.") : (anchor ? "Click to set the radius." : "Click the centre.");
    root.querySelectorAll("[data-tool]").forEach((b) => ((b as HTMLElement).style.outline = (b as HTMLElement).getAttribute("data-tool") === tool ? "2px solid #3b82f6" : "none"));
  }

  function reset(t?: Tool): void { if (t) tool = t; pts = []; closed = false; anchor = null; if (!t) { outer = null; outerShape = null; holes = []; } lastShape = null; draw(); }
  function tryClose(): void { if (tool === "polygon" && pts.length >= 3) { closed = true; draw(); } }

  function pointerPos(e: PointerEvent): [number, number] {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }
  svg.addEventListener("pointermove", (e) => { const [sx, sy] = pointerPos(e); hover = toWorld(sx, sy); draw(); });
  svg.addEventListener("pointerleave", () => { hover = null; draw(); });
  svg.addEventListener("pointerdown", (e) => {
    const [sx, sy] = pointerPos(e); const p = toWorld(sx, sy);
    if (tool === "polygon") {
      if (closed) return;
      if (pts.length >= 3) { const [fx, fy] = toScreen(pts[0]); if (Math.hypot(fx - sx, fy - sy) < 9) { tryClose(); return; } }
      pts.push(p);
    } else if (!anchor) { anchor = p; pts = []; }
    else if (tool === "rect") { pts = rectPoints(anchor[0], anchor[1], p[0], p[1]); lastShape = { kind: "rect", cx: (anchor[0] + p[0]) / 2, cy: (anchor[1] + p[1]) / 2, width: Math.abs(p[0] - anchor[0]), length: Math.abs(p[1] - anchor[1]) }; anchor = null; }
    else { const rad = Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) || 0.001; pts = circlePoints(anchor[0], anchor[1], rad); lastShape = { kind: "circle", cx: anchor[0], cy: anchor[1], radius: rad }; anchor = null; }
    draw();
  });

  root.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => reset((b as HTMLElement).getAttribute("data-tool") as Tool)));
  q("[data-grid]").addEventListener("change", (e) => { grid = parseFloat((e.target as HTMLSelectElement).value) || 0.25; draw(); });
  q<HTMLInputElement>("[data-snap]").addEventListener("change", (e) => { snapOn = (e.target as HTMLInputElement).checked; });
  root.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => { scale = Math.max(10, Math.min(400, scale * (b.getAttribute("data-zoom") === "1" ? 1.4 : 1 / 1.4))); draw(); }));
  q("[data-undo]").addEventListener("click", () => { if (closed) closed = false; else pts.pop(); draw(); });
  q("[data-clear]").addEventListener("click", () => reset());
  q("[data-close]").addEventListener("click", tryClose);
  const shapeDone = () => closed || (tool !== "polygon" && pts.length > 0);
  /** Move the finished shape to the outline (first press) or add it as a hole (later presses), then start a fresh hole. */
  q("[data-hole]").addEventListener("click", () => {
    if (!shapeDone()) { status.style.color = "#fbbf24"; status.textContent = "Finish the current shape first."; return; }
    const v = validateSketch(pts);
    if (!v.ok) { status.style.color = "#fbbf24"; status.textContent = v.errors.join("\n"); return; }
    if (!outer) { outer = v.points; outerShape = tool === "polygon" ? { kind: "polygon", points: v.points } : (lastShape ?? { kind: "polygon", points: v.points }); }
    else { holes.push(v.points); }
    pts = []; closed = false; anchor = null; lastShape = null; draw();
    status.style.color = "#86efac"; status.textContent = `${holes.length} hole(s) so far. Draw the next hole, then Apply (the shape being drawn counts as a hole).`;
  });

  const close = () => { root.remove(); open = null; window.removeEventListener("keydown", onKey, true); };
  function onKey(e: KeyboardEvent): void {
    if (!root.isConnected) return;
    const t = e.target as HTMLElement;
    const typing = t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter" && !typing) { e.preventDefault(); tryClose(); }
    else if (e.key === "Backspace" && !typing) { e.preventDefault(); if (closed) closed = false; else pts.pop(); draw(); }
  }
  window.addEventListener("keydown", onKey, true);
  q("[data-x]").addEventListener("click", close);
  q("[data-cancel]").addEventListener("click", close);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });

  q("[data-apply]").addEventListener("click", () => {
    const done = shapeDone();
    if (!done && !outer) { status.style.color = "#fbbf24"; status.textContent = "Finish the outline first (close the polygon, or complete the rectangle / circle)."; return; }
    // Build the shape: with an outline set aside, whatever is drawn now is one more hole.
    const allHoles: Pt[][] = [...holes, ...(outer && done ? [pts] : [])];
    const useParams = q<HTMLInputElement>("[data-param]").checked;
    let shape: ShapeInput;
    if (outer) shape = { kind: "polygon", points: outer, holes: allHoles };
    else if (useParams && lastShape && tool !== "polygon") shape = lastShape;
    else shape = { kind: "polygon", points: pts };
    if (outer && outerShape && outerShape.kind !== "polygon" && allHoles.length === 0) shape = useParams ? outerShape : { kind: "polygon", points: outer };
    const depth = parseFloat(q<HTMLInputElement>("[data-depth]").value);
    const elevation = parseFloat(q<HTMLInputElement>("[data-elev]").value || "0");
    try {
      if (target) {
        const r = addShapeToFamily(target, shape, { depth, elevation, label: "sketch" });
        if (!r.ok) { status.style.color = "#fbbf24"; status.textContent = r.errors.join("\n"); return; }
        let id = target.id;
        if (target.builtIn) { // built-in families are not edited in place: work on a copy
          const copy = svc.duplicate?.(target.id, `${target.name} (sketch)`);
          if (!copy) { status.textContent = "Could not copy the built-in family."; return; }
          id = copy.id;
        }
        svc.update?.(id, { parameters: r.family.parameters, geometry: r.family.geometry });
        toast("success", target.builtIn ? "Sketch added to a copy of the built-in family" : "Sketch added to the family");
        close(); opts.onDone?.(id);
      } else {
        const name = q<HTMLInputElement>("[data-name]").value;
        const r = newFamilyFromSketch({ id: "pending", name, category: q<HTMLSelectElement>("[data-cat]").value as Any, shape, depth, elevation });
        if (!r.ok) { status.style.color = "#fbbf24"; status.textContent = r.errors.join("\n"); return; }
        const { id: _drop, schemaVersion: _s, builtIn: _b, ...rest } = r.family as Any;
        const tid = `t_${Date.now().toString(36)}`;
        const made = svc.create?.({ ...rest, types: [{ id: tid, name: "Default", values: {} }] });
        if (!made) { status.textContent = "The family service is not available."; return; }
        toast("success", `Created family “${made.name}”`);
        close(); opts.onDone?.(made.id);
      }
    } catch (e) {
      status.style.color = "#f87171"; status.textContent = "Could not save: " + (e instanceof Error ? e.message : String(e));
    }
  });
  draw();
}

function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)); }
