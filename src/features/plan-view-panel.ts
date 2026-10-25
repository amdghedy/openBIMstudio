/**
 * Full-screen plan view overlay.
 *
 * - Level dropdown (uses user levels or fallback set)
 * - Cut height slider (BIM default 1.2 m)
 * - SVG rendering at world scale
 * - Wheel zoom, middle-mouse (or Shift+left) pan, left click selection/placement
 * - Print / Export SVG / Close
 */
import { escapeHtml } from "../core/html-escape";
import { constrainOrtho, pointAtLength, angleDeg, parseLength, isLengthChar } from "./plan-draw-math";
import { getCropRegion, setCropRegion, setActiveView as setCropActiveView, onCropChanged, getActiveCropView, dragCropHandle, snapCrop } from "./crop-region";
import { ctx } from "../core/context";
import { buildTagAll, elementAnchor, leaderEnd, pointInBox, tagLabel, textBox, type TagMode } from "../modules/views/plan-tags";
import { dimLineEnds, distToSegment, moveDimLineTo } from "../modules/views/plan-dim-geometry";
import { history as planHistory } from "./history";
import { buildAutoDimensions, buildRangeDimension } from "../modules/views/auto-dim-chains";
import { resolveElementRef } from "../modules/views/element-snap-points";
import { edgeMidpoint, insertVertex, removeVertex, moveVertex, isValidBoundary } from "../modules/views/boundary-edit";
import { findPlanSnap as findPlanFeatureSnap, snapSvgMarkup, type PlanSnapHit } from "../modules/views/plan-snap";
import {
  generatePlanView,
  listAvailableLevels,
} from "../modules/drawings/plan-generator";
import type { PlanView } from "../modules/drawings/plan-types";
import { getSchema, type PropertyField } from "./property-schema";

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
let currentPlan: PlanView | null = null;
let currentZoom = 1;
let panX = 0, panY = 0;
let generating = false;
let cancelHandle: { cancelled: boolean } | null = null;

/* -------------------------------------------------------------------------
   DOM
   ------------------------------------------------------------------------- */
const overlay = document.createElement("div");
overlay.className = "obs-plan-overlay";
/** Under the ribbon so Architecture / Annotate / Dimension tabs stay usable (BIM-style). */
overlay.style.cssText =
  "position:fixed;left:0;right:0;bottom:0;top:88px;z-index:200;display:none;flex-direction:column;" +
  "background:#1a1d27;color:var(--text-primary,#e8eaf0);" +
  "font:13px system-ui,sans-serif;user-select:none;border-top:1px solid #2a2e3a";
overlay.addEventListener("mousedown", (e) => e.stopPropagation());

/* -- Header -- */
const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:10px;padding:8px 12px;" +
  "background:var(--bg-surface,#12141b);border-bottom:1px solid var(--border-default,#2a2e3a);" +
  "height:44px;flex:none";

/* -- Main canvas -- */
const canvasWrap = document.createElement("div");
canvasWrap.style.cssText =
  "flex:1;position:relative;overflow:hidden;background:#f7f7f5;" +
  "cursor:grab";

const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.style.cssText = "width:100%;height:100%;display:block";
svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
canvasWrap.appendChild(svg);

/* -- Footer -- */
const footer = document.createElement("div");
footer.style.cssText =
  "display:flex;align-items:center;gap:12px;padding:6px 12px;" +
  "background:var(--bg-surface,#12141b);border-top:1px solid var(--border-default,#2a2e3a);" +
  "height:30px;flex:none;font:11px system-ui";

/* -- Loading overlay -- */
const loading = document.createElement("div");
loading.style.cssText =
  "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
  "flex-direction:column;gap:12px;background:rgba(11,13,18,0.85);color:#e8eaf0;z-index:10";
const loadingText = document.createElement("div");
loadingText.style.cssText = "font:14px system-ui";
loadingText.textContent = "Generating plan�";
const loadingBar = document.createElement("div");
loadingBar.style.cssText =
  "width:300px;height:6px;background:#1e2029;border-radius:3px;overflow:hidden";
const loadingBarInner = document.createElement("div");
loadingBarInner.style.cssText = "height:100%;width:0%;background:#38bdf8;transition:width .15s";
loadingBar.appendChild(loadingBarInner);
const cancelBtn = document.createElement("button");
cancelBtn.textContent = "Cancel";
cancelBtn.style.cssText =
  "padding:6px 14px;background:var(--danger-dim,#ef444422);color:#fca5a5;" +
  "border:1px solid #ef4444;border-radius:5px;cursor:pointer;font:12px system-ui";
cancelBtn.onclick = () => { if (cancelHandle) cancelHandle.cancelled = true; };
loading.append(loadingText, loadingBar, cancelBtn);
canvasWrap.appendChild(loading);

canvasWrap.appendChild(loading);

/* -- BIM-style Properties panel (left of plan) -- */
const planBody = document.createElement("div");
planBody.style.cssText = "flex:1;display:flex;min-height:0;overflow:hidden";

const planProps = document.createElement("div");
planProps.style.cssText =
  "width:280px;flex:none;display:flex;flex-direction:column;" +
  "background:#f3f4f6;color:#111827;border-right:1px solid #d1d5db;" +
  "font:12px system-ui,sans-serif";
const planPropsHeader = document.createElement("div");
planPropsHeader.style.cssText =
  "padding:10px 12px;font-weight:700;border-bottom:1px solid #d1d5db;" +
  "background:#e5e7eb;display:flex;align-items:center;gap:8px";
planPropsHeader.innerHTML = `<span style="flex:1">Properties</span>`;
const planPropsBody = document.createElement("div");
planPropsBody.style.cssText = "flex:1;overflow-y:auto;padding:0";
const planPropsFooter = document.createElement("div");
planPropsFooter.style.cssText =
  "padding:8px;border-top:1px solid #d1d5db;background:#e5e7eb;display:flex;justify-content:flex-end";
const applyBtn = document.createElement("button");
applyBtn.textContent = "Apply";
applyBtn.style.cssText =
  "padding:5px 14px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font:12px system-ui";
planPropsFooter.appendChild(applyBtn);
planProps.append(planPropsHeader, planPropsBody, planPropsFooter);

/** Active Floor Plan selection. Ctrl+LeftClick adds/toggles without clearing prior items. */
let planSelectedId: string | null = null;
const planSelectedIds = new Set<string>();

type DimensionUnit = "mm" | "cm" | "m";
type DimensionTick = "diagonal" | "dot" | "arrow";
interface DimensionStyle {
  id: string;
  name: string;
  unit: DimensionUnit;
  precision: number;
  textSize: number;
  color: string;
  tick: DimensionTick;
}

const DEFAULT_DIMENSION_STYLES: DimensionStyle[] = [
  { id: "bim-aligned", name: "Aligned � 2.5 mm", unit: "mm", precision: 0, textSize: 2.5, color: "#1d4ed8", tick: "diagonal" },
  { id: "bim-engineering", name: "Engineering � 3 mm", unit: "mm", precision: 0, textSize: 3, color: "#1e40af", tick: "diagonal" },
  { id: "decimal-m", name: "Decimal Meters", unit: "m", precision: 3, textSize: 2.5, color: "#1d4ed8", tick: "arrow" },
];
const DIM_STYLE_KEY = "obs.bim.dimension-styles.v1";
function loadDimensionStyleId(): string {
  try { return localStorage.getItem(DIM_STYLE_KEY) ?? DEFAULT_DIMENSION_STYLES[0].id; } catch { return DEFAULT_DIMENSION_STYLES[0].id; }
}
let activeDimensionStyleId = loadDimensionStyleId();
const getDimensionStyle = () => DEFAULT_DIMENSION_STYLES.find((d) => d.id === activeDimensionStyleId) ?? DEFAULT_DIMENSION_STYLES[0];

const PLAN_SCALE_KEY = "obs.bim.plan-scale.v1";
let planViewScale = (() => {
  try {
    const v = Number(localStorage.getItem(PLAN_SCALE_KEY));
    return [50, 100, 200, 500].includes(v) ? v : 100;
  } catch { return 100; }
})();
let planDetailLevel: "Coarse" | "Medium" | "Fine" = "Medium";
let planDisplayModel = true;
let planCropView = false;
const PLAN_CROP_ID = "plan-view-1";
/** Typed length while drawing a linear element (Revit-style temporary dimension entry). */
let planTypedLength = "";
let planAnnotationCrop = false;
let planUnderlay = "None";
let planViewRangeBottom = 0;
let planViewRangeTop = 3;
let planViewRangeDepth = 3;

function planFieldValue(field: PropertyField, el: any, typeKey: string): string {
  if (el) {
    if (typeof field.compute === "function") {
      try {
        const v = field.compute(el);
        if (v !== undefined && v !== null) return String(v);
      } catch { /* fall through to stored value */ }
    }
    if (field.target === "root") return String((el as any)[field.key] ?? "");
    if (field.target === "params") return String((el.params as any)?.[field.key] ?? "");
    return String((el.properties as any)?.[field.key] ?? "");
  }
  // Defaults from placement options / tool
  if (field.key === "thickness") return String(planWidth);
  if (field.key === "height") return String(planHeight);
  if (field.key === "elevation") return String(planElevOffset);
  return field.default != null ? String(field.default) : "";
}

function renderPlanViewProperties() {
  planPropsBody.innerHTML = "";
  planPropsHeader.innerHTML = `<span style="flex:1">Floor Plan � View Properties</span>`;

  const section = (title: string) => {
    const h = document.createElement("div");
    h.style.cssText = "padding:7px 12px;background:#dbeafe;color:#1e3a8a;font-weight:700;font-size:11px;border-bottom:1px solid #bfdbfe";
    h.textContent = title;
    planPropsBody.appendChild(h);
  };
  const row = (label: string, control: HTMLElement) => {
    const r = document.createElement("div");
    r.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #e5e7eb;min-height:30px";
    const l = document.createElement("div"); l.textContent = label; l.style.cssText = "padding:6px 10px;color:#374151;background:#f9fafb;display:flex;align-items:center";
    const c = document.createElement("div"); c.style.cssText = "padding:3px 6px;background:#fff;display:flex;align-items:center"; c.appendChild(control);
    r.append(l,c); planPropsBody.appendChild(r);
  };
  const select = (opts: [string,string][], value: string, onChange: (v:string)=>void) => {
    const s = document.createElement("select"); s.style.cssText = "width:100%;border:1px solid #d1d5db;padding:4px;font:12px system-ui;background:#fff";
    for (const [v,l] of opts) { const o=document.createElement("option"); o.value=v; o.textContent=l; o.selected=v===value; s.appendChild(o); }
    s.onchange=()=>onChange(s.value); return s;
  };
  const num = (value:number, step=0.1, onChange:(v:number)=>void) => {
    const i=document.createElement("input"); i.type="number"; i.step=String(step); i.value=String(value); i.style.cssText="width:100%;box-sizing:border-box;border:1px solid #d1d5db;padding:4px;font:12px system-ui"; i.onchange=()=>onChange(Number(i.value)); return i;
  };
  const check = (value:boolean,onChange:(v:boolean)=>void) => {
    const i=document.createElement("input"); i.type="checkbox"; i.checked=value; i.onchange=()=>onChange(i.checked); return i;
  };

  section("Identity");
  row("Level", levelSelect.cloneNode(true) as HTMLElement);
  const liveLevel = planPropsBody.lastElementChild?.querySelector("select") as HTMLSelectElement | null;
  if (liveLevel) {
    liveLevel.value = levelSelect.value;
    liveLevel.onchange = () => { levelSelect.value = liveLevel.value; void regenerate(); };
  }
  row("View Scale", select([["50","1 : 50"],["100","1 : 100"],["200","1 : 200"],["500","1 : 500"]], String(planViewScale), v=>{ planViewScale=Number(v)||100; try{localStorage.setItem(PLAN_SCALE_KEY,String(planViewScale));}catch{}; scaleSelect.value=String(planViewScale); if(currentPlan) renderPlan(currentPlan); }));
  row("Detail Level", select([["Coarse","Coarse"],["Medium","Medium"],["Fine","Fine"]], planDetailLevel, v=>{ planDetailLevel=v as any; if(currentPlan) renderPlan(currentPlan); }));

  section("Graphics");
  row("Display Model", check(planDisplayModel, v=>{planDisplayModel=v; if(currentPlan) renderPlan(currentPlan);}));
  row("Crop View", check(getCropRegion(PLAN_CROP_ID).enabled, v=>{planCropView=v; setCropRegion(PLAN_CROP_ID,{enabled:v}); if(v) setCropActiveView(PLAN_CROP_ID); if(currentPlan) renderPlan(currentPlan);}));
  row("Annotation Crop", check(planAnnotationCrop, v=>{planAnnotationCrop=v; if(currentPlan) renderPlan(currentPlan);}));
  row("Underlay", select([["None","None"],["Below","Below"],["Link CAD","CAD Underlay"]], planUnderlay, v=>{ planUnderlay=v; }));

  section("View Range");
  row("Cut Plane", num(cutHeight,0.05,v=>{ if(Number.isFinite(v)){cutHeight=v; cutSlider.value=String(v); cutLabel.textContent=`Cut: ${v.toFixed(2)} m`; void regenerate(); }}));
  row("Bottom", num(planViewRangeBottom,0.05,v=>{ planViewRangeBottom=Math.max(-20,v); void regenerate(); }));
  row("Top", num(planViewRangeTop,0.05,v=>{ planViewRangeTop=Math.max(0.05,v); void regenerate(); }));
  row("View Depth", num(planViewRangeDepth,0.1,v=>{ planViewRangeDepth=Math.max(0.1,v); void regenerate(); }));

  section("Annotations");
  row("Dimension Type", dimTypeSelect.cloneNode(true) as HTMLElement);
  const liveDim = planPropsBody.lastElementChild?.querySelector("select") as HTMLSelectElement | null;
  if (liveDim) {
    liveDim.value=activeDimensionStyleId; liveDim.onchange=()=>{activeDimensionStyleId=liveDim.value;dimTypeSelect.value=activeDimensionStyleId;try{localStorage.setItem(DIM_STYLE_KEY,activeDimensionStyleId);}catch{};if(currentPlan)renderPlan(currentPlan);};
  }
  row("Dimension Units", unitSelect.cloneNode(true) as HTMLElement);
  const liveUnit = planPropsBody.lastElementChild?.querySelector("select") as HTMLSelectElement | null;
  if (liveUnit) { liveUnit.value=getDimensionStyle().unit; liveUnit.onchange=()=>{getDimensionStyle().unit=liveUnit.value as DimensionUnit;unitSelect.value=liveUnit.value;if(currentPlan)renderPlan(currentPlan);}; }

  const note=document.createElement("div"); note.style.cssText="padding:10px;color:#6b7280;line-height:1.45"; note.textContent="BIM-style view properties: selection stays model-specific, dimensions and annotations are view-specific, and the active plan keeps its level/cut/graphics state."; planPropsBody.appendChild(note);
}

function renderPlanProperties() {
  planPropsBody.innerHTML = "";
  let typeKey = planLinearType as string;
  let el: any = null;
  if (planMode === "point") typeKey = planPointType;
  if (planMode === "dim" || planMode === "tag" || planMode === "text") typeKey = "wall";
  if (planSelectedId) {
    try {
      // dynamic import avoided � getElements from window cache via async earlier
    } catch { /* */ }
  }
  // Use sync path via stored selection. Multi-select shows a compact summary.
  const selectedEls = (((window as any).__obsPlanSelectedEls ?? []) as any[]).filter((x) => planSelectedIds.has(x.id));
  const sel = (window as any).__obsPlanSelectedEl;
  if (selectedEls.length > 1) {
    planPropsHeader.innerHTML = `<span style="flex:1">${selectedEls.length} elements selected</span>`;
    const info = document.createElement("div");
    info.style.cssText = "padding:12px;color:#374151;line-height:1.5";
    info.innerHTML = `<b>Multiple selection</b><br>Ctrl + Left Click adds/removes elements.<br><span style="color:#6b7280">Use Properties after reducing to one element for instance parameters.</span>`;
    planPropsBody.appendChild(info);
    return;
  }
  if (sel) {
    el = sel;
    typeKey = el.type;
  }

  if (!el && planMode === "pan") {
    renderPlanViewProperties();
    return;
  }

  const schema = getSchema(typeKey);
  const title = el
    ? `${schema?.label ?? typeKey} � ${el.name ?? el.id}`
    : `${schema?.label ?? typeKey} (type defaults)`;
  planPropsHeader.innerHTML = `<span style="flex:1">${escapeHtml(title)}</span>`;

  if (!schema) {
    planPropsBody.innerHTML = `<div style="padding:12px;color:#6b7280">No schema for ${escapeHtml(typeKey)}</div>`;
    return;
  }

  for (const group of schema.groups) {
    const fields = schema.fields.filter((f) => f.group === group);
    if (!fields.length) continue;
    const gh = document.createElement("div");
    gh.style.cssText =
      "padding:6px 12px;background:#dbeafe;color:#1e3a8a;font-weight:600;font-size:11px;border-bottom:1px solid #bfdbfe";
    gh.textContent = group;
    planPropsBody.appendChild(gh);

    for (const field of fields) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #e5e7eb;min-height:28px";
      const lab = document.createElement("div");
      lab.style.cssText = "padding:5px 10px;color:#374151;display:flex;align-items:center;background:#f9fafb";
      lab.textContent = field.label + (field.unit ? ` (${field.unit})` : "");
      const cell = document.createElement("div");
      cell.style.cssText = "padding:2px 6px;display:flex;align-items:center;background:#fff";

      let input: HTMLElement;
      const val = planFieldValue(field, el, typeKey);
      if (field.readOnly) {
        const ro = document.createElement("div");
        ro.textContent = val === "" ? "\u2014" : val;
        ro.style.cssText = "width:100%;padding:3px 4px;font:12px system-ui;color:#6b7280;background:#f3f4f6;min-height:18px";
        input = ro;
      } else if (field.type === "select" && field.options) {
        const sel = document.createElement("select");
        sel.style.cssText = "width:100%;border:1px solid #e5e7eb;padding:3px;font:12px system-ui;background:#fff";
        for (const o of field.options) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === val) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.onchange = () => applyPlanField(field, sel.value, el, typeKey);
        input = sel;
      } else if (field.type === "boolean") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = val === "true" || val === "1";
        cb.onchange = () => applyPlanField(field, cb.checked ? "true" : "false", el, typeKey);
        input = cb;
      } else if (field.type === "color") {
        const c = document.createElement("input");
        c.type = "color";
        c.value = val && val.startsWith("#") ? val : "#94a3b8";
        c.oninput = () => applyPlanField(field, c.value, el, typeKey);
        input = c;
      } else {
        const inp = document.createElement("input");
        inp.type = field.type === "number" ? "number" : "text";
        if (field.step) inp.step = String(field.step);
        if (field.min != null) inp.min = String(field.min);
        inp.value = val;
        inp.style.cssText = "width:100%;border:1px solid transparent;padding:3px 4px;font:12px system-ui;background:transparent";
        inp.onfocus = () => { inp.style.borderColor = "#2563eb"; inp.style.background = "#eff6ff"; };
        inp.onblur = () => {
          inp.style.borderColor = "transparent";
          inp.style.background = "transparent";
          applyPlanField(field, inp.value, el, typeKey);
        };
        inp.onchange = () => applyPlanField(field, inp.value, el, typeKey);
        input = inp;
      }
      cell.appendChild(input);
      row.append(lab, cell);
      planPropsBody.appendChild(row);
    }
  }
}

async function applyPlanField(field: PropertyField, raw: string, el: any, typeKey: string) {
  try {
    if (!el) {
      // Type defaults ? placement options
      if (field.key === "thickness") {
        planWidth = Number(raw) || planWidth;
        const wi = widthInp.querySelector("input") as HTMLInputElement | null;
        if (wi) wi.value = String(Math.round(planWidth * 1000));
      }
      if (field.key === "height") {
        planHeight = Number(raw) || planHeight;
        const hi = heightInp.querySelector("input") as HTMLInputElement | null;
        if (hi) hi.value = String(Math.round(planHeight * 1000));
      }
      if (field.key === "elevation") {
        planElevOffset = Number(raw) || 0;
        const ei = elevInp.querySelector("input") as HTMLInputElement | null;
        if (ei) ei.value = String(Math.round(planElevOffset * 1000));
      }
      // Persist type defaults
      try {
        const auth = await import("./authoring");
        if ((auth as any).setTypeDefault) {
          (auth as any).setTypeDefault(typeKey, field.key, field.type === "number" ? Number(raw) : raw, field.target);
        }
      } catch { /* */ }
      return;
    }
    // Edit selected element
    if (field.key === "bendRadius" && el.type === "fitting") {
      const auth = await import("./authoring");
      const ok = (auth as any).setElbowBendRadius?.(el.id, Number(raw));
      if (ok === false) footerStatus("Bend radius too large for the connected runs");
      await regenerate();
      renderPlanProperties();
      return;
    }
    if (field.target === "root") (el as any)[field.key] = field.type === "number" ? Number(raw) : raw;
    else if (field.target === "params") {
      (el.params as any)[field.key] = field.type === "number" ? Number(raw) : raw;
      if (field.key === "thickness") planWidth = Number(raw) || planWidth;
      if (field.key === "height") planHeight = Number(raw) || planHeight;
    } else {
      if (!el.properties) el.properties = {};
      el.properties[field.key] = field.type === "number" ? Number(raw) : raw;
    }
    const auth = await import("./authoring");
    auth.rebuildAuthored?.();
    await regenerate();
  } catch (err) {
    console.warn("[plan] apply field", err);
  }
}

applyBtn.onclick = () => {
  renderPlanProperties();
  footerStatus("Properties applied");
};

function setPlanSelectedElement(el: any | null, mode: "replace" | "add" | "toggle" = "replace") {
  if (el) { planDimSel = null; planAnnoSel = null; }
  if (mode === "replace") {
    planSelectedIds.clear();
    if (el?.id) planSelectedIds.add(el.id);
  } else if (el?.id && mode === "add") {
    planSelectedIds.add(el.id);
  } else if (el?.id && mode === "toggle") {
    if (planSelectedIds.has(el.id)) planSelectedIds.delete(el.id);
    else planSelectedIds.add(el.id);
  }
  planSelectedId = planSelectedIds.size === 1 ? [...planSelectedIds][0] : null;
  const selected = (((window as any).__obsAuthoredElements ?? []) as any[]).filter((x) => planSelectedIds.has(x.id));
  (window as any).__obsPlanSelectedEl = selected.length === 1 ? selected[0] : null;
  (window as any).__obsPlanSelectedEls = selected;
  try {
    (window as any).__obsAuthoredSelectionBridge?.(selected.map((x) => x.id));
  } catch { /* selection bridge optional */ }
  renderPlanProperties();
  if (currentPlan) renderPlan(currentPlan);
}

(window as any).__obsAuthoredSelectionBridge = (ids: string[]) => {
  try { void import("./authoring").then((m) => m.setSelectedAuthored(ids, "replace")); } catch { /* optional */ }
};

function nearestAuthoredAt(hit: { x: number; z: number }): { element: any | null; distance: number } {
  const els = ((window as any).__obsAuthoredElements ?? []) as any[];
  let best: any = null;
  let bestD = 1.25; // meters � generous so thick ducts/walls are easy to click
  for (const el of els) {
    const p = el?.params ?? {};
    const half = Math.max(0.04, Number(p.thickness ?? p.width ?? 0.2) * 0.55);
    if (p.start && p.end) {
      const ax = p.start[0], az = p.start[1], bx = p.end[0], bz = p.end[1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((hit.x - ax) * dx + (hit.z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, pz = az + t * dz;
      const d = Math.hypot(hit.x - px, hit.z - pz) - half;
      if (d < bestD) { bestD = d; best = el; }
    } else if (p.point) {
      const d = Math.hypot(hit.x - p.point[0], hit.z - p.point[1]) - half;
      if (d < bestD) { bestD = d; best = el; }
    } else if (Array.isArray(p.polygon) && p.polygon.length) {
      // Point in / near polygon bbox
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const v of p.polygon) {
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minZ) minZ = v[1]; if (v[1] > maxZ) maxZ = v[1];
      }
      if (hit.x >= minX - half && hit.x <= maxX + half && hit.z >= minZ - half && hit.z <= maxZ + half) {
        const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
        const d = Math.hypot(hit.x - cx, hit.z - cz);
        if (d < bestD) { bestD = d; best = el; }
      }
    }
  }
  if (bestD > 0.85) return { element: null, distance: bestD };
  return { element: best, distance: Math.max(0, bestD) };
}



function linearBoundaryCandidate(el: any, point: { x: number; z: number }) {
  const p = el?.params ?? {};
  if (!p.start || !p.end) return null;
  const [ax, az] = p.start, [bx, bz] = p.end;
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) return null;
  const ux = dx / L, uz = dz / L;
  const nx = -uz, nz = ux;
  const half = Math.max(0.01, Number(p.thickness ?? p.width ?? 0.2) / 2);
  const qx = point.x - ax, qz = point.z - az;
  const tRaw = (qx * ux + qz * uz) / L;
  const nRaw = qx * nx + qz * nz;
  const t = Math.max(0, Math.min(1, tRaw));
  const sideT = Math.max(0, Math.min(1, tRaw));
  const sideLeft = { x: ax + ux * (sideT * L) + nx * half, z: az + uz * (sideT * L) + nz * half };
  const sideRight = { x: ax + ux * (sideT * L) - nx * half, z: az + uz * (sideT * L) - nz * half };
  const startN = Math.max(-half, Math.min(half, nRaw));
  const startPt = { x: ax + nx * startN, z: az + nz * startN };
  const endPt = { x: bx + nx * startN, z: bz + nz * startN };
  const cands = [
    { point: sideLeft, distance: Math.hypot(point.x - sideLeft.x, point.z - sideLeft.z), ref: { elementId: String(el.id), kind: "linear-side" as const, t: sideT, side: "left" as const } },
    { point: sideRight, distance: Math.hypot(point.x - sideRight.x, point.z - sideRight.z), ref: { elementId: String(el.id), kind: "linear-side" as const, t: sideT, side: "right" as const } },
    { point: startPt, distance: Math.hypot(point.x - startPt.x, point.z - startPt.z), ref: { elementId: String(el.id), kind: "linear-cap" as const, t: 0, n: startN, side: "start" as const } },
    { point: endPt, distance: Math.hypot(point.x - endPt.x, point.z - endPt.z), ref: { elementId: String(el.id), kind: "linear-cap" as const, t: 1, n: startN, side: "end" as const } },
  ];
  cands.sort((a,b)=>a.distance-b.distance);
  return cands[0] ?? null;
}

function pointBoundaryCandidate(el: any, point: { x: number; z: number }) {
  const p = el?.params ?? {};
  if (!p.point) return null;
  const cx = Number(p.point[0]), cz = Number(p.point[1]);
  const halfW = Math.max(0.01, Number(p.width ?? p.thickness ?? 0.3) / 2);
  const halfD = Math.max(0.01, Number(p.depth ?? p.thickness ?? p.width ?? 0.3) / 2);
  const cands = [
    { point: {x: cx-halfW,z: cz}, distance: Math.hypot(point.x-(cx-halfW),point.z-cz), ref: {elementId:String(el.id),kind:"point-edge" as const,dx:-halfW,dz:0,side:"left" as const}},
    { point: {x: cx+halfW,z: cz}, distance: Math.hypot(point.x-(cx+halfW),point.z-cz), ref: {elementId:String(el.id),kind:"point-edge" as const,dx:halfW,dz:0,side:"right" as const}},
    { point: {x: cx,z: cz-halfD}, distance: Math.hypot(point.x-cx,point.z-(cz-halfD)), ref: {elementId:String(el.id),kind:"point-edge" as const,dx:0,dz:-halfD,side:"bottom" as const}},
    { point: {x: cx,z: cz+halfD}, distance: Math.hypot(point.x-cx,point.z-(cz+halfD)), ref: {elementId:String(el.id),kind:"point-edge" as const,dx:0,dz:halfD,side:"top" as const}},
    { point: {x: cx-halfW,z: cz-halfD}, distance: Math.hypot(point.x-(cx-halfW),point.z-(cz-halfD)), ref: {elementId:String(el.id),kind:"point-corner" as const,dx:-halfW,dz:-halfD}},
    { point: {x: cx+halfW,z: cz-halfD}, distance: Math.hypot(point.x-(cx+halfW),point.z-(cz-halfD)), ref: {elementId:String(el.id),kind:"point-corner" as const,dx:halfW,dz:-halfD}},
    { point: {x: cx+halfW,z: cz+halfD}, distance: Math.hypot(point.x-(cx+halfW),point.z-(cz+halfD)), ref: {elementId:String(el.id),kind:"point-corner" as const,dx:halfW,dz:halfD}},
    { point: {x: cx-halfW,z: cz+halfD}, distance: Math.hypot(point.x-(cx-halfW),point.z-(cz+halfD)), ref: {elementId:String(el.id),kind:"point-corner" as const,dx:-halfW,dz:halfD}},
  ];
  cands.sort((a,b)=>a.distance-b.distance);
  return cands[0] ?? null;
}

let __synthSnapCache: { at: number; els: any[] } | null = null;

/** Tab cycles through overlapping snap points under the cursor (reset when the cursor moves away). */
let planSnapCycle = 0;
let planSnapCycleAt: { x: number; z: number } | null = null;
function resetSnapCycleIfMoved(p: { x: number; z: number }): void {
  const tol = worldPerPixel() * 6;
  if (!planSnapCycleAt || Math.hypot(planSnapCycleAt.x - p.x, planSnapCycleAt.z - p.z) > tol) {
    planSnapCycle = 0;
    planSnapCycleAt = { x: p.x, z: p.z };
  }
}

function findDimensionBoundary(point: { x: number; z: number }) {
  const auth: any = (ctx.features as any).authoring;
  let els: any[] = [];
  try {
    if (auth?.getElements) els = auth.getElements();
  } catch { /* */ }
  if (!els.length) {
    els = ((window as any).__obsAuthoredElements ?? []) as any[];
  }

  if (!els.length && currentPlan && currentPlan.segments.length) {
    if (!__synthSnapCache || __synthSnapCache.at !== currentPlan.generatedAt) {
      const synth: any[] = [];
      let sid = 0;
      for (const seg of currentPlan.segments) {
        if (seg.kind === "grid") continue;
        synth.push({
          id: "synth-" + (sid++),
          type: "wall",
          name: "IFC segment",
          params: {
            start: [seg.x1, seg.z1],
            end: [seg.x2, seg.z2],
            height: 0,
            thickness: 0.15,
            elevation: 0,
          },
        });
      }
      __synthSnapCache = { at: currentPlan.generatedAt, els: synth };
    }
    els = __synthSnapCache.els;
  }

  if (els.length) {
    (window as any).__obsAuthoredElements = els;
  }

  if (!els.length) return null;

  const view = currentPlan;
  const zoomW = view ? ((view.bounds.maxX - view.bounds.minX) + 6) / currentZoom : 20;
  const pixelWorldTol = zoomW / 800;
  const featureTol = Math.max(0.15, pixelWorldTol * 14);

  const hit = findPlanFeatureSnap(els, point.x, point.z, featureTol, planSnapCycle);
  if (hit && hit.ref) {
    return {
      point: { x: hit.x, z: hit.z },
      ref: hit.ref,
      distance: hit.distance,
      kind: hit.kind,
      label: hit.label,
      color: hit.color,
      alt: hit.alt,
    };
  }

  let best: { point: { x: number; z: number }; ref: PlanDimensionRef; distance: number } | null = null;
  const tol = Math.max(0.18, 0.008 * Math.max(currentPlan?.bounds.maxX ?? 10, currentPlan?.bounds.maxZ ?? 10));
  for (const el of els) {
    if (!el?.id) continue;
    const c = el.params?.start && el.params?.end
      ? linearBoundaryCandidate(el, point)
      : pointBoundaryCandidate(el, point);
    if (!c || c.distance > tol) continue;
    if (!best || c.distance < best.distance) best = c as any;
  }
  if (!best && currentPlan) {
    for (const seg of currentPlan.segments) {
      if (seg.kind === "grid") continue;
      const ax = seg.x1, az = seg.z1, bx = seg.x2, bz = seg.z2;
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      let t = ((point.x - ax) * dx + (point.z - az) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const q = { x: ax + t * dx, z: az + t * dz };
      const d = Math.hypot(point.x - q.x, point.z - q.z);
      if (d <= tol && (!best || d < best.distance)) {
        best = { point: q, distance: d, ref: { kind: "static-boundary", x: q.x, z: q.z } as any };
      }
    }
  }
  return best;
}
function capturePlanDimensionRef(point: {x:number;z:number}): PlanDimensionRef | undefined {
  return findDimensionBoundary(point)?.ref;
}

function resolvePlanDimensionRef(ref?: PlanDimensionRef): {x:number;z:number} | null {
  if (!ref) return null;
  if (ref.kind === "static-boundary" && ref.x != null && ref.z != null) {
    return {x:Number(ref.x),z:Number(ref.z)};
  }
  if (!ref.elementId) return null;
  if (ref.kind === "polygon-vertex" || ref.kind === "hosted") {
    return resolveElementRef(ref as any, ((window as any).__obsAuthoredElements ?? []) as any[]);
  }
  const els=((window as any).__obsAuthoredElements ?? []) as any[];
  const el=els.find((e)=>String(e?.id)===String(ref.elementId));
  if (!el?.params) return null;
  const p=el.params;
  if (ref.kind === "linear-side" || ref.kind === "linear-cap") {
    if (!p.start || !p.end) return null;
    const [ax,az]=p.start,[bx,bz]=p.end;
    const dx=bx-ax,dz=bz-az,L=Math.hypot(dx,dz)||1;
    const ux=dx/L,uz=dz/L,nx=-uz,nz=ux;
    const half=Math.max(0.01,Number(p.thickness ?? p.width ?? 0.2)/2);
    if (ref.kind === "linear-side") {
      const t=Math.max(0,Math.min(1,Number(ref.t ?? 0)));
      const side=ref.side === "right" ? -1 : 1;
      return {x:ax+dx*t+nx*half*side,z:az+dz*t+nz*half*side};
    }
    const n=Math.max(-half,Math.min(half,Number(ref.n ?? 0)));
    const t=ref.side === "end" ? 1 : 0;
    return {x:ax+dx*t+nx*n,z:az+dz*t+nz*n};
  }
  if (p.point && ref.dx != null && ref.dz != null) {
    return {x:Number(p.point[0])+Number(ref.dx),z:Number(p.point[1])+Number(ref.dz)};
  }
  return null;
}

/** Dimension every column and wall: X and Y chains `offset` away from the model, plus overall rows. */
/** Picks for the interactive Auto Dimension (first edge, last edge). */
let planAutoPick: { p1?: { x: number; z: number; ref?: PlanDimensionRef }; p2?: { x: number; z: number; ref?: PlanDimensionRef }; axis?: "x" | "z" } | null = null;

function finishAutoRange(linePos?: number): void {
  const pk = planAutoPick;
  if (!pk?.p1 || !pk.p2 || !pk.axis) return;
  const auth: any = (ctx.features as any).authoring;
  const els: any[] = (auth?.getElements?.() ?? ((window as any).__obsAuthoredElements ?? [])) as any[];
  (window as any).__obsAuthoredElements = els;
  const res = buildRangeDimension(els, { axis: pk.axis, p1: pk.p1 as any, p2: pk.p2 as any, linePos, offset: 0.5, stack: 0.5 });
  planAutoPick = null;
  if (!res.length) { footerStatus("Auto Dimension: nothing between those edges - pick the first edge again"); return; }
  const beforeSnap = dimSnapshot();
  const cMain = newChainId(), cAll = newChainId();
  for (const r of res) {
    planDims.push({
      x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, style: "linear", offsetMm: DIM_OFFSET_MM,
      ref1: r.ref1 as PlanDimensionRef, ref2: r.ref2 as PlanDimensionRef,
      axis: r.axis, linePos: r.linePos, chainId: r.overall ? cAll : cMain,
    });
  }
  recordDims("Auto dimension", beforeSnap);
  if (currentPlan) renderPlan(currentPlan);
  const n = res.filter((r) => !r.overall).length;
  footerStatus(`Auto Dimension: ${n} dimension(s) + overall - pick the next first edge (Esc = Select)`);
}

function handleAutoDimClick(w: { x: number; z: number }): void {
  const hit = findDimensionBoundary(w);
  const pt = hit ? { x: hit.point.x, z: hit.point.z, ref: hit.ref as PlanDimensionRef } : { x: w.x, z: w.z };
  if (!planAutoPick || (!planAutoPick.p1)) {
    planAutoPick = { p1: pt };
    planDrawStart = { x: pt.x, z: pt.z };
    footerStatus("Auto Dimension: pick the LAST edge");
    return;
  }
  if (!planAutoPick.p2) {
    const dx = pt.x - planAutoPick.p1.x, dz = pt.z - planAutoPick.p1.z;
    if (Math.hypot(dx, dz) < 0.02) { footerStatus("Auto Dimension: last edge is the same as the first - pick another"); return; }
    planAutoPick.p2 = pt;
    planAutoPick.axis = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
    footerStatus(`Auto Dimension (${planAutoPick.axis === "x" ? "horizontal" : "vertical"}): click to place the dimension line, or Enter for 50 cm outside`);
    return;
  }
  finishAutoRange(planAutoPick.axis === "x" ? w.z : w.x);
  planDrawStart = null;
}

async function runAutoDimension(): Promise<void> {
  try {
    const raw = window.prompt("Auto Dimension - distance from the outermost column / wall (cm):", "50");
    if (raw == null) return;
    const cm = parseFloat(raw);
    if (!Number.isFinite(cm) || cm < 0) { footerStatus("Auto Dimension: invalid distance"); return; }
    const auth: any = (ctx.features as any).authoring;
    const els: any[] = (auth?.getElements?.() ?? ((window as any).__obsAuthoredElements ?? [])) as any[];
    (window as any).__obsAuthoredElements = els;
    const res = buildAutoDimensions(els, { offset: cm / 100, stack: cm / 100, categories: ["column", "wall"] });
    if (!res.length) { footerStatus("Auto Dimension: no columns or walls found"); return; }
    const beforeSnap = dimSnapshot();
    for (let i = planDims.length - 1; i >= 0; i--) if (planDims[i].auto) planDims.splice(i, 1);
    const cids: Record<string, string> = {};
    for (const r of res) {
      const key = r.axis + (r.overall ? "o" : "");
      planDims.push({
        x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, style: "linear", offsetMm: DIM_OFFSET_MM,
        ref1: r.ref1 as PlanDimensionRef, ref2: r.ref2 as PlanDimensionRef,
        axis: r.axis, linePos: r.linePos, auto: true, chainId: (cids[key] ??= newChainId()),
      });
    }
    recordDims("Dimension all", beforeSnap);
    if (currentPlan) renderPlan(currentPlan);
    const nx = res.filter((r) => r.axis === "x" && !r.overall).length, nz = res.filter((r) => r.axis === "z" && !r.overall).length;
    footerStatus(`Auto Dimension: ${nx} X + ${nz} Y dimensions at ${cm} cm (plus overall rows)`);
    planMode = "select";
  } catch (err) {
    console.warn("[plan] auto dimension", err);
  }
}

function formatPlanDimension(meters: number, style = getDimensionStyle()): string {
  const factor = style.unit === "m" ? 1 : style.unit === "cm" ? 100 : 1000;
  const value = meters * factor;
  return value.toFixed(style.precision) + (style.unit === "mm" ? "" : ` ${style.unit}`);
}

/** BIM-like annotation paper scale: a 2.5 mm text at 1:100 is 0.25 m in model space. */
function paperMmToWorld(mm: number): number {
  return (Math.max(0.1, mm) / 1000) * Math.max(1, planViewScale);
}

function dimensionWorldTextSize(style = getDimensionStyle()): number {
  return paperMmToWorld(style.textSize);
}

function dimensionWorldStroke(style = getDimensionStyle()): number {
  return Math.max(0.0015, paperMmToWorld(style.textSize * 0.18));
}

function makeSvgText(x: number, y: number, text: string, style: DimensionStyle, _dimScale: number): SVGTextElement {
  const lab = document.createElementNS("http://www.w3.org/2000/svg", "text");
  lab.setAttribute("x", String(x)); lab.setAttribute("y", String(y));
  lab.setAttribute("fill", style.color);
  lab.setAttribute("font-size", String(dimensionWorldTextSize(style)));
  lab.setAttribute("font-family", "Arial, system-ui, sans-serif");
  lab.setAttribute("font-weight", "500");
  lab.setAttribute("text-anchor", "middle");
  lab.setAttribute("dominant-baseline", "middle");
  lab.textContent = text;
  return lab;
}

function renderTemporaryDimensions(g: SVGGElement, dimScale: number, b: any) {
  const el = (window as any).__obsPlanSelectedEl;
  if (!el || !el.params) return;
  const style = getDimensionStyle();
  const p = el.params;
  const drawTemp = (x1:number,z1:number,x2:number,z2:number,offset:number) => {
    const dx=x2-x1, dz=z2-z1, len=Math.hypot(dx,dz); if(len<1e-6)return;
    const ux=dx/len, uz=dz/len, nx=-uz, nz=ux;
    const a0x=x1+nx*offset,a0z=z1+nz*offset,a1x=x2+nx*offset,a1z=z2+nz*offset;
    const a=screen(a0x,a0z), bb=screen(a1x,a1z);
    const sw=dimensionWorldStroke(style);
    const wl1=document.createElementNS("http://www.w3.org/2000/svg","line");
    const p0=screen(x1,z1), q0=screen(a0x,a0z);
    wl1.setAttribute("x1",String(p0.x));wl1.setAttribute("y1",String(p0.y));wl1.setAttribute("x2",String(q0.x));wl1.setAttribute("y2",String(q0.y));wl1.setAttribute("stroke",style.color);wl1.setAttribute("stroke-width",String(sw*0.65));wl1.setAttribute("opacity","0.6");g.appendChild(wl1);
    const wl2=wl1.cloneNode() as SVGLineElement; const p1=screen(x2,z2), q1=screen(a1x,a1z);
    wl2.setAttribute("x1",String(p1.x));wl2.setAttribute("y1",String(p1.y));wl2.setAttribute("x2",String(q1.x));wl2.setAttribute("y2",String(q1.y)); g.appendChild(wl2);
    const dl=document.createElementNS("http://www.w3.org/2000/svg","line"); dl.setAttribute("x1",String(a.x));dl.setAttribute("y1",String(a.y));dl.setAttribute("x2",String(bb.x));dl.setAttribute("y2",String(bb.y));dl.setAttribute("stroke",style.color);dl.setAttribute("stroke-width",String(sw));dl.setAttribute("stroke-dasharray","0.16 0.12");dl.setAttribute("opacity","0.72");g.appendChild(dl);
    const mid=screen((a0x+a1x)/2+nx*0.14,(a0z+a1z)/2+nz*0.14);
    g.appendChild(makeSvgText(mid.x,mid.y,formatPlanDimension(len),style,dimScale));
  };
  if(p.start && p.end){
    drawTemp(p.start[0],p.start[1],p.end[0],p.end[1],paperMmToWorld(16));
  } else if (p.point) {
    const x=p.point[0],z=p.point[1];
    const w=Number(p.width ?? p.thickness ?? 0.3), d=Number(p.depth ?? p.thickness ?? 0.3);
    drawTemp(x-w/2,z,x+w/2,z,paperMmToWorld(16));
    drawTemp(x,z-d/2,x,z+d/2,paperMmToWorld(20));
  }
  void b;
}


/* -------------------------------------------------------------------------
   Header controls
   ------------------------------------------------------------------------- */
const levelSelect = document.createElement("select");
levelSelect.className = "obs-input";
levelSelect.style.cssText =
  "padding:5px 9px;background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui;min-width:160px";

const cutSlider = document.createElement("input");
cutSlider.type = "range";
cutSlider.min = "0.5";
cutSlider.max = "3";
cutSlider.step = "0.1";
cutSlider.value = "1.2";
cutSlider.style.cssText = "width:120px";

const cutLabel = document.createElement("span");
cutLabel.style.cssText = "font:11px system-ui;color:var(--text-tertiary,#6b7280);min-width:80px";
cutLabel.textContent = "Cut: 1.20 m";

let cutHeight = 1.2;

function compactSelect(options: Array<[string, string]>, width = 150): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.style.cssText = `padding:5px 7px;background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);border-radius:4px;color:var(--text-primary,#e8eaf0);font:11px system-ui;max-width:${width}px`;
  for (const [value, label] of options) {
    const o = document.createElement("option"); o.value = value; o.textContent = label; sel.appendChild(o);
  }
  return sel;
}

const scaleSelect = compactSelect([["50", "1 : 50"], ["100", "1 : 100"], ["200", "1 : 200"], ["500", "1 : 500"]], 90);
scaleSelect.value = String(planViewScale);
scaleSelect.title = "View Scale";
scaleSelect.onchange = () => {
  planViewScale = Number(scaleSelect.value) || 100;
  try { localStorage.setItem(PLAN_SCALE_KEY, String(planViewScale)); } catch {}
  renderPlanProperties();
  if (currentPlan) renderPlan(currentPlan);
  footerStatus(`View Scale 1:${planViewScale} � annotation/dimension graphics updated`);
};

const dimTypeSelect = compactSelect(DEFAULT_DIMENSION_STYLES.map((d) => [d.id, d.name]), 190);
dimTypeSelect.value = activeDimensionStyleId;
dimTypeSelect.title = "Dimension Type";
dimTypeSelect.onchange = () => {
  activeDimensionStyleId = dimTypeSelect.value;
  try { localStorage.setItem(DIM_STYLE_KEY, activeDimensionStyleId); } catch { /* */ }
  planDimPendingRefs = null;
  if (currentPlan) renderPlan(currentPlan);
  footerStatus(`Dimension type: ${getDimensionStyle().name}`);
};

const chainDimLabel = document.createElement("label");
chainDimLabel.style.cssText = "display:flex;align-items:center;gap:4px;font:11px system-ui;color:#94a3b8;cursor:pointer;white-space:nowrap;padding:0 4px";
chainDimLabel.title = "Chain dimension - previous end becomes next start";
const chainDimInput = document.createElement("input");
chainDimInput.type = "checkbox";
chainDimInput.checked = false;
chainDimInput.style.cssText = "margin:0;cursor:pointer;accent-color:#38bdf8";
chainDimInput.onchange = () => {
  planDimChain = chainDimInput.checked;
  planDimChainPts = [];
  planDrawStart = null; planDimStartRef = null; planDimPendingRefs = null;
  footerStatus(planDimChain ? "Chain dimension ON - pick all boundaries, then click empty space to place the chain" : "Chain dimension OFF");
};
chainDimLabel.append(chainDimInput, document.createTextNode("Chain"));

const unitSelect = compactSelect([["mm", "mm"], ["cm", "cm"], ["m", "m"]], 60);
unitSelect.value = getDimensionStyle().unit;
unitSelect.title = "Dimension Units";
unitSelect.onchange = () => {
  const style = getDimensionStyle();
  style.unit = unitSelect.value as DimensionUnit;
  if (currentPlan) renderPlan(currentPlan);
};

const btn = (label: string, onclick: () => void, primary = false) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    `padding:6px 12px;border-radius:5px;cursor:pointer;font:12px system-ui;` +
    (primary
      ? "background:var(--accent,#38bdf8);color:#0b0d12;border:1px solid var(--accent,#38bdf8)"
      : "background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a)");
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
};

const renderBtn = btn("? Regenerate", () => void regenerate(), true);
const cadBtn = btn("?? Link CAD", () => void linkCadUnderlay());
const clearCadBtn = btn("Clear CAD", () => clearCadUnderlay());
const printBtn = btn("?? Print", () => printPlan());
const exportBtn = btn("? SVG", () => exportSvg());
const closeBtn = btn("? Close", () => togglePlanView());

/* -- Plan modeling state (tools come from ribbon tabs only) -- */
type PlanMode = "pan" | "select" | "navigate" | "move" | "linear" | "point" | "dim" | "tag" | "text";
type LinearKind = "wall" | "beam" | "strip" | "duct" | "pipe" | "cable-tray" | "conduit" | "mline" | "brace" | "truss";
type PointKind = "column" | "footing" | "equipment";

let planMode: PlanMode = "select";
let planViewUserAdjusted = false;
/** 2D box selection (window / crossing) */
let planBoxDragging = false;
let planBoxStart: { x: number; y: number; wx: number; wz: number } | null = null;
let planBoxCur: { x: number; y: number } | null = null;
let planBoxOverlay: SVGRectElement | null = null;
/** Move tool drag */
let planMoveDragging = false;
let planMoveLast: { x: number; z: number } | null = null;

let planLinearType: LinearKind = "wall";
let planPointType: PointKind = "column";
let planPointPreset: string | null = null;
let planDrawStart: { x: number; z: number } | null = null;
let planDimStartRef: PlanDimensionRef | null = null;
/** Continuous path like BIM Place Duct / Wall (click�click�click�). */
let planChain: { x: number; z: number }[] = [];
let planCursor: { x: number; z: number } | null = null;
let __planCursorOverlay: HTMLDivElement | null = null;
let __planCursorSvg: SVGSVGElement | null = null;
let __lastSnapKind = "";
let planSnap: { x: number; z: number; kind: string; label?: string; ref?: PlanDimensionRef } | null = null;
/** Placement options bar (BIM Modify | Place �). */
let planWidth = 0.3;   // m � duct/wall thickness in plan
let planHeight = 0.3;  // m � extrusion height
let planElevOffset = 0; // m above level

type PlanBoundaryKind = "linear-side" | "linear-cap" | "point-edge" | "point-corner" | "static-boundary" | "polygon-vertex" | "hosted";

export interface PlanDimensionRef {
  elementId?: string;
  x?: number;
  z?: number;
  kind: PlanBoundaryKind;
  /** For linear-side/linear-cap references: normalized position along element. */
  t?: number;
  /** For linear-cap references: offset across the end cap, in world metres. */
  n?: number;
  /** For point-edge/corner references: local boundary offset. */
  dx?: number;
  dz?: number;
  side?: "left" | "right" | "start" | "end" | "top" | "bottom";
  /** polygon-vertex: vertex index; hosted: -1 left jamb, 0 centre, 1 right jamb. */
  index?: number;
}
/** BIM dimension kinds � placement sequence differs per style. */
type PlanDimKind =
  | "aligned"      // 2 refs: distance along connecting line
  | "linear"       // 2 refs: force H or V
  | "angular"      // 2 segments: interior angle at intersection
  | "radial"       // center + edge: R = �
  | "diameter"     // edge through center: ? = �
  | "arc"          // 2 points along arc length
  | "auto"         // pick first + last edge: dimension every wall / column / door / window between
  | "elevation"    // 1 click: spot elevation
  | "coordinate";  // 1 click: spot X / Z

interface PlanDimension {
  x1: number; z1: number; x2: number; z2: number;
  style: PlanDimKind;
  /** Stored in paper mm so changing the view scale also changes annotation scale. */
  offsetMm?: number;
  ref1?: PlanDimensionRef;
  ref2?: PlanDimensionRef;
  /** Angular: degrees; Radial/Diameter: radius metres; Arc: arc length metres */
  value?: number;
  /** Spot labels override numeric format */
  label?: string;
  /** Angular vertex (intersection) when known */
  vx?: number;
  vz?: number;
  /** Auto-dimension chains: "x" = horizontal line at z=linePos, "z" = vertical line at x=linePos. */
  axis?: "x" | "z";
  linePos?: number;
  /** Fixed dimension line (chain placement): endpoints are projections onto this infinite line. */
  fixedLine?: { ox: number; oz: number; ux: number; uz: number };
  auto?: boolean;
  /** Segments placed together (chain) share an id: selecting one drags the whole chain. */
  chainId?: string;
  /** Text typed by the user instead of the measured value. */
  textOverride?: string;
  /** Equality display: segments of the chain show "EQ" while they are all equal (Revit). */
  eq?: boolean;
}
const planDims: PlanDimension[] = [];
let planDimSel: PlanDimension | null = null;
let planDimDrag: { members: PlanDimension[]; before: string; moved: boolean; sx: number; sy: number } | null = null;
const newChainId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function dimSnapshot(): string { return JSON.stringify(planDims); }
function restoreDims(json: string): void {
  planDims.length = 0;
  try { planDims.push(...(JSON.parse(json) as PlanDimension[])); } catch { /* */ }
  planDimSel = null;
  if (currentPlan) renderPlan(currentPlan);
}
/** Register an undo step for a dimension change that already happened. */
function recordDims(label: string, before: string): void {
  const after = dimSnapshot();
  if (before === after) return;
  try {
    planHistory.push({ label, apply: () => restoreDims(after), revert: () => restoreDims(before) });
  } catch { /* history optional */ }
  markPlanDimsDirty();
}
function markPlanDimsDirty(): void { try { import("../modules/projects/projects").then((m: any) => m.markDirty?.()); } catch { /* */ } }

/** Persist plan dimensions in the project document. */
(window as any).__obsPlanDims = {
  serialize: () => JSON.parse(JSON.stringify(planDims)),
  load: (arr: unknown) => {
    planDims.length = 0;
    if (Array.isArray(arr)) planDims.push(...(arr as PlanDimension[]));
    planDimSel = null;
    if (currentPlan) renderPlan(currentPlan);
  },
};

try {
  const pend = (window as any).__obsPendingPlanDims;
  if (Array.isArray(pend)) { planDims.push(...(pend as PlanDimension[])); (window as any).__obsPendingPlanDims = undefined; }
} catch { /* */ }

function resolvedDimPoints(d: PlanDimension): { p1: { x: number; z: number }; p2: { x: number; z: number } } {
  const r1 = resolvePlanDimensionRef(d.ref1), r2 = resolvePlanDimensionRef(d.ref2);
  return { p1: { x: r1?.x ?? d.x1, z: r1?.z ?? d.z1 }, p2: { x: r2?.x ?? d.x2, z: r2?.z ?? d.z2 } };
}
function dimEndsFor(d: PlanDimension) {
  const { p1, p2 } = resolvedDimPoints(d);
  return dimLineEnds(d, p1, p2, paperMmToWorld(d.offsetMm ?? DIM_OFFSET_MM));
}
function worldPerPixel(): number {
  const rect = canvasWrap.getBoundingClientRect();
  if (!currentPlan || rect.width < 1) return 0.02;
  const b = currentPlan.bounds;
  return (((b.maxX - b.minX) + 6) / currentZoom) / rect.width;
}
/** Topmost dimension within ~7 px of a world point. */
function hitDimension(wx: number, wz: number): PlanDimension | null {
  const tol = worldPerPixel() * 7;
  const pt = { x: wx, z: wz };
  for (let i = planDims.length - 1; i >= 0; i--) {
    const d = planDims[i];
    const ends = dimEndsFor(d);
    if (ends) {
      if (distToSegment(pt, ends.a, ends.b) <= tol) return d;
      const mid = { x: (ends.a.x + ends.b.x) / 2, z: (ends.a.z + ends.b.z) / 2 };
      if (Math.hypot(pt.x - mid.x, pt.z - mid.z) <= tol * 3) return d;
    } else if (d.style === "radial" || d.style === "diameter" || d.style === "arc") {
      if (distToSegment(pt, { x: d.x1, z: d.z1 }, { x: d.x2, z: d.z2 }) <= tol) return d;
    } else if (Math.hypot(pt.x - d.x1, pt.z - d.z1) <= tol * 2) return d;
  }
  return null;
}
/** Length of a linear / aligned dimension along its dimension line. */
function dimLength(d: PlanDimension): number {
  const e = dimEndsFor(d);
  return e ? Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) : 0;
}
/** True when the chain has equality display on and every segment is the same length (within 1 mm). */
function dimShowsEq(d: PlanDimension): boolean {
  if (!d.eq || !d.chainId) return false;
  const segs = planDims.filter((x) => x.chainId === d.chainId);
  if (segs.length < 2) return false;
  const l0 = dimLength(segs[0]);
  return segs.every((x) => Math.abs(dimLength(x) - l0) < 0.001);
}
function dimMembers(d: PlanDimension): PlanDimension[] {
  return d.chainId ? planDims.filter((x) => x.chainId === d.chainId) : [d];
}
let planDimStyle: PlanDimKind = "aligned";
let planDimChain = false;
interface PlanDimPending {
  ref1: PlanDimensionRef;
  ref2: PlanDimensionRef;
  x1: number; z1: number; x2: number; z2: number;
  kind: PlanDimKind;
}
let planDimPendingRefs: PlanDimPending | null = null;
/** Chain dimension: boundaries picked so far. Nothing is drawn as a dimension until the line location is clicked. */
let planDimChainPts: { x: number; z: number; ref: PlanDimensionRef }[] = [];

function cancelDimChain(): void {
  planDimChainPts = [];
  if (currentPlan) renderPlan(currentPlan);
}

/** Commit the picked chain on one dimension line. `at` = clicked location; undefined = default paper offset. */
function finishDimChain(at?: { x: number; z: number }): void {
  const pts = planDimChainPts;
  if (pts.length < 2) { footerStatus("Chain: pick at least two boundaries first"); return; }
  const linear = planDimStyle === "linear";
  const a = pts[0], b = pts[1];
  let line: { ox: number; oz: number; ux: number; uz: number };
  if (linear) {
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    if (horizontal) {
      const z = at ? at.z : Math.min(...pts.map((q) => q.z)) - paperMmToWorld(DIM_OFFSET_MM);
      line = { ox: 0, oz: z, ux: 1, uz: 0 };
    } else {
      const x = at ? at.x : Math.min(...pts.map((q) => q.x)) - paperMmToWorld(DIM_OFFSET_MM);
      line = { ox: x, oz: 0, ux: 0, uz: 1 };
    }
  } else {
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, nx = -uz, nz = ux;
    const off = at ? (at.x - a.x) * nx + (at.z - a.z) * nz : paperMmToWorld(DIM_OFFSET_MM);
    line = { ox: a.x + nx * off, oz: a.z + nz * off, ux, uz };
  }
  let made = 0;
  const beforeSnap = dimSnapshot();
  const chainId = newChainId();
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.abs((q.x - p.x) * line.ux + (q.z - p.z) * line.uz);
    if (len < 0.001) continue;
    planDims.push({
      x1: p.x, z1: p.z, x2: q.x, z2: q.z, style: linear ? "linear" : "aligned",
      offsetMm: DIM_OFFSET_MM, ref1: p.ref, ref2: q.ref, fixedLine: { ...line }, chainId,
    });
    made++;
  }
  recordDims("Chain dimension", beforeSnap);
  planDimChainPts = [];
  planDrawStart = null; planDimStartRef = null; planDimPendingRefs = null;
  if (currentPlan) renderPlan(currentPlan);
  footerStatus(`Chain: ${made} dimension(s) placed - pick the first boundary of the next chain (Esc = Select)`);
}
/** Angular placement: first segment endpoints */
let planDimSeg1: { x1: number; z1: number; x2: number; z2: number } | null = null;
const DIM_OFFSET_MM = 12; // paper-space offset from geometry; converted by view scale

interface PlanTag {
  x: number;
  z: number;
  text: string;
  elementId?: string;
  leader?: boolean;
  mode?: TagMode;
}
interface PlanNote { x: number; z: number; text: string; width?: number }

const planTags: PlanTag[] = [];
const planNotes: PlanNote[] = [];

// ── Annotation editing: select / drag / edit / delete / undo / save ──
type PlanAnno = { kind: "tag"; obj: PlanTag } | { kind: "note"; obj: PlanNote };
let planAnnoSel: PlanAnno | null = null;
let planAnnoDrag: { sel: PlanAnno; dx: number; dz: number; before: string; moved: boolean; sx: number; sy: number } | null = null;

function annoSnapshot(): string { return JSON.stringify({ tags: planTags, notes: planNotes }); }
function restoreAnno(json: string): void {
  try {
    const o = JSON.parse(json);
    planTags.length = 0; planTags.push(...(o.tags ?? []));
    planNotes.length = 0; planNotes.push(...(o.notes ?? []));
  } catch { /* */ }
  planAnnoSel = null;
  if (currentPlan) renderPlan(currentPlan);
}
function recordAnno(label: string, before: string): void {
  const after = annoSnapshot();
  if (before === after) return;
  try { planHistory.push({ label, apply: () => restoreAnno(after), revert: () => restoreAnno(before) }); } catch { /* */ }
  try { import("../modules/projects/projects").then((m: any) => m.markDirty?.()); } catch { /* */ }
}
(window as any).__obsPlanAnno = {
  serialize: () => JSON.parse(annoSnapshot()),
  load: (o: any) => {
    planTags.length = 0; planNotes.length = 0;
    if (o && typeof o === "object") { planTags.push(...(o.tags ?? [])); planNotes.push(...(o.notes ?? [])); }
    planAnnoSel = null;
    if (currentPlan) renderPlan(currentPlan);
  },
};
try {
  const pend = (window as any).__obsPendingPlanAnno;
  if (pend) { planTags.push(...(pend.tags ?? [])); planNotes.push(...(pend.notes ?? [])); (window as any).__obsPendingPlanAnno = undefined; }
} catch { /* */ }

const TAG_H = () => paperMmToWorld(3.0);
const NOTE_H = () => paperMmToWorld(2.5);
function authoredEls(): any[] { return ((window as any).__obsAuthoredElements ?? []) as any[]; }
/** Tag text follows the element (Mark, size, elevation...) unless it is a free-text tag. */
function liveTagText(t: PlanTag): string {
  if (t.elementId && t.mode && t.mode !== "custom") {
    const el = authoredEls().find((e) => String(e?.id) === String(t.elementId));
    if (el) return tagLabel(el, t.mode);
  }
  return t.text;
}
function annoBox(a: PlanAnno) {
  return a.kind === "tag"
    ? textBox(a.obj.x, a.obj.z, liveTagText(a.obj), TAG_H())
    : textBox(a.obj.x, a.obj.z, a.obj.text, NOTE_H());
}
function hitAnnotation(wx: number, wz: number): PlanAnno | null {
  const pad = worldPerPixel() * 5;
  for (let i = planNotes.length - 1; i >= 0; i--) {
    const a: PlanAnno = { kind: "note", obj: planNotes[i] };
    if (pointInBox(wx, wz, annoBox(a), pad)) return a;
  }
  for (let i = planTags.length - 1; i >= 0; i--) {
    const a: PlanAnno = { kind: "tag", obj: planTags[i] };
    if (pointInBox(wx, wz, annoBox(a), pad)) return a;
  }
  return null;
}
function runTagAll(): void {
  const raw = window.prompt("Tag All - label:\n1 = Mark / Name\n2 = Size\n3 = Elevation\n4 = Material", "1");
  if (raw == null) return;
  const mode: TagMode = ({ "1": "category", "2": "size", "3": "elevation", "4": "material" } as Record<string, TagMode>)[raw.trim()] ?? "category";
  const els = authoredEls();
  const only = planSelectedIds.size ? [...planSelectedIds] : undefined;
  const before = annoSnapshot();
  const added = buildTagAll(els, planTags, { mode, only });
  if (!added.length) { footerStatus("Tag All: nothing new to tag"); return; }
  planTags.push(...added);
  recordAnno("Tag all", before);
  if (currentPlan) renderPlan(currentPlan);
  footerStatus(`Tag All: ${added.length} tag(s) placed${only ? " (selection)" : ""} - drag a tag to move it, double-click to edit, Delete to remove`);
}

const SNAP_TOL = 0.35; // meters

/** Nearest authored linear segment for Angular / Arc dimension picks. */
function findNearestSegment(point: { x: number; z: number }, tol = 0.8): {
  x1: number; z1: number; x2: number; z2: number; elementId?: string; distance: number;
} | null {
  const els = ((window as any).__obsAuthoredElements ?? []) as any[];
  let best: { x1: number; z1: number; x2: number; z2: number; elementId?: string; distance: number } | null = null;
  for (const el of els) {
    const p = el?.params;
    if (!p?.start || !p?.end) continue;
    const ax = p.start[0], az = p.start[1], bx = p.end[0], bz = p.end[1];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    let t = ((point.x - ax) * dx + (point.z - az) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    const d = Math.hypot(point.x - px, point.z - pz);
    if (d <= tol && (!best || d < best.distance)) {
      best = { x1: ax, z1: az, x2: bx, z2: bz, elementId: String(el.id), distance: d };
    }
  }
  // Fallback: plan segments (IFC cut)
  if (currentPlan) {
    for (const s of currentPlan.segments) {
      const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
      const L2 = dx * dx + dz * dz || 1;
      let t = ((point.x - s.x1) * dx + (point.z - s.z1) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = s.x1 + t * dx, pz = s.z1 + t * dz;
      const d = Math.hypot(point.x - px, point.z - pz);
      if (d <= tol && (!best || d < best.distance)) {
        best = { x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2, distance: d };
      }
    }
  }
  return best;
}

function segmentAngleDeg(s1: { x1: number; z1: number; x2: number; z2: number },
                         s2: { x1: number; z1: number; x2: number; z2: number }): {
  deg: number; vx: number; vz: number;
} {
  const a1 = Math.atan2(s1.z2 - s1.z1, s1.x2 - s1.x1);
  const a2 = Math.atan2(s2.z2 - s2.z1, s2.x2 - s2.x1);
  let deg = Math.abs((a2 - a1) * 180 / Math.PI);
  if (deg > 180) deg = 360 - deg;
  // Approximate vertex: midpoint of closest endpoints
  const ends1 = [{ x: s1.x1, z: s1.z1 }, { x: s1.x2, z: s1.z2 }];
  const ends2 = [{ x: s2.x1, z: s2.z1 }, { x: s2.x2, z: s2.z2 }];
  let bestD = Infinity, vx = (s1.x1 + s1.x2) / 2, vz = (s1.z1 + s1.z2) / 2;
  for (const p of ends1) for (const q of ends2) {
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d < bestD) { bestD = d; vx = (p.x + q.x) / 2; vz = (p.z + q.z) / 2; }
  }
  return { deg, vx, vz };
}

function findNearestPointElement(point: { x: number; z: number }, tol = 1.0): {
  x: number; z: number; elev: number; elementId?: string; distance: number;
} | null {
  const els = ((window as any).__obsAuthoredElements ?? []) as any[];
  let best: { x: number; z: number; elev: number; elementId?: string; distance: number } | null = null;
  for (const el of els) {
    const p = el?.params;
    if (p?.point) {
      const d = Math.hypot(point.x - p.point[0], point.z - p.point[1]);
      if (d <= tol && (!best || d < best.distance)) {
        best = { x: p.point[0], z: p.point[1], elev: Number(p.elevation ?? p.point[2] ?? 0), elementId: String(el.id), distance: d };
      }
    } else if (p?.start && p?.end) {
      const mx = (p.start[0] + p.end[0]) / 2, mz = (p.start[1] + p.end[1]) / 2;
      const d = Math.hypot(point.x - mx, point.z - mz);
      if (d <= tol && (!best || d < best.distance)) {
        best = { x: mx, z: mz, elev: Number(p.elevation ?? 0), elementId: String(el.id), distance: d };
      }
    }
  }
  return best;
}


function collectSnapPoints(): { x: number; z: number; kind: string }[] {
  const pts: { x: number; z: number; kind: string }[] = [];
  if (!currentPlan) return pts;
  for (const s of currentPlan.segments) {
    pts.push({ x: s.x1, z: s.z1, kind: "End" });
    pts.push({ x: s.x2, z: s.z2, kind: "End" });
    pts.push({ x: (s.x1 + s.x2) / 2, z: (s.z1 + s.z2) / 2, kind: "Mid" });
  }
  // Grid 1 m
  const b = currentPlan.bounds;
  if (isFinite(b.minX)) {
    for (let x = Math.floor(b.minX) - 2; x <= Math.ceil(b.maxX) + 2; x++) {
      for (let z = Math.floor(b.minZ) - 2; z <= Math.ceil(b.maxZ) + 2; z++) {
        pts.push({ x, z, kind: "Grid" });
      }
    }
  }
  return pts;
}

function findPlanSnap(wx: number, wz: number): { x: number; z: number; kind: string } | null {
  const priority: Record<string, number> = { End: 0, Mid: 1, Ortho: 2, Grid: 3 };
  let best: { x: number; z: number; kind: string } | null = null;
  let bestScore = 1e9;
  const consider = (p: { x: number; z: number; kind: string }, tol: number) => {
    const d = Math.hypot(p.x - wx, p.z - wz);
    if (d > tol) return;
    const score = (priority[p.kind] ?? 5) * 10 + d;
    if (score < bestScore) { bestScore = score; best = p; }
  };
  for (const p of collectSnapPoints()) {
    const tol = p.kind === "Grid" ? 0.15 : SNAP_TOL;
    if (p.kind === "Grid") continue; // only grid near cursor via separate pass
    consider(p, tol);
  }
  // Ortho to start
  if (planDrawStart) {
    consider({ x: planDrawStart.x, z: wz, kind: "Ortho" }, SNAP_TOL);
    consider({ x: wx, z: planDrawStart.z, kind: "Ortho" }, SNAP_TOL);
  }
  // Grid only if nothing better
  if (!best) {
    const gx = Math.round(wx);
    const gz = Math.round(wz);
    consider({ x: gx, z: gz, kind: "Grid" }, 0.2);
  }
  return best;
}

const spacer = document.createElement("div");
spacer.style.cssText = "flex:1";

const toolHint = document.createElement("span");
toolHint.style.cssText = "font:11px system-ui;color:#94a3b8;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
toolHint.textContent = "Use Architecture / Annotate tabs to model � snaps ON";

/* BIM-like placement options: Width / Height / Elevation */
function numInput(label: string, value: number, onChange: (v: number) => void, step = 0.05) {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex;align-items:center;gap:4px;font:11px system-ui;color:#94a3b8";
  const span = document.createElement("span");
  span.textContent = label;
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = String(step);
  inp.value = String(value);
  inp.style.cssText =
    "width:64px;padding:3px 6px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;color:#e8eaf0;font:11px system-ui";
  inp.oninput = () => {
    const v = Number(inp.value);
    if (Number.isFinite(v) && v > 0) onChange(v);
  };
  wrap.append(span, inp);
  return wrap;
}
const widthInp = numInput("Width", planWidth * 1000, (v) => { planWidth = v / 1000; }, 5);
const heightInp = numInput("Height", planHeight * 1000, (v) => { planHeight = v / 1000; }, 5);
const elevInp = numInput("Elev", planElevOffset * 1000, (v) => { planElevOffset = v / 1000; }, 10);
const slopeInp = (() => {
  const w = numInput("Slope", 0, () => {}, 0.1);
  const inp = w.querySelector("input") as HTMLInputElement;
  inp.min = "-100"; inp.title = "Slope % for pipes/ducts/trays/conduits while drawing (+ rises toward the end, 0 = flat)";
  const apply = () => { void import("./authoring").then((a) => a.setDrawSlope(Number(inp.value) || 0)); };
  inp.oninput = apply; inp.onchange = apply;
  (w.querySelector("span") as HTMLElement).textContent = "Slope(%)";
  return w;
})();
// labels show mm like BIM
(widthInp.querySelector("span") as HTMLElement).textContent = "W(mm)";
(heightInp.querySelector("span") as HTMLElement).textContent = "H(mm)";
(elevInp.querySelector("span") as HTMLElement).textContent = "Elev(mm)";

/* Wall options � Location Line + Join (BIM Place Wall) */
const locSelect = document.createElement("select");
locSelect.title = "Location Line";
locSelect.style.cssText =
  "padding:3px 6px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;color:#e8eaf0;font:11px system-ui;max-width:140px";
const LOC_OPTS: [string, string][] = [
  ["wall-centerline", "Wall Centerline"],
  ["core-centerline", "Core Centerline"],
  ["finish-exterior", "Finish: Exterior"],
  ["finish-interior", "Finish: Interior"],
  ["core-exterior", "Core: Exterior"],
  ["core-interior", "Core: Interior"],
];
for (const [v, l] of LOC_OPTS) {
  const o = document.createElement("option");
  o.value = v; o.textContent = l;
  locSelect.appendChild(o);
}
locSelect.onchange = () => {
  void import("./authoring").then((m) => {
    m.setWallLocationLine?.(locSelect.value as any);
  });
};

const joinSelect = document.createElement("select");
joinSelect.title = "End / Join connection";
joinSelect.style.cssText = locSelect.style.cssText;
const JOIN_OPTS: [string, string][] = [
  ["allow", "Join: Allow"],
  ["disallow", "Join: Disallow"],
  ["extended", "Join: Extended"],
  ["chamfer", "Join: Chamfer"],
  ["butt", "Join: Butt"],
];
for (const [v, l] of JOIN_OPTS) {
  const o = document.createElement("option");
  o.value = v; o.textContent = l;
  joinSelect.appendChild(o);
}
joinSelect.onchange = () => {
  void import("./authoring").then((m) => {
    m.setWallJoinStatus?.(joinSelect.value as any);
  });
};

const chainChk = document.createElement("label");
chainChk.style.cssText = "display:flex;align-items:center;gap:4px;font:11px system-ui;color:#94a3b8";
const chainInput = document.createElement("input");
chainInput.type = "checkbox";
chainInput.checked = true;
chainInput.onchange = () => {
  void import("./authoring").then((m) => m.setWallChain?.(chainInput.checked));
};
chainChk.append(chainInput, document.createTextNode("Chain"));

const wallOptsWrap = document.createElement("div");
wallOptsWrap.style.cssText = "display:none;align-items:center;gap:6px";
// BIM Place Wall options order: Location Line ? Join Status ? Chain
wallOptsWrap.append(locSelect, joinSelect, chainChk);
locSelect.title = "Location Line (BIM)";
joinSelect.title = "Wall Join Status";
chainChk.title = "Chain � continuous wall path";

function showWallOpts(on: boolean) {
  wallOptsWrap.style.display = on ? "flex" : "none";
}

/* Professional international 2D modeling toolbar layout (BIM / ArchiCAD / AutoCAD style)
 * Groups: Identity | Level & Cut | Drawing scale & units | Active tool hint | Element params | Underlay & export
 */
function makeGroupLabel(text: string): HTMLElement {
  const w = document.createElement("span");
  w.style.cssText = "font:600 10px system-ui;letter-spacing:.4px;text-transform:uppercase;color:var(--text-tertiary,#6b7280);margin-right:2px;";
  w.textContent = text;
  return w;
}
function makeGroup(label: string, ...els: (HTMLElement | null)[]): HTMLElement {
  const g = document.createElement("div");
  g.style.cssText = "display:flex;align-items:center;gap:6px;padding:0 8px;border-right:1px solid var(--border-subtle,#2a2e3a);height:100%;";
  if (label) g.appendChild(makeGroupLabel(label));
  for (const el of els) if (el) g.appendChild(el);
  return g;
}

header.style.cssText =
  "display:flex;align-items:center;gap:0;padding:0 4px 0 8px;" +
  "background:var(--bg-surface,#12141b);border-bottom:1px solid var(--border-default,#2a2e3a);" +
  "height:40px;flex:none;overflow-x:auto;overflow-y:hidden;";

const titleEl = document.createElement("div");
titleEl.style.cssText = "font:700 12px system-ui;color:var(--text-primary,#e8eaf0);padding:0 10px 0 4px;white-space:nowrap;border-right:1px solid var(--border-subtle,#2a2e3a);height:100%;display:flex;align-items:center;";
titleEl.textContent = "Floor Plan";
titleEl.title = "2D Floor Plan � international BIM drafting environment";

header.append(
  titleEl,
  makeGroup("Level", levelSelect, cutSlider, cutLabel),
  makeGroup("Scale", scaleSelect, unitSelect),
  makeGroup("Dim", dimTypeSelect, chainDimLabel),
  makeGroup("", toolHint),
  makeGroup("Params", widthInp, heightInp, elevInp, slopeInp, wallOptsWrap),
  spacer,
  makeGroup("", cadBtn, clearCadBtn, renderBtn, printBtn, exportBtn, closeBtn),
);
// Remove trailing border on last group
const lastG = header.lastElementChild as HTMLElement | null;
if (lastG) lastG.style.borderRight = "none";

canvasWrap.style.background = "#ffffff";
overlay.style.background = "#1a1d27";

/* -- CAD / DWG underlay for tracing & modeling --------------------------- */
let cadUnderlayUrl: string | null = null;
let cadUnderlayOpacity = 0.45;
let cadUnderlayVisible = true;
let cadImageEl: SVGImageElement | null = null;

// Import the underlay snap module to store entity data for snap querying.
// This enables the "trace over DWG" workflow: walls snap to DWG endpoints.
import { storeUnderlayFromDxf, clearUnderlayData, setUnderlaySnapEnabled, isUnderlaySnapEnabled } from "./cad-underlay-snap";

async function loadCadFileAsUnderlay(file: File) {
  if (cadUnderlayUrl) URL.revokeObjectURL(cadUnderlayUrl);
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "dxf") {
    const text = await file.text();
    // Store entity data for snap querying (lines, polylines, circles).
    const snapCount = storeUnderlayFromDxf(text);
    console.log(`[plan] CAD underlay: ${snapCount} snap points stored for tracing`);
    const svgContent = dxfToSvgUnderlay(text);
    const blob = new Blob([svgContent], { type: "image/svg+xml" });
    cadUnderlayUrl = URL.createObjectURL(blob);
  } else if (ext === "svg" || file.type.includes("svg")) {
    cadUnderlayUrl = URL.createObjectURL(file);
  } else {
    cadUnderlayUrl = URL.createObjectURL(file);
  }
  cadUnderlayVisible = true;
  applyCadUnderlay();
  footerStatus(`CAD underlay linked: ${file.name} — trace walls/columns on top (snap enabled)`);
}

async function linkCadVector(file: File): Promise<boolean> {
  if (!/\.(dwg|dxf)$/i.test(file.name)) return false;
  const m = await import("../modules/cad-link");
  m.setupCadLinks();
  await m.linkCadFileInteractive(file);
  return true;
}

async function linkCadUnderlay() {
  try {
    const pending = (window as any).__obsPendingCadFile as File | undefined;
    if (pending && await linkCadVector(pending)) { (window as any).__obsPendingCadFile = null; return; }
    if (pending) {
      try {
        (window as any).__obsPendingCadFile = null;
        await loadCadFileAsUnderlay(pending);
        return;
      } catch (err) {
        console.error("[plan] pending CAD failed", err);
      }
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dwg,.dxf,.svg,.png,.jpg,.jpeg,.webp,.gif,image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (await linkCadVector(file)) return;
        await loadCadFileAsUnderlay(file);
      } catch (err) {
        console.error("[plan] CAD link failed", err);
        alert("Could not load CAD underlay. Use SVG, PNG, JPG, or DXF.");
      }
    };
    input.click();
  } catch (err) {
    console.error("[plan] CAD picker failed", err);
  }
}

try {
  (window as any).__obsAutoLinkCad = async (file: File) => {
    if (await linkCadVector(file)) return;
    await loadCadFileAsUnderlay(file);
  };
} catch { /* */ }

function clearCadUnderlay() {
  try {
    if (cadUnderlayUrl) URL.revokeObjectURL(cadUnderlayUrl);
    cadUnderlayUrl = null;
    cadImageEl?.remove();
    cadImageEl = null;
    clearUnderlayData();
    footerStatus("CAD underlay cleared (snap data removed)");
  } catch { /* */ }
}

try {
  window.addEventListener("obs:cad-links-changed", (ev) => {
    const added = (ev as CustomEvent).detail?.kind === "added";
    try {
      if (added) { planViewUserAdjusted = false; currentZoom = 1; panX = 0; panY = 0; }
      if (currentPlan && svg) renderPlan(currentPlan);
      // Plan not generated yet (opened on an empty model): build it so the CAD shows.
      else if (added && svg.isConnected) void regenerate();
    } catch { /* plan not open */ }
  });
} catch { /* */ }

function applyCadUnderlay() {
  if (!cadUnderlayUrl || !currentPlan) return;
  if (!cadUnderlayVisible) {
    cadImageEl?.remove();
    cadImageEl = null;
    return;
  }
  try {
    cadImageEl?.remove();
    const b = currentPlan.bounds;
    const pad = planCropView ? 0.5 : 3;
    const vbMinX = b.minX - pad;
    const vbMinY = -(b.maxZ + pad);
    const vbW = (b.maxX - b.minX) + 2 * pad;
    const vbH = (b.maxZ - b.minZ) + 2 * pad;

    const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
    img.setAttribute("href", cadUnderlayUrl);
    img.setAttribute("x", String(vbMinX));
    img.setAttribute("y", String(vbMinY));
    img.setAttribute("width", String(Math.max(vbW, 1)));
    img.setAttribute("height", String(Math.max(vbH, 1)));
    img.setAttribute("opacity", String(cadUnderlayOpacity));
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Insert behind geometry
    if (svg.firstChild) svg.insertBefore(img, svg.firstChild);
    else svg.appendChild(img);
    cadImageEl = img;
  } catch (err) {
    console.warn("[plan] apply underlay failed", err);
  }
}

/** Toggle underlay visibility on/off. Returns the new state. */
export function toggleUnderlayVisibility(): boolean {
  cadUnderlayVisible = !cadUnderlayVisible;
  applyCadUnderlay();
  footerStatus(`CAD underlay: ${cadUnderlayVisible ? "visible" : "hidden"}`);
  return cadUnderlayVisible;
}

/** Toggle snap-to-underlay on/off. Returns the new state. */
export function toggleUnderlaySnap(): boolean {
  const newState = !isUnderlaySnapEnabled();
  setUnderlaySnapEnabled(newState);
  footerStatus(`CAD underlay snap: ${newState ? "ON" : "OFF"}`);
  return newState;
}

/** Minimal DXF ? SVG converter for LINE and LWPOLYLINE (modeling underlay). */
function dxfToSvgUnderlay(dxf: string): string {
  const lines: string[] = [];
  const rows = dxf.split(/\r?\n/);
  let i = 0;
  const num = () => { i++; return parseFloat(rows[i] ?? "0") || 0; };
  const str = () => { i++; return (rows[i] ?? "").trim(); };

  while (i < rows.length) {
    const code = (rows[i] ?? "").trim();
    if (code === "0") {
      const entity = str();
      if (entity === "LINE") {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") x1 = num();
          else if (c === "20") y1 = num();
          else if (c === "11") x2 = num();
          else if (c === "21") y2 = num();
          else i++;
        }
        lines.push(`<line x1="${x1}" y1="${-y1}" x2="${x2}" y2="${-y2}" stroke="#334155" stroke-width="0.05"/>`);
      } else if (entity === "LWPOLYLINE" || entity === "POLYLINE") {
        const pts: [number, number][] = [];
        let closed = false;
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") {
            const x = num();
            // expect 20 next
            let y = 0;
            if ((rows[i + 1] ?? "").trim() === "20") { i++; y = num(); }
            pts.push([x, y]);
          } else if (c === "70") {
            closed = (num() & 1) === 1;
          } else i++;
        }
        if (pts.length >= 2) {
          const d = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p[0]} ${-p[1]}`).join(" ") + (closed ? " Z" : "");
          lines.push(`<path d="${d}" fill="none" stroke="#334155" stroke-width="0.05"/>`);
        }
      }
    }
    i++;
  }

  // Bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of lines) {
    const nums = L.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    for (let k = 0; k + 1 < nums.length; k += 2) {
      minX = Math.min(minX, nums[k]); maxX = Math.max(maxX, nums[k]);
      minY = Math.min(minY, nums[k + 1]); maxY = Math.max(maxY, nums[k + 1]);
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 10; maxY = 10; }
  const pad = 1;
  return `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}">
    <rect x="${minX - pad}" y="${minY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#f8fafc"/>
    ${lines.join("\n")}
  </svg>`;
}

function footerStatus(msg: string) {
  try {
    const el = footer.querySelector("[data-status]") as HTMLElement | null;
    if (el) el.textContent = msg;
    else {
      const s = document.createElement("span");
      s.dataset.status = "1";
      s.style.cssText = "color:#94a3b8;margin-left:8px";
      s.textContent = msg;
      footer.appendChild(s);
    }
  } catch { /* */ }
}

levelSelect.onchange = () => void regenerate();
cutSlider.oninput = () => {
  cutHeight = Number(cutSlider.value);
  cutLabel.textContent = `Cut: ${cutHeight.toFixed(2)} m`;
};
cutSlider.onchange = () => void regenerate();

function divider() {
  const d = document.createElement("div");
  d.style.cssText = "width:1px;height:22px;background:var(--border-default,#2a2e3a);";
  return d;
}

/* -------------------------------------------------------------------------
   SVG rendering
   ------------------------------------------------------------------------- */
const STYLE = {
  cut:       { stroke: "#111827", width: 2.2, dash: "" },
  overhead:  { stroke: "#6b7280", width: 1.0, dash: "6 4" },
  below:     { stroke: "#9ca3af", width: 0.8, dash: "3 4" },
  grid:      { stroke: "#b91c1c", width: 1.0, dash: "24 4 4 4" },
  dimension: { stroke: "#1d4ed8", width: 0.7, dash: "" },
  title:     { stroke: "#333",    width: 0.5, dash: "" },
};

function screen(x: number, z: number) {
  // Flip Z so north points up
  return { x, y: -z };
}

/** Map client mouse position ? world XZ on the plan. */
function clientToWorld(clientX: number, clientY: number): { x: number; z: number } | null {
  try {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    const sp = pt.matrixTransform(inv);
    // screen y is -worldZ
    return { x: sp.x, z: -sp.y };
  } catch {
    return null;
  }
}

function clientToPlan(e: { clientX: number; clientY: number }): { x: number; z: number } | null {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(m.inverse());
  return { x: p.x, z: -p.y };
}

/** Crop rectangle + drag handles, drawn in the plan SVG at true world coordinates. */
function renderCropUi(crop: ReturnType<typeof getCropRegion>, zoomedW: number): void {
  const NS = "http://www.w3.org/2000/svg";
  const ui = document.createElementNS(NS, "g");
  ui.setAttribute("data-obs-crop-ui", "1");
  const lw = Math.max(zoomedW / 900, 0.003);
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", String(crop.minX));
  rect.setAttribute("y", String(-crop.maxY));
  rect.setAttribute("width", String(crop.maxX - crop.minX));
  rect.setAttribute("height", String(crop.maxY - crop.minY));
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", "#0ea5e9");
  rect.setAttribute("stroke-width", String(lw));
  rect.setAttribute("stroke-dasharray", `${lw * 6} ${lw * 4}`);
  rect.setAttribute("pointer-events", "none");
  ui.appendChild(rect);
  svg.appendChild(ui);
  if (getActiveCropView() !== PLAN_CROP_ID) return;

  const hs = Math.max(zoomedW / 110, 0.01);
  const cx = (crop.minX + crop.maxX) / 2, cz = (crop.minY + crop.maxY) / 2;
  const defs: Array<[string, number, number, string]> = [
    ["nw", crop.minX, crop.maxY, "nwse-resize"], ["n", cx, crop.maxY, "ns-resize"], ["ne", crop.maxX, crop.maxY, "nesw-resize"],
    ["e", crop.maxX, cz, "ew-resize"], ["se", crop.maxX, crop.minY, "nwse-resize"], ["s", cx, crop.minY, "ns-resize"],
    ["sw", crop.minX, crop.minY, "nesw-resize"], ["w", crop.minX, cz, "ew-resize"],
  ];
  for (const [handle, x, z, cursor] of defs) {
    const h = document.createElementNS(NS, "rect");
    h.setAttribute("x", String(x - hs / 2));
    h.setAttribute("y", String(-z - hs / 2));
    h.setAttribute("width", String(hs));
    h.setAttribute("height", String(hs));
    h.setAttribute("fill", "#0ea5e9");
    h.setAttribute("stroke", "#075985");
    h.setAttribute("stroke-width", String(lw));
    h.style.cursor = cursor;
    h.addEventListener("pointerdown", (ev) => startCropDrag(ev, handle as any));
    ui.appendChild(h);
  }
  // Drag the body of a thin invisible strip along each edge = move whole region.
  const body = document.createElementNS(NS, "rect");
  body.setAttribute("x", String(crop.minX)); body.setAttribute("y", String(-crop.maxY));
  body.setAttribute("width", String(crop.maxX - crop.minX)); body.setAttribute("height", String(crop.maxY - crop.minY));
  body.setAttribute("fill", "transparent");
  body.setAttribute("pointer-events", "stroke");
  body.setAttribute("stroke", "transparent");
  body.setAttribute("stroke-width", String(hs));
  body.style.cursor = "move";
  body.addEventListener("pointerdown", (ev) => startCropDrag(ev, "move"));
  ui.insertBefore(body, ui.children[1]);
}

function startCropDrag(ev: PointerEvent, handle: Parameters<typeof dragCropHandle>[1]): void {
  ev.preventDefault();
  ev.stopPropagation();
  const p0 = clientToPlan(ev);
  if (!p0) return;
  const start = { ...getCropRegion(PLAN_CROP_ID) };
  const move = (e: PointerEvent) => {
    const p = clientToPlan(e);
    if (!p) return;
    const r = dragCropHandle(start, handle, p.x - p0.x, p.z - p0.z, 1);
    setCropRegion(PLAN_CROP_ID, {
      minX: snapCrop(r.minX), maxX: snapCrop(r.maxX), minY: snapCrop(r.minY), maxY: snapCrop(r.maxY),
    });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

try {
  onCropChanged(() => { try { if (currentPlan) renderPlan(currentPlan); } catch { /* plan not open */ } });
} catch { /* */ }


/** Revit-style Edit Boundary: drag vertices, drag edge midpoints to add vertices, Shift+click a vertex to delete it. */
function renderBoundaryUi(elId: string, zoomedW: number): void {
  const NS = "http://www.w3.org/2000/svg";
  const find = () => (((window as any).__obsAuthoredElements ?? []) as any[]).find((x) => x.id === elId);
  const el0 = find();
  if (!el0?.params?.polygon || el0.properties?.pinned) return;
  const hs = Math.max(zoomedW / 130, 0.01);
  const lw = Math.max(zoomedW / 900, 0.003);
  const ui = document.createElementNS(NS, "g");
  ui.setAttribute("data-obs-boundary-ui", "1");
  svg.appendChild(ui);

  const draw = (poly: Array<[number, number]>) => {
    ui.innerHTML = "";
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", poly.map((q, k) => `${k ? "L" : "M"}${q[0]} ${-q[1]}`).join(" ") + " Z");
    path.setAttribute("fill", "rgba(37,99,235,0.08)");
    path.setAttribute("stroke", "#2563eb");
    path.setAttribute("stroke-width", String(lw * 2));
    path.setAttribute("pointer-events", "none");
    ui.appendChild(path);
    poly.forEach((_, k) => {
      const m = edgeMidpoint(poly, k);
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(m[0])); c.setAttribute("cy", String(-m[1])); c.setAttribute("r", String(hs * 0.38));
      c.setAttribute("fill", "#ffffff"); c.setAttribute("stroke", "#2563eb"); c.setAttribute("stroke-width", String(lw));
      c.style.cursor = "copy";
      const t = document.createElementNS(NS, "title"); t.textContent = "Drag to add a vertex"; c.appendChild(t);
      c.addEventListener("pointerdown", (ev) => begin(ev, insertVertex(poly, k, m), k + 1, true));
      ui.appendChild(c);
    });
    poly.forEach((q, k) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(q[0] - hs / 2)); r.setAttribute("y", String(-q[1] - hs / 2));
      r.setAttribute("width", String(hs)); r.setAttribute("height", String(hs));
      r.setAttribute("fill", "#2563eb"); r.setAttribute("stroke", "#ffffff"); r.setAttribute("stroke-width", String(lw));
      r.style.cursor = "move";
      const t = document.createElementNS(NS, "title"); t.textContent = "Drag to move \u00b7 Shift+click to delete"; r.appendChild(t);
      r.addEventListener("pointerdown", (ev) => {
        if (ev.shiftKey) {
          ev.preventDefault(); ev.stopPropagation();
          const next = removeVertex(poly, k);
          if (!next) { footerStatus("A boundary needs at least 3 vertices"); return; }
          void commit(next, "Delete boundary vertex");
          return;
        }
        begin(ev, poly, k, false);
      });
      ui.appendChild(r);
    });
  };

  const commit = async (poly: Array<[number, number]>, label: string) => {
    const { setElementPolygon } = await import("./authoring");
    if (!isValidBoundary(poly)) { footerStatus("Boundary would cross itself \u2014 change reverted"); void regenerate(); return; }
    if (setElementPolygon(elId, poly, label)) footerStatus(`${label} \u00b7 Ctrl+Z to undo`);
    (window as any).__obsAuthoredElements = (await import("./authoring")).getElements();
    void regenerate();
  };

  const begin = (ev: PointerEvent, startPoly: Array<[number, number]>, idx: number, inserted: boolean) => {
    ev.preventDefault(); ev.stopPropagation();
    let poly = startPoly;
    draw(poly);
    let moved = inserted;
    const move = (e: PointerEvent) => {
      const w = clientToWorld(e.clientX, e.clientY);
      if (!w) return;
      const sn = findPlanSnap(w.x, w.z);
      const pt: [number, number] = sn ? [sn.x, sn.z] : [Math.round(w.x * 100) / 100, Math.round(w.z * 100) / 100];
      poly = moveVertex(poly, idx, pt);
      moved = true;
      draw(poly);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) void commit(poly, inserted ? "Add boundary vertex" : "Move boundary vertex");
      else draw(poly);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  draw((el0.params.polygon as Array<[number, number]>).map((q) => [q[0], q[1]] as [number, number]));
}

function renderPlan(plan: PlanView) {
  svg.innerHTML = "";

  let b = plan.bounds;
  // Empty model: show a usable paper area
  if (!isFinite(b.minX) || b.maxX - b.minX < 0.1) {
    b = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  }
  // Linked CAD (true world coordinates) extends the visible area, like Revit.
  const cadApi: any = (ctx.features as any).cadLinks;
  const planElev = (plan as any).level?.elevation ?? (plan as any).elevation;
  const cadBounds = cadApi?.getPlanBounds?.(typeof planElev === "number" ? planElev : undefined);
  if (cadBounds) {
    const empty = !isFinite(plan.bounds.minX) || plan.bounds.maxX - plan.bounds.minX < 0.1;
    b = empty ? { ...cadBounds } : {
      minX: Math.min(b.minX, cadBounds.minX), maxX: Math.max(b.maxX, cadBounds.maxX),
      minZ: Math.min(b.minZ, cadBounds.minZ), maxZ: Math.max(b.maxZ, cadBounds.maxZ),
    };
  }
  // Crop region (Revit "Crop View"): fit to the model on first use, keep it in view.
  const crop = getCropRegion(PLAN_CROP_ID);
  if (crop.enabled) {
    const pb = plan.bounds;
    if (!crop.custom && isFinite(pb.minX) && pb.maxX - pb.minX >= 0.1) {
      crop.minX = pb.minX - 1; crop.maxX = pb.maxX + 1; crop.minY = pb.minZ - 1; crop.maxY = pb.maxZ + 1;
    }
    b = {
      minX: Math.min(b.minX, crop.minX), maxX: Math.max(b.maxX, crop.maxX),
      minZ: Math.min(b.minZ, crop.minY), maxZ: Math.max(b.maxZ, crop.maxY),
    };
  }
  const pad = 3;
  const vbMinX = b.minX - pad;
  const vbMinY = -(b.maxZ + pad);
  const vbW = (b.maxX - b.minX) + 2 * pad;
  const vbH = (b.maxZ - b.minZ) + 2 * pad;

  // Apply zoom + pan by modifying viewBox
  const cx = vbMinX + vbW / 2;
  const cy = vbMinY + vbH / 2;
  const zoomedW = vbW / currentZoom;
  const zoomedH = vbH / currentZoom;
  const finalMinX = cx - zoomedW / 2 + panX;
  const finalMinY = cy - zoomedH / 2 + panY;
  // Geometry remains in model units; annotation dimensions use the active paper scale.
  const dimScale = zoomedW / 30;
  const annotationWorldScale = paperMmToWorld(1);

  svg.setAttribute(
    "viewBox",
    `${finalMinX} ${finalMinY} ${zoomedW} ${zoomedH}`,
  );

  // -- Linked CAD vectors (behind the model) --
  if (cadApi) {
    const NS = "http://www.w3.org/2000/svg";
    const cg = document.createElementNS(NS, "g");
    cg.setAttribute("data-obs-cad-link", "1");
    cg.setAttribute("pointer-events", "none");
    const lw = Math.max(zoomedW / 1500, 0.002);
    for (const it of cadApi.getPlanItems(typeof planElev === "number" ? planElev : undefined)) {
      for (const grp of it.geo.groups) {
        if (!it.isLayerVisible(grp.layer)) continue;
        let d = "";
        const sg = grp.segs;
        for (let i = 0; i < sg.length; i += 6) {
          d += `M${sg[i]} ${-sg[i + 2]}L${sg[i + 3]} ${-sg[i + 5]}`;
        }
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#" + grp.rgb.toString(16).padStart(6, "0"));
        path.setAttribute("stroke-width", String(lw));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("opacity", String(cadUnderlayOpacity));
        cg.appendChild(path);
      }
      for (const t of it.geo.texts) {
        if (!it.isLayerVisible(t.layer)) continue;
        const el = document.createElementNS(NS, "text");
        el.setAttribute("x", String(t.x));
        el.setAttribute("y", String(-t.z));
        el.setAttribute("font-size", String(t.height));
        el.setAttribute("font-family", "system-ui, sans-serif");
        el.setAttribute("fill", "#" + t.rgb.toString(16).padStart(6, "0"));
        if (t.rotation) el.setAttribute("transform", `rotate(${-t.rotation} ${t.x} ${-t.z})`);
        el.textContent = t.value;
        cg.appendChild(el);
      }
    }
    svg.appendChild(cg);
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(g);
  if (crop.enabled) {
    const NSC = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(NSC, "defs");
    const cp = document.createElementNS(NSC, "clipPath");
    cp.setAttribute("id", "obs-plan-crop-clip");
    const cr = document.createElementNS(NSC, "rect");
    cr.setAttribute("x", String(crop.minX));
    cr.setAttribute("y", String(-crop.maxY));
    cr.setAttribute("width", String(crop.maxX - crop.minX));
    cr.setAttribute("height", String(crop.maxY - crop.minY));
    cp.appendChild(cr); defs.appendChild(cp);
    svg.insertBefore(defs, svg.firstChild);
    g.setAttribute("clip-path", "url(#obs-plan-crop-clip)");
    svg.querySelector("[data-obs-cad-link]")?.setAttribute("clip-path", "url(#obs-plan-crop-clip)");
    renderCropUi(crop, zoomedW);
  }

  // -- Segments --
  if (planDisplayModel) for (const s of plan.segments) {
    const st = STYLE[s.kind] ?? STYLE.cut;
    const detailWeight = planDetailLevel === "Coarse" ? 0.8 : planDetailLevel === "Fine" ? 1.15 : 1;
    const p1 = screen(s.x1, s.z1);
    const p2 = screen(s.x2, s.z2);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(p1.x));
    line.setAttribute("y1", String(p1.y));
    line.setAttribute("x2", String(p2.x));
    line.setAttribute("y2", String(p2.y));
    line.setAttribute("stroke", st.stroke);
    // Make strokes visibly consistent regardless of zoom (screen-space)
    const scale = zoomedW / 1200;
    line.setAttribute("stroke-width", String(st.width * scale * detailWeight));
    if (st.dash) {
      const dash = st.dash.split(" ").map((n) => Number(n) * scale).join(" ");
      line.setAttribute("stroke-dasharray", dash);
    }
    line.setAttribute("stroke-linecap", "round");
    g.appendChild(line);
  }

  // -- Arcs (door swings + MEP elbows) --
  if (planDisplayModel) for (const a of plan.arcs) {
    const isDoor = a.kind === "door-swing";
    const steps = isDoor ? 24 : 72;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = a.start + (a.end - a.start) * t;
      const x = a.cx + Math.cos(ang) * a.r;
      const z = a.cz + Math.sin(ang) * a.r;
      const p = screen(x, z);
      d += `${i === 0 ? "M" : "L"}${p.x} ${p.y} `;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    if (isDoor) {
      path.setAttribute("stroke", "#555");
      path.setAttribute("stroke-width", String(0.9 * (zoomedW / 1200)));
      path.setAttribute("stroke-dasharray", `${(0.5 * (zoomedW / 1200))} ${(0.5 * (zoomedW / 1200))}`);
    } else {
      // MEP fitting: solid, matching the duct edge thickness
      // Same weight as the duct outline so the elbow reads as part of the run.
      path.setAttribute("stroke", STYLE.cut.stroke);
      path.setAttribute("stroke-width", String(STYLE.cut.width * (zoomedW / 1200)));
      path.setAttribute("stroke-linecap", "butt");
    }
    g.appendChild(path);
  }

  // -- Selected element feedback: Revit-style blue outline of the whole element --
  if (planDisplayModel && planSelectedIds.size) {
    const SVGNS = "http://www.w3.org/2000/svg";
    const hs = Math.max(zoomedW / 1200, 1e-6);
    const hl = (ids: Set<string>, color: string, w: number, op: number) => {
      for (const s of plan.segments) {
        if (!s.source || !ids.has(s.source)) continue;
        const p1 = screen(s.x1, s.z1), p2 = screen(s.x2, s.z2);
        const ln = document.createElementNS(SVGNS, "line");
        ln.setAttribute("x1", String(p1.x)); ln.setAttribute("y1", String(p1.y));
        ln.setAttribute("x2", String(p2.x)); ln.setAttribute("y2", String(p2.y));
        ln.setAttribute("stroke", color); ln.setAttribute("stroke-width", String(w * hs));
        ln.setAttribute("stroke-opacity", String(op)); ln.setAttribute("stroke-linecap", "round");
        ln.setAttribute("pointer-events", "none"); ln.setAttribute("data-obs-sel-hl", "1");
        g.appendChild(ln);
      }
      for (const a of plan.arcs) {
        if (!a.source || !ids.has(a.source)) continue;
        let d = "";
        for (let i = 0; i <= 48; i++) {
          const ang = a.start + (a.end - a.start) * (i / 48);
          const pt = screen(a.cx + Math.cos(ang) * a.r, a.cz + Math.sin(ang) * a.r);
          d += `${i === 0 ? "M" : "L"}${pt.x} ${pt.y} `;
        }
        const pa = document.createElementNS(SVGNS, "path");
        pa.setAttribute("d", d); pa.setAttribute("fill", "none");
        pa.setAttribute("stroke", color); pa.setAttribute("stroke-width", String(w * hs));
        pa.setAttribute("stroke-opacity", String(op)); pa.setAttribute("pointer-events", "none");
        pa.setAttribute("data-obs-sel-hl", "1");
        g.appendChild(pa);
      }
    };
    hl(planSelectedIds, "#2563eb", 3.2, 0.9);
  }

  // -- Selected element feedback (BIM-style blue selection) --
  const selectedPlans = (((window as any).__obsPlanSelectedEls ?? []) as any[]).filter((x) => planSelectedIds.has(x.id));
  for (const selectedPlan of selectedPlans) {
    if (!selectedPlan?.params) continue;
    const pp = selectedPlan.params;
    const points: Array<[number,number]> = pp.start && pp.end
      ? [[pp.start[0],pp.start[1]],[pp.end[0],pp.end[1]]]
      : pp.point ? [[pp.point[0],pp.point[1]]]
      : pp.polygon ? pp.polygon as Array<[number,number]> : [];
    for (const [x,z] of points) {
      const sp=screen(x,z); const r=0.12*dimScale;
      const c=document.createElementNS("http://www.w3.org/2000/svg","circle"); c.setAttribute("cx",String(sp.x));c.setAttribute("cy",String(sp.y));c.setAttribute("r",String(r));c.setAttribute("fill","none");c.setAttribute("stroke","#2563eb");c.setAttribute("stroke-width",String(Math.max(0.02,0.05*dimScale))); g.appendChild(c);
    }
  }

  // -- Edit Boundary handles for a single selected floor / roof / slab / terrain --
  if (planMode === "select" && selectedPlans.length === 1 && Array.isArray(selectedPlans[0]?.params?.polygon)) {
    renderBoundaryUi(selectedPlans[0].id, zoomedW);
  }

  // -- Text --
  for (const t of plan.texts) {
    const p = screen(t.x, t.z);
    const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
    el.setAttribute("x", String(p.x));
    el.setAttribute("y", String(p.y));
    el.setAttribute(
      "font-size",
      String((t.size ?? 0.4) * (zoomedW / 30)),
    );
    el.setAttribute("font-family", "system-ui, sans-serif");
    el.setAttribute(
      "text-anchor",
      t.anchor === "end" ? "end" : t.anchor === "middle" ? "middle" : "start",
    );
    el.setAttribute("fill", t.kind === "grid" ? "#a04a4a" : "#1a1a1a");
    el.setAttribute("font-weight", t.kind === "grid" ? "600" : "400");
    el.setAttribute("dominant-baseline", "central");
    el.textContent = t.text;
    g.appendChild(el);

    // Grid bubble
    if (t.kind === "grid") {
      const r = (t.size ?? 0.5) * 1.1;
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(p.x));
      circle.setAttribute("cy", String(p.y));
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", "none");
      circle.setAttribute("stroke", "#a04a4a");
      circle.setAttribute("stroke-width", String(0.06 * (zoomedW / 30)));
      g.appendChild(circle);
      // Move text into bubble
      el.setAttribute("fill", "#a04a4a");
    }
  }

  // -- Paper background + light grid --
  const paper = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  paper.setAttribute("x", String(vbMinX - 50));
  paper.setAttribute("y", String(vbMinY - 50));
  paper.setAttribute("width", String(vbW + 100));
  paper.setAttribute("height", String(vbH + 100));
  paper.setAttribute("fill", "#ffffff");
  g.insertBefore(paper, g.firstChild);

  const gridStep = 1; // 1 m
  for (let x = Math.floor(b.minX) - 2; x <= Math.ceil(b.maxX) + 2; x += gridStep) {
    const p1 = screen(x, b.minZ - 2);
    const p2 = screen(x, b.maxZ + 2);
    const gl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gl.setAttribute("x1", String(p1.x)); gl.setAttribute("y1", String(p1.y));
    gl.setAttribute("x2", String(p2.x)); gl.setAttribute("y2", String(p2.y));
    gl.setAttribute("stroke", x % 5 === 0 ? "#d1d5db" : "#eceff3");
    gl.setAttribute("stroke-width", String(0.02 * (zoomedW / 30)));
    g.insertBefore(gl, paper.nextSibling);
  }
  for (let z = Math.floor(b.minZ) - 2; z <= Math.ceil(b.maxZ) + 2; z += gridStep) {
    const p1 = screen(b.minX - 2, z);
    const p2 = screen(b.maxX + 2, z);
    const gl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gl.setAttribute("x1", String(p1.x)); gl.setAttribute("y1", String(p1.y));
    gl.setAttribute("x2", String(p2.x)); gl.setAttribute("y2", String(p2.y));
    gl.setAttribute("stroke", z % 5 === 0 ? "#d1d5db" : "#eceff3");
    gl.setAttribute("stroke-width", String(0.02 * (zoomedW / 30)));
    g.insertBefore(gl, paper.nextSibling);
  }

  // -- Plan dimensions � BIM style (all kinds) --
  const dimStyle = getDimensionStyle();
  const sw = dimensionWorldStroke(dimStyle);
  for (const d of planDims) {
    // Spot Elevation / Coordinate
    if (d.style === "elevation" || d.style === "coordinate") {
      const p = screen(d.x1, d.z1);
      const leader = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const ly = p.y - paperMmToWorld(8);
      leader.setAttribute("x1", String(p.x)); leader.setAttribute("y1", String(p.y));
      leader.setAttribute("x2", String(p.x)); leader.setAttribute("y2", String(ly));
      leader.setAttribute("stroke", dimStyle.color); leader.setAttribute("stroke-width", String(sw * 0.8));
      g.appendChild(leader);
      const cross = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      cross.setAttribute("cx", String(p.x)); cross.setAttribute("cy", String(p.y));
      cross.setAttribute("r", String(paperMmToWorld(1.2)));
      cross.setAttribute("fill", "none"); cross.setAttribute("stroke", dimStyle.color);
      cross.setAttribute("stroke-width", String(sw));
      g.appendChild(cross);
      g.appendChild(makeSvgText(p.x, ly - paperMmToWorld(1), d.label ?? "", dimStyle, dimScale));
      continue;
    }
    // Angular
    if (d.style === "angular") {
      const vx = d.vx ?? d.x1, vz = d.vz ?? d.z1;
      const c = screen(vx, vz);
      const r = paperMmToWorld(12);
      const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // Simple open arc indicator
      arc.setAttribute("d", `M ${c.x + r} ${c.y} A ${r} ${r} 0 0 1 ${c.x} ${c.y - r}`);
      arc.setAttribute("fill", "none");
      arc.setAttribute("stroke", dimStyle.color);
      arc.setAttribute("stroke-width", String(sw));
      g.appendChild(arc);
      g.appendChild(makeSvgText(c.x + r * 0.3, c.y - r * 0.3, d.label ?? `${(d.value ?? 0).toFixed(1)}�`, dimStyle, dimScale));
      continue;
    }
    // Radial / Diameter
    if (d.style === "radial" || d.style === "diameter") {
      const a = screen(d.x1, d.z1);
      const b = screen(d.x2, d.z2);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", dimStyle.color); line.setAttribute("stroke-width", String(sw));
      if (d.style === "radial") line.setAttribute("stroke-dasharray", `${paperMmToWorld(2)} ${paperMmToWorld(1.5)}`);
      g.appendChild(line);
      const mid = screen((d.x1 + d.x2) / 2, (d.z1 + d.z2) / 2);
      g.appendChild(makeSvgText(mid.x, mid.y - paperMmToWorld(2), d.label ?? "", dimStyle, dimScale));
      continue;
    }
    // Arc length � curved-looking chord with arc mark
    if (d.style === "arc") {
      const a = screen(d.x1, d.z1);
      const b = screen(d.x2, d.z2);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", dimStyle.color); line.setAttribute("stroke-width", String(sw));
      g.appendChild(line);
      const mid = screen((d.x1 + d.x2) / 2, (d.z1 + d.z2) / 2);
      g.appendChild(makeSvgText(mid.x, mid.y - paperMmToWorld(2), d.label ?? "", dimStyle, dimScale));
      continue;
    }

    const r1 = resolvePlanDimensionRef(d.ref1);
    const r2 = resolvePlanDimensionRef(d.ref2);
    let x1 = r1?.x ?? d.x1, z1 = r1?.z ?? d.z1, x2 = r2?.x ?? d.x2, z2 = r2?.z ?? d.z2;
    const axisDim = (d.axis && d.linePos != null) || !!d.fixedLine;
    if (d.style === "linear" && !axisDim) {
      // Strict horizontal or vertical only (Linear Dimension)
      if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) z2 = z1;
      else x2 = x1;
    }
    // aligned: keep actual x1,z1,x2,z2 so the dimension line is parallel to the object
    // Auto chains: the dimension line is fixed at linePos (model metres), witness lines run from the elements.
    let a0x: number, a0z: number, a1x: number, a1z: number;
    if (d.fixedLine) {
      const fl = d.fixedLine;
      const proj = (px: number, pz: number) => {
        const t = (px - fl.ox) * fl.ux + (pz - fl.oz) * fl.uz;
        return { x: fl.ox + fl.ux * t, z: fl.oz + fl.uz * t };
      };
      const pa = proj(x1, z1), pb = proj(x2, z2);
      a0x = pa.x; a0z = pa.z; a1x = pb.x; a1z = pb.z;
    } else if (axisDim) {
      if (d.axis === "x") { a0x = x1; a0z = d.linePos!; a1x = x2; a1z = d.linePos!; }
      else { a0x = d.linePos!; a0z = z1; a1x = d.linePos!; a1z = z2; }
    } else {
      const ddx = x2 - x1, ddz = z2 - z1, ll = Math.hypot(ddx, ddz) || 1;
      const offW = paperMmToWorld(d.offsetMm ?? DIM_OFFSET_MM);
      a0x = x1 - (ddz / ll) * offW; a0z = z1 + (ddx / ll) * offW;
      a1x = x2 - (ddz / ll) * offW; a1z = z2 + (ddx / ll) * offW;
    }
    const dx = a1x - a0x, dz = a1z - a0z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const sa = screen(a0x, a0z);
    const sb = screen(a1x, a1z);
    // Witness lines from points to dim line
    for (const [px, pz, qx, qz] of [[x1, z1, a0x, a0z], [x2, z2, a1x, a1z]] as number[][]) {
      if (Math.hypot(qx - px, qz - pz) < 1e-6) continue;
      const p = screen(px, pz); const q = screen(qx, qz);
      // slight gap from element
      const gap = 0.0;
      const gx = px + (qx - px) * (gap / Math.max(0.01, Math.hypot(qx - px, qz - pz)));
      const gz = pz + (qz - pz) * (gap / Math.max(0.01, Math.hypot(qx - px, qz - pz)));
      const pg = screen(gx, gz);
      const wl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      wl.setAttribute("x1", String(pg.x)); wl.setAttribute("y1", String(pg.y));
      wl.setAttribute("x2", String(q.x)); wl.setAttribute("y2", String(q.y));
      wl.setAttribute("stroke", dimStyle.color);
      wl.setAttribute("stroke-width", String(sw * 0.7));
      g.appendChild(wl);
    }
    // Dimension line
    const dl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    dl.setAttribute("x1", String(sa.x)); dl.setAttribute("y1", String(sa.y));
    dl.setAttribute("x2", String(sb.x)); dl.setAttribute("y2", String(sb.y));
    dl.setAttribute("stroke", dimStyle.color);
    dl.setAttribute("stroke-width", String(sw));
    g.appendChild(dl);
    // BIM-like dimension termini: diagonal tick / dot / arrowhead.
    const tick = paperMmToWorld(2.5);
    for (const [cx, cz] of [[a0x, a0z], [a1x, a1z]] as number[][]) {
      if (dimStyle.tick === "dot") {
        const cp = screen(cx,cz); const c=document.createElementNS("http://www.w3.org/2000/svg","circle");
        c.setAttribute("cx",String(cp.x));c.setAttribute("cy",String(cp.y));c.setAttribute("r",String(sw*2.2));c.setAttribute("fill",dimStyle.color);g.appendChild(c);
      } else if (dimStyle.tick === "arrow") {
        const cp = screen(cx,cz);
        const size = paperMmToWorld(2.5); const left = screen(cx - ux*size + nx*size*0.55, cz - uz*size + nz*size*0.55); const right = screen(cx - ux*size - nx*size*0.55, cz - uz*size - nz*size*0.55);
        const poly=document.createElementNS("http://www.w3.org/2000/svg","polygon");poly.setAttribute("points",`${cp.x},${cp.y} ${left.x},${left.y} ${right.x},${right.y}`);poly.setAttribute("fill",dimStyle.color);g.appendChild(poly);
      } else {
        const t1 = screen(cx - ux * tick * 0.3 - nx * tick, cz - uz * tick * 0.3 - nz * tick);
        const t2 = screen(cx + ux * tick * 0.3 + nx * tick, cz + uz * tick * 0.3 + nz * tick);
        const tk = document.createElementNS("http://www.w3.org/2000/svg", "line");
        tk.setAttribute("x1", String(t1.x)); tk.setAttribute("y1", String(t1.y));
        tk.setAttribute("x2", String(t2.x)); tk.setAttribute("y2", String(t2.y));
        tk.setAttribute("stroke", dimStyle.color);
        tk.setAttribute("stroke-width", String(sw * 1.2));
        g.appendChild(tk);
      }
    }
    const mid = screen((a0x + a1x) / 2 + nx * 0.12, (a0z + a1z) / 2 + nz * 0.12);
    g.appendChild(makeSvgText(mid.x, mid.y, d.textOverride ?? (dimShowsEq(d) ? "EQ" : formatPlanDimension(len, dimStyle)), dimStyle, dimScale));
  }

  // -- Selected dimension (blue) --
  if (planDimSel && planDims.includes(planDimSel)) {
    for (const m of dimMembers(planDimSel)) {
      const isMain = m === planDimSel;
      const ends = dimEndsFor(m);
      const hp = resolvedDimPoints(m);
      const a = ends ? ends.a : { x: m.x1, z: m.z1 }, b = ends ? ends.b : { x: m.x2, z: m.z2 };
      const sa = screen(a.x, a.z), sb = screen(b.x, b.z);
      const hl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      hl.setAttribute("x1", String(sa.x)); hl.setAttribute("y1", String(sa.y));
      hl.setAttribute("x2", String(sb.x)); hl.setAttribute("y2", String(sb.y));
      hl.setAttribute("stroke", "#2563eb"); hl.setAttribute("stroke-opacity", isMain ? "0.55" : "0.25");
      hl.setAttribute("stroke-width", String(paperMmToWorld(isMain ? 1.4 : 0.9)));
      hl.setAttribute("stroke-linecap", "round"); hl.setAttribute("pointer-events", "none");
      g.appendChild(hl);
      if (isMain) {
        for (const q of [a, b, hp.p1, hp.p2]) {
          const sp = screen(q.x, q.z);
          const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          c.setAttribute("cx", String(sp.x)); c.setAttribute("cy", String(sp.y));
          c.setAttribute("r", String(paperMmToWorld(1.1))); c.setAttribute("fill", "#2563eb");
          c.setAttribute("pointer-events", "none");
          g.appendChild(c);
        }
      }
    }
  }

  // -- Temporary dimensions for selected elements --
  renderTemporaryDimensions(g, dimScale, b);

  // -- Tags (live text, halo, leader to the label edge) --
  {
    const SVGNS = "http://www.w3.org/2000/svg";
    const tagColor = "#0f766e";
    const els = authoredEls();
    for (const t of planTags) {
      const text = liveTagText(t);
      const box = textBox(t.x, t.z, text, TAG_H());
      if (t.leader && t.elementId) {
        const el = els.find((e) => e?.id === t.elementId);
        const an = el ? elementAnchor(el) : null;
        if (an) {
          const end = leaderEnd(box, an);
          const sa = screen(an.x, an.z), se = screen(end.x, end.z);
          const ln = document.createElementNS(SVGNS, "line");
          ln.setAttribute("x1", String(sa.x)); ln.setAttribute("y1", String(sa.y));
          ln.setAttribute("x2", String(se.x)); ln.setAttribute("y2", String(se.y));
          ln.setAttribute("stroke", tagColor); ln.setAttribute("stroke-width", String(dimensionWorldStroke(getDimensionStyle()) * 0.8));
          g.appendChild(ln);
          const dot = document.createElementNS(SVGNS, "circle");
          dot.setAttribute("cx", String(sa.x)); dot.setAttribute("cy", String(sa.y));
          dot.setAttribute("r", String(paperMmToWorld(0.7))); dot.setAttribute("fill", tagColor);
          g.appendChild(dot);
        }
      }
      const p = screen(t.x, t.z);
      const lines = text.split("\n");
      const lab = document.createElementNS(SVGNS, "text");
      lab.setAttribute("x", String(p.x)); lab.setAttribute("y", String(p.y));
      lab.setAttribute("fill", tagColor); lab.setAttribute("font-size", String(TAG_H()));
      lab.setAttribute("font-family", "Arial,system-ui,sans-serif"); lab.setAttribute("font-weight", "600");
      lab.setAttribute("paint-order", "stroke"); lab.setAttribute("stroke", "#ffffff");
      lab.setAttribute("stroke-width", String(TAG_H() * 0.22)); lab.setAttribute("stroke-linejoin", "round");
      lines.forEach((ln, i) => {
        const ts = document.createElementNS(SVGNS, "tspan");
        ts.setAttribute("x", String(p.x)); ts.setAttribute("dy", i === 0 ? "0" : String(TAG_H() * 1.2));
        ts.textContent = ln; lab.appendChild(ts);
      });
      g.appendChild(lab);
    }
  }

  // -- Text notes (multi-line, halo) --
  for (const n of planNotes) {
    const p = screen(n.x, n.z);
    const lab = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lab.setAttribute("x", String(p.x));
    lab.setAttribute("y", String(p.y));
    lab.setAttribute("fill", "#334155");
    lab.setAttribute("font-size", String(NOTE_H()));
    lab.setAttribute("font-family", "system-ui,sans-serif");
    lab.setAttribute("paint-order", "stroke"); lab.setAttribute("stroke", "#ffffff");
    lab.setAttribute("stroke-width", String(NOTE_H() * 0.2)); lab.setAttribute("stroke-linejoin", "round");
    n.text.split("\n").forEach((ln, i) => {
      const ts = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      ts.setAttribute("x", String(p.x)); ts.setAttribute("dy", i === 0 ? "0" : String(NOTE_H() * 1.2));
      ts.textContent = ln; lab.appendChild(ts);
    });
    g.appendChild(lab);
  }

  // -- Selected annotation: dashed blue box --
  if (planAnnoSel && (planAnnoSel.kind === "tag" ? planTags.includes(planAnnoSel.obj as PlanTag) : planNotes.includes(planAnnoSel.obj as PlanNote))) {
    const bx = annoBox(planAnnoSel);
    const pad = paperMmToWorld(0.8);
    const tl = screen(bx.minX - pad, bx.maxZ + pad), br = screen(bx.maxX + pad, bx.minZ - pad);
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(Math.min(tl.x, br.x))); r.setAttribute("y", String(Math.min(tl.y, br.y)));
    r.setAttribute("width", String(Math.abs(br.x - tl.x))); r.setAttribute("height", String(Math.abs(br.y - tl.y)));
    r.setAttribute("fill", "rgba(37,99,235,0.08)"); r.setAttribute("stroke", "#2563eb");
    r.setAttribute("stroke-width", String(paperMmToWorld(0.35)));
    r.setAttribute("stroke-dasharray", `${paperMmToWorld(1.2)} ${paperMmToWorld(0.8)}`);
    r.setAttribute("pointer-events", "none");
    g.appendChild(r);
  }

  // Empty guidance
  if (plan.segments.length === 0 && planDims.length === 0) {
    const mid = screen((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tip.setAttribute("x", String(mid.x));
    tip.setAttribute("y", String(mid.y));
    tip.setAttribute("fill", "#94a3b8");
    tip.setAttribute("font-size", String(0.4 * dimScale));
    tip.setAttribute("text-anchor", "middle");
    tip.setAttribute("font-family", "system-ui,sans-serif");
    tip.textContent = "Floor Plan � use Wall tool to draw � Link CAD to trace � or load an IFC model";
    g.appendChild(tip);
  }

  // -- Chain dimension: picked boundaries (markers only - the dimensions appear when the line is placed) --
  if (planDimChainPts.length) {
    const SVGNS = "http://www.w3.org/2000/svg";
    const ds0 = getDimensionStyle();
    if (planDimChainPts.length > 1) {
      const pl = document.createElementNS(SVGNS, "polyline");
      pl.setAttribute("points", planDimChainPts.map((q) => { const sp = screen(q.x, q.z); return `${sp.x},${sp.y}`; }).join(" "));
      pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "#2563eb");
      pl.setAttribute("stroke-width", String(dimensionWorldStroke(ds0) * 0.6));
      pl.setAttribute("stroke-dasharray", `${paperMmToWorld(1.5)} ${paperMmToWorld(1.2)}`);
      pl.setAttribute("pointer-events", "none");
      g.appendChild(pl);
    }
    planDimChainPts.forEach((q, i) => {
      const sp = screen(q.x, q.z);
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", String(sp.x)); c.setAttribute("cy", String(sp.y));
      c.setAttribute("r", String(paperMmToWorld(1.3))); c.setAttribute("fill", "#2563eb");
      c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", String(dimensionWorldStroke(ds0) * 0.5));
      c.setAttribute("pointer-events", "none");
      g.appendChild(c);
      g.appendChild(makeSvgText(sp.x + paperMmToWorld(2), sp.y - paperMmToWorld(2), String(i + 1), ds0, 1));
    });
  }

  // -- Live dimension preview (BIM dimension placement behavior) --
  if (planMode === "dim" && planCursor) {
    const ds = getDimensionStyle();
    const dsw = dimensionWorldStroke(ds);
    // Spot tools: floating label at cursor
    if ((planDimStyle === "elevation" || planDimStyle === "coordinate") && !planDrawStart) {
      const pc = screen(planCursor.x, planCursor.z);
      let elev = 0;
      try {
        const levels = listAvailableLevels();
        const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
        elev = selected.elevation + planElevOffset;
      } catch { /* */ }
      const label = planDimStyle === "elevation"
        ? `EL ${formatPlanDimension(elev, ds)}`
        : `X ${formatPlanDimension(planCursor.x, ds)}  Z ${formatPlanDimension(planCursor.z, ds)}`;
      g.appendChild(makeSvgText(pc.x, pc.y - paperMmToWorld(4), label, ds, dimScale));
    }
    // Radial / diameter rubber band
    if ((planDimStyle === "radial" || planDimStyle === "diameter") && planDrawStart) {
      const a = screen(planDrawStart.x, planDrawStart.z);
      const b = screen(planCursor.x, planCursor.z);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", ds.color); line.setAttribute("stroke-width", String(dsw));
      line.setAttribute("stroke-dasharray", `${paperMmToWorld(3)} ${paperMmToWorld(2)}`);
      line.setAttribute("opacity", "0.85");
      g.appendChild(line);
      const r = Math.hypot(planCursor.x - planDrawStart.x, planCursor.z - planDrawStart.z);
      const label = planDimStyle === "radial"
        ? `R ${formatPlanDimension(r, ds)}`
        : `? ${formatPlanDimension(r * 2, ds)}`;
      const mid = screen((planDrawStart.x + planCursor.x) / 2, (planDrawStart.z + planCursor.z) / 2);
      g.appendChild(makeSvgText(mid.x, mid.y - paperMmToWorld(2), label, ds, dimScale));
    }
    // Aligned / Linear / Arc rubber band
    if (planDrawStart && (planDimStyle === "aligned" || planDimStyle === "linear" || planDimStyle === "arc")) {
      let dx = planCursor.x - planDrawStart.x;
      let dz = planCursor.z - planDrawStart.z;
      if (planDimStyle === "linear") {
        if (Math.abs(dx) >= Math.abs(dz)) dz = 0;
        else dx = 0;
      }
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        const ux = dx / len, uz = dz / len;
        const nx = -uz, nz = ux;
        const off = paperMmToWorld(DIM_OFFSET_MM);
        const a = { x: planDrawStart.x + nx * off, z: planDrawStart.z + nz * off };
        const b2 = { x: planDrawStart.x + dx + nx * off, z: planDrawStart.z + dz + nz * off };
        const pa = screen(a.x, a.z), pb = screen(b2.x, b2.z);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(pa.x)); line.setAttribute("y1", String(pa.y));
        line.setAttribute("x2", String(pb.x)); line.setAttribute("y2", String(pb.y));
        line.setAttribute("stroke", ds.color); line.setAttribute("stroke-width", String(dsw));
        line.setAttribute("stroke-dasharray", `${paperMmToWorld(3)} ${paperMmToWorld(2)}`);
        line.setAttribute("opacity", "0.8");
        g.appendChild(line);
        const mid = screen((a.x+b2.x)/2 + nx*0.12, (a.z+b2.z)/2 + nz*0.12);
        const prefix = planDimStyle === "arc" ? "? " : "";
        g.appendChild(makeSvgText(mid.x, mid.y, prefix + formatPlanDimension(len, ds), ds, dimScale));
      }
    }
    // Angular: highlight first edge after first pick
    if (planDimStyle === "angular" && planDimSeg1) {
      const a = screen(planDimSeg1.x1, planDimSeg1.z1);
      const b = screen(planDimSeg1.x2, planDimSeg1.z2);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", "#f59e0b"); line.setAttribute("stroke-width", String(dsw * 1.4));
      line.setAttribute("opacity", "0.9");
      g.appendChild(line);
    }
  }

  // -- Live draw preview + snap marker (BIM Place Duct style) --
  if (planDrawStart && planCursor && planMode !== "dim") {
    const a = screen(planDrawStart.x, planDrawStart.z);
    const c = screen(planCursor.x, planCursor.z);
    // Thickness band (wall/duct outline)
    const dx = planCursor.x - planDrawStart.x;
    const dz = planCursor.z - planDrawStart.z;
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    const t2 = planWidth / 2;
    const corners = [
      screen(planDrawStart.x + nx * t2, planDrawStart.z + nz * t2),
      screen(planCursor.x + nx * t2, planCursor.z + nz * t2),
      screen(planCursor.x - nx * t2, planCursor.z - nz * t2),
      screen(planDrawStart.x - nx * t2, planDrawStart.z - nz * t2),
    ];
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", corners.map((p) => `${p.x},${p.y}`).join(" "));
    poly.setAttribute("fill", planLinearType === "duct" ? "rgba(56,189,248,0.25)" : "rgba(148,163,184,0.35)");
    poly.setAttribute("stroke", planLinearType === "duct" ? "#0284c7" : "#475569");
    poly.setAttribute("stroke-width", String(0.03 * (zoomedW / 30)));
    g.appendChild(poly);
    const rb = document.createElementNS("http://www.w3.org/2000/svg", "line");
    rb.setAttribute("x1", String(a.x)); rb.setAttribute("y1", String(a.y));
    rb.setAttribute("x2", String(c.x)); rb.setAttribute("y2", String(c.y));
    rb.setAttribute("stroke", "#f59e0b");
    rb.setAttribute("stroke-width", String(0.04 * (zoomedW / 30)));
    rb.setAttribute("stroke-dasharray", `${0.12 * (zoomedW / 30)} ${0.08 * (zoomedW / 30)}`);
    g.appendChild(rb);
    // Ortho guide lines from start
    const gx1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const pL = screen(planDrawStart.x - 40, planDrawStart.z);
    const pR = screen(planDrawStart.x + 40, planDrawStart.z);
    gx1.setAttribute("x1", String(pL.x)); gx1.setAttribute("y1", String(pL.y));
    gx1.setAttribute("x2", String(pR.x)); gx1.setAttribute("y2", String(pR.y));
    gx1.setAttribute("stroke", "#38bdf8"); gx1.setAttribute("stroke-width", String(0.02 * (zoomedW / 30)));
    gx1.setAttribute("stroke-dasharray", `${0.2 * (zoomedW / 30)} ${0.12 * (zoomedW / 30)}`);
    g.appendChild(gx1);
    const gz1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const pB = screen(planDrawStart.x, planDrawStart.z - 40);
    const pT = screen(planDrawStart.x, planDrawStart.z + 40);
    gz1.setAttribute("x1", String(pB.x)); gz1.setAttribute("y1", String(pB.y));
    gz1.setAttribute("x2", String(pT.x)); gz1.setAttribute("y2", String(pT.y));
    gz1.setAttribute("stroke", "#38bdf8"); gz1.setAttribute("stroke-width", String(0.02 * (zoomedW / 30)));
    gz1.setAttribute("stroke-dasharray", `${0.2 * (zoomedW / 30)} ${0.12 * (zoomedW / 30)}`);
    g.appendChild(gz1);
    const len = Math.hypot(planCursor.x - planDrawStart.x, planCursor.z - planDrawStart.z);
    const mid = screen((planDrawStart.x + planCursor.x) / 2, (planDrawStart.z + planCursor.z) / 2);
    const lab = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lab.setAttribute("x", String(mid.x)); lab.setAttribute("y", String(mid.y - 0.2 * (zoomedW / 30)));
    lab.setAttribute("fill", "#b45309"); lab.setAttribute("font-size", String(0.28 * (zoomedW / 30)));
    lab.setAttribute("text-anchor", "middle"); lab.setAttribute("font-family", "system-ui,sans-serif");
    lab.textContent = `${(len * 1000).toFixed(0)}`;
    g.appendChild(lab);
  }
    // Snap marker now rendered by updateSnapOverlay()

  // -- Title block (bottom-right of drawn extents) --
  const titleX = b.maxX - 6;
  const titleZ = b.minZ + 0.5;
  const p = screen(titleX, titleZ);
  const tt = document.createElementNS("http://www.w3.org/2000/svg", "text");
  tt.setAttribute("x", String(p.x));
  tt.setAttribute("y", String(p.y));
  tt.setAttribute("font-size", String(0.35 * (zoomedW / 30)));
  tt.setAttribute("fill", "#333");
  tt.setAttribute("font-family", "system-ui, sans-serif");
  tt.setAttribute("text-anchor", "end");
  tt.textContent = `Plan: ${plan.level.name}  �  Cut +${plan.cutElevation.toFixed(2)} m`;
  g.appendChild(tt);

  // -- Footer --
  footer.innerHTML = "";
  const info = document.createElement("span");
  info.style.cssText = "opacity:.7";
  info.textContent =
    `${plan.stats.authoredElements} authored � ` +
    `${plan.stats.fragmentElements} fragments � ` +
    `${plan.segments.length} segments � ` +
    `zoom ${(currentZoom * 100).toFixed(0)}%` +
    (plan.truncated ? " � ? truncated" : "");
  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;opacity:.55";
  hint.textContent = "Wheel: zoom � MMB pan � Shift+LMB pan � Dbl-click: fit � Esc: cancel";
  footer.append(info, hint);
  updateSnapOverlay();
  updateSnapOverlay();
}

/* -------------------------------------------------------------------------
   Interaction � zoom + pan
   ------------------------------------------------------------------------- */
let panning = false;
let lastMouse = { x: 0, y: 0 };

async function placeWallInPlan(x1: number, z1: number, x2: number, z2: number) {
  try {
    const auth = await import("./authoring");
    const levels = listAvailableLevels();
    const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
    auth.setLevel(selected.elevation);
    auth.setAuthoringTool("wall");
    // Direct create via synthetic clicks is hard; use public API if available
    // Fallback: set tool and rely on 3D � here we push geometry via internal rebuild path
    const els = auth.getElements();
    const before = els.length;
    // Use history-free direct injection through setAuthoringTool + programmatic create
    // Prefer: dispatch to authoring create if exported
    const anyAuth = auth as any;
    if (typeof anyAuth.createWallFromPlan === "function") {
      await anyAuth.createWallFromPlan(x1, z1, x2, z2, selected.elevation);
    } else {
      // Minimal: activate wall tool in 3D at this level and toast guidance
      auth.setAuthoringTool("wall");
      footerStatus(`Wall tool ready at ${selected.name} � draw in 3D or click two points again in plan`);
    }
    void before;
  } catch (err) {
    console.warn("[plan] place wall", err);
  }
}

/** Linear segment from plan ? 3D (keeps placement tool active for chain). */
async function createAuthoredLinear(x1: number, z1: number, x2: number, z2: number) {
  try {
    const { addLinearElement, setLevel } = await import("./authoring");
    const levels = listAvailableLevels();
    const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
    const elev = selected.elevation + planElevOffset;
    setLevel(elev);
    const t = (planLinearType === "brace" || planLinearType === "truss") ? "beam" : planLinearType;
    await addLinearElement(t, x1, z1, x2, z2, elev, {
      thickness: planWidth,
      height: planHeight,
    });
    // Soft refresh without full loading flash when chaining
    try {
      const plan = await generatePlanView({
        levelName: selected.name,
        levelElevation: selected.elevation,
        cutHeight,
        cutDepth: Math.max(planViewRangeDepth, Math.abs(planViewRangeBottom)),
        viewRangeTop: planViewRangeTop,
        viewRangeBottom: planViewRangeBottom,
        viewDepth: planViewRangeDepth,
        includeOverhead: true,
        includeBelow: true,
        maxSegments: 250_000,
      });
      currentPlan = plan;
      renderPlan(plan);
      applyCadUnderlay();
    } catch {
      await regenerate();
    }
    footerStatus(
      `${t} � ${Math.hypot(x2 - x1, z2 - z1).toFixed(2)} m � click next point (Enter/Esc to finish)`,
    );
  } catch (err) {
    console.error("[plan] create linear failed", err);
    footerStatus("Could not place element � see console");
  }
}

function ensurePlanCursorOverlay(): HTMLDivElement | null {
  if (__planCursorOverlay && __planCursorOverlay.parentElement) return __planCursorOverlay;
  if (!currentPlan) return null;
  const ov = document.createElement("div");
  ov.id = "obs-plan-cursor-overlay";
  ov.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:40;overflow:hidden";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("viewBox", "0 0 100 100");
  ov.appendChild(svg);
  canvasWrap.appendChild(ov);
  // Force correct positioning context
  if (getComputedStyle(canvasWrap).position === "static") {
    canvasWrap.style.position = "relative";
  }
  __planCursorOverlay = ov;
  __planCursorSvg = svg;
  return ov;
}

function computeOverlayViewBox(): string {
  if (!currentPlan) return "0 0 100 100";
  let b = currentPlan.bounds;
  if (!isFinite(b.minX) || b.maxX - b.minX < 0.1) {
    b = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  }
  const pad = 3;
  const vbMinX = b.minX - pad;
  const vbMinY = -(b.maxZ + pad);
  const vbW = (b.maxX - b.minX) + 2 * pad;
  const vbH = (b.maxZ - b.minZ) + 2 * pad;
  const cx = vbMinX + vbW / 2;
  const cy = vbMinY + vbH / 2;
  const zw = vbW / currentZoom;
  const zh = vbH / currentZoom;
  const fmx = cx - zw / 2 + panX;
  const fmy = cy - zh / 2 + panY;
  return fmx + " " + fmy + " " + zw + " " + zh;
}

/* -------------------------------------------------------------------------
   Snap marker symbols � identical visual language to the 3D viewer.
   These are the same 32�32 SVG paths used by features/snapping.ts, so
   the user sees consistent feedback in 2D and 3D. Keep in sync.
   ------------------------------------------------------------------------- */
const SNAP_MARKERS_LOCAL: Record<string, string> = {
  endpoint:
    `<rect x="9" y="9" width="14" height="14" fill="#F59E0B" stroke="#0B0D12" stroke-width="2"/>`,
  intersection:
    `<path d="M6 6 L26 26 M26 6 L6 26" stroke="#EF4444" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  corner:
    `<path d="M8 8 L8 24 L24 24" stroke="#FBBF24" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="8" cy="8" r="2.5" fill="#FBBF24"/>`,
  midpoint:
    `<polygon points="16,8 26,24 6,24" fill="#22C55E" stroke="#0B0D12" stroke-width="2" stroke-linejoin="round"/>`,
  center:
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#38BDF8" stroke-width="2.5"/>` +
    `<circle cx="16" cy="16" r="2.4" fill="#38BDF8"/>`,
  perpendicular:
    `<path d="M8 8 L8 26 L26 26" stroke="#C084FC" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="8" y="20" width="6" height="6" fill="#C084FC"/>`,
  tangent:
    `<circle cx="18" cy="18" r="8" fill="none" stroke="#F472B6" stroke-width="2.5"/>` +
    `<line x1="3" y1="10" x2="29" y2="10" stroke="#F472B6" stroke-width="2.5" stroke-linecap="round"/>`,
  quadrant:
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#34D399" stroke-width="2"/>` +
    `<circle cx="16" cy="7" r="2" fill="#34D399"/>` +
    `<circle cx="25" cy="16" r="2" fill="#34D399"/>` +
    `<circle cx="16" cy="25" r="2" fill="#34D399"/>` +
    `<circle cx="7" cy="16" r="2" fill="#34D399"/>`,
  vertex:
    `<rect x="11" y="11" width="10" height="10" fill="#38BDF8" stroke="#0B0D12" stroke-width="2" transform="rotate(45 16 16)"/>`,
  face:
    `<rect x="8" y="8" width="16" height="16" fill="none" stroke="#38BDF8" stroke-width="2"/>` +
    `<circle cx="16" cy="16" r="2.6" fill="#38BDF8"/>`,
  nearest:
    `<circle cx="16" cy="16" r="4" fill="#F59E0B"/>` +
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#F59E0B" stroke-width="1.5" opacity="0.55"/>`,
  parallel:
    `<path d="M8 12 H24 M8 20 H24" stroke="#A78BFA" stroke-width="2.5" stroke-linecap="round"/>`,
  extension:
    `<path d="M4 16 H28 M22 10 L28 16 L22 22" stroke="#F472B6" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  grid:
    `<path d="M6 16 H26 M16 6 V26" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="3" fill="none" stroke="#38BDF8" stroke-width="1.5"/>`,
};

const SNAP_LABELS_LOCAL: Record<string, string> = {
  endpoint: "End", intersection: "Int", corner: "Corner", midpoint: "Mid",
  center: "Cen", perpendicular: "Perp", tangent: "Tan", quadrant: "Quad",
  vertex: "Vtx", face: "Face", nearest: "Near", parallel: "Par",
  extension: "Ext", grid: "Grid",
};

const SNAP_COLORS_LOCAL: Record<string, string> = {
  endpoint: "#F59E0B", intersection: "#EF4444", corner: "#FBBF24",
  midpoint: "#22C55E", center: "#38BDF8", perpendicular: "#C084FC",
  tangent: "#F472B6", quadrant: "#34D399", vertex: "#38BDF8",
  face: "#38BDF8", nearest: "#F59E0B", parallel: "#A78BFA",
  extension: "#F472B6", grid: "#38BDF8",
};

/** Map internal snap kind strings from findPlanSnap / findDimensionBoundary
 *  onto the canonical marker types. */
function normalizeSnapKind(kind: string | undefined | null): string | null {
  const k = String(kind ?? "").toLowerCase().trim();
  if (!k) return null;
  if (SNAP_MARKERS_LOCAL[k]) return k;
  if (k === "end") return "endpoint";
  if (k === "mid") return "midpoint";
  if (k === "int") return "intersection";
  if (k === "cen") return "center";
  if (k === "near") return "nearest";
  if (k === "perp" || k === "ortho") return "perpendicular";
  if (k === "boundary") return "face";
  return null;
}

/** Render the snap marker + label at the current snap point, using the
 *  exact same SVG symbols the 3D viewer uses. */
function renderPlanSnapMarker(): void {
  if (!__planCursorSvg || !currentPlan || !planSnap) return;
  const kind = normalizeSnapKind(planSnap.kind);
  if (!kind) return;

  // Compute world-space size for a fixed ~24 px marker regardless of zoom.
  const rect = canvasWrap.getBoundingClientRect();
  if (rect.width < 1) return;
  const b = currentPlan.bounds;
  const pad = 3;
  const vbW = Math.max(0.1, (b.maxX - b.minX) + 2 * pad);
  const zoomedW = vbW / currentZoom;
  const worldPerPx = zoomedW / rect.width;
  const size = worldPerPx * 24;

  const sx = size / 32;
  const svgY = -planSnap.z;

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute(
    "transform",
    `translate(${planSnap.x} ${svgY}) scale(${sx} ${sx}) translate(-16 -16)`,
  );
  g.setAttribute("pointer-events", "none");

  const wrap = document.createElementNS("http://www.w3.org/2000/svg", "g");
  wrap.innerHTML = SNAP_MARKERS_LOCAL[kind];
  while (wrap.firstChild) g.appendChild(wrap.firstChild);
  __planCursorSvg.appendChild(g);

  const label = planSnap.label ?? SNAP_LABELS_LOCAL[kind];
  const color = SNAP_COLORS_LOCAL[kind] ?? "#FBBF24";
  if (label) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(planSnap.x + size * 0.62));
    t.setAttribute("y", String(svgY - size * 0.55));
    t.setAttribute("font-size", String(size * 0.34));
    t.setAttribute("font-family", "system-ui, sans-serif");
    t.setAttribute("font-weight", "700");
    t.setAttribute("fill", color);
    t.setAttribute("paint-order", "stroke");
    t.setAttribute("stroke", "#0B0D12");
    t.setAttribute("stroke-width", String(size * 0.07));
    t.setAttribute("stroke-linejoin", "round");
    t.textContent = label;
    __planCursorSvg.appendChild(t);
  }
}
function updateSnapOverlayLegacy(): void {
  if (!currentPlan) return;
  ensurePlanCursorOverlay();
  if (!__planCursorSvg) return;
  const zoomedW = (currentPlan.bounds.maxX - currentPlan.bounds.minX + 6) / currentZoom;

  __planCursorSvg.setAttribute("viewBox", computeOverlayViewBox());
  while (__planCursorSvg.firstChild) __planCursorSvg.removeChild(__planCursorSvg.firstChild);

  // Snap marker
  // Snap marker now rendered by updateSnapOverlay()

  // Rubber-band for dim preview
  if (planMode === "dim" && planCursor && planDrawStart &&
      (planDimStyle === "aligned" || planDimStyle === "linear" || planDimStyle === "arc")) {
    let dx = planCursor.x - planDrawStart.x;
    let dz = planCursor.z - planDrawStart.z;
    if (planDimStyle === "linear") {
      if (Math.abs(dx) >= Math.abs(dz)) dz = 0;
      else dx = 0;
    }
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      const ux = dx / len, uz = dz / len;
      const nx = -uz, nz = ux;
      const off = (0.0012) * zoomedW;
      const a = screen(planDrawStart.x + nx * off, planDrawStart.z + nz * off);
      const b2 = screen(planDrawStart.x + dx + nx * off, planDrawStart.z + dz + nz * off);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b2.x)); line.setAttribute("y2", String(b2.y));
      line.setAttribute("stroke", "#1d4ed8");
      line.setAttribute("stroke-width", String(zoomedW * 0.0008));
      line.setAttribute("stroke-dasharray", String(zoomedW * 0.003) + " " + String(zoomedW * 0.002));
      line.setAttribute("opacity", "0.85");
      __planCursorSvg.appendChild(line);
      const mx = (a.x + b2.x) / 2;
      const my = (a.y + b2.y) / 2 - zoomedW * 0.008;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", String(mx)); t.setAttribute("y", String(my));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#1d4ed8");
      t.setAttribute("font-family", "system-ui,sans-serif");
      t.setAttribute("font-weight", "700");
      t.setAttribute("font-size", String(zoomedW * 0.0075));
      t.textContent = (len * 1000).toFixed(0);
      __planCursorSvg.appendChild(t);
    }
  }

  // Preview of a wall/duct being drawn
  if (planDrawStart && planCursor && planMode !== "dim") {
    const a = screen(planDrawStart.x, planDrawStart.z);
    const b = screen(planCursor.x, planCursor.z);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y));
    line.setAttribute("stroke", "#f59e0b");
    line.setAttribute("stroke-width", String(zoomedW * 0.001));
    line.setAttribute("stroke-dasharray", String(zoomedW * 0.003) + " " + String(zoomedW * 0.002));
    __planCursorSvg.appendChild(line);
  }
}

function updateSnapOverlay(): void {
  try {
    updateSnapOverlayLegacy();
    renderPlanSnapMarker();
  } catch (err) {
    console.error("[plan-snap-overlay] error:", err);
  }
}

/**
 * Debug helper — run in the browser console:
 *   __obsSnapDebug()
 * to see what the snap engine sees at the current cursor position.
 */
try {
  (window as any).__obsSnapDebug = () => {
    const els: any[] = ((window as any).__obsAuthoredElements ?? []);
    console.log("[snap-debug] authored elements:", els.length);
    console.log("[snap-debug] plan bounds:", currentPlan?.bounds);
    console.log("[snap-debug] overlay mounted:", !!(__planCursorOverlay && __planCursorOverlay.parentElement));
    console.log("[snap-debug] overlay svg mounted:", !!(__planCursorSvg && __planCursorSvg.parentElement));
    console.log("[snap-debug] current snap:", planSnap);
    console.log("[snap-debug] current cursor:", planCursor);
    console.log("[snap-debug] current mode:", planMode);
    if (els.length) {
      console.log("[snap-debug] first element:", JSON.stringify(els[0]).slice(0, 300));
    }
    return {
      elements: els.length,
      bounds: currentPlan?.bounds,
      overlayMounted: !!(__planCursorOverlay && __planCursorOverlay.parentElement),
      snap: planSnap,
      cursor: planCursor,
      mode: planMode,
    };
  };
} catch { /* ignore */ }


function clearPlanCursorOverlay(): void {
  if (!__planCursorSvg) return;
  while (__planCursorSvg.firstChild) __planCursorSvg.removeChild(__planCursorSvg.firstChild);
}
function finishPlanChain() {
  planTypedLength = "";
  planChain = [];
  planDrawStart = null;
  planCursor = null;
  planSnap = null;
  void import("./authoring").then((m) => m.clearLastPlanLinear?.()).catch(() => {});
  // BIM behavior: path finished but tool stays active for next chain until Esc
  if (planMode === "linear") {
    footerStatus(`${planLinearType} path finished � click start of next path � Esc = Modify`);
    toolHint.textContent = `Place ${planLinearType} � continuous path � Enter finish � Esc cancel`;
  } else {
    footerStatus(`${planLinearType} path finished`);
  }
  if (currentPlan) renderPlan(currentPlan);
}

const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  wall: { w: 0.2, h: 3 },
  beam: { w: 0.3, h: 0.4 },
  strip: { w: 0.4, h: 0.5 },
  duct: { w: 0.305, h: 0.305 },
  pipe: { w: 0.05, h: 0.05 },
  "cable-tray": { w: 0.3, h: 0.1 },
  conduit: { w: 0.025, h: 0.025 },
  mline: { w: 0.05, h: 0.05 },
};

function applyDefaultSizeForTool(tool: string) {
  const s = DEFAULT_SIZES[tool] ?? { w: 0.3, h: 0.3 };
  planWidth = s.w;
  planHeight = s.h;
  const wi = widthInp.querySelector("input") as HTMLInputElement | null;
  const hi = heightInp.querySelector("input") as HTMLInputElement | null;
  if (wi) wi.value = String(Math.round(planWidth * 1000));
  if (hi) hi.value = String(Math.round(planHeight * 1000));
}


/** Point element from plan ? 3D. */
async function createAuthoredPoint(x: number, z: number) {
  try {
    const auth = await import("./authoring");
    const levels = listAvailableLevels();
    const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
    auth.setLevel(selected.elevation);
    const elev = selected.elevation + planElevOffset;
    const fitKinds = ["elbow", "tee", "cross", "transition", "cap", "union", "wye", "fitting"];
    if (planPointPreset && fitKinds.includes(planPointPreset)) {
      const kind = planPointPreset === "fitting" ? "elbow" : planPointPreset;
      const parent = planLinearType === "pipe" || planLinearType === "conduit" || planLinearType === "cable-tray"
        ? planLinearType : "duct";
      await (auth as any).addFittingElement?.(
        parent,
        kind,
        x, z, elev,
        { thickness: planWidth, height: planHeight },
      );
    } else {
      await auth.addPointElement(planPointType, x, z, elev, planPointPreset ?? undefined);
    }
    auth.setAuthoringTool("select");
    await regenerate();
    footerStatus(`${planPointPreset || planPointType} placed � synced to 3D`);
  } catch (err) {
    console.error("[plan] create point failed", err);
    footerStatus("Could not place point element");
  }
}


/* -- 2D plan box selection + move helpers (BIM window/crossing) -- */
function ensurePlanBoxOverlay(): SVGRectElement {
  if (planBoxOverlay && planBoxOverlay.parentNode) return planBoxOverlay;
  planBoxOverlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  planBoxOverlay.setAttribute("fill-opacity", "0.12");
  planBoxOverlay.setAttribute("stroke-width", "1");
  planBoxOverlay.setAttribute("pointer-events", "none");
  planBoxOverlay.style.display = "none";
  // Append to svg after render � store and re-attach in drawPlanBox
  return planBoxOverlay;
}

function drawPlanBox() {
  if (!planBoxStart || !planBoxCur || !currentPlan) return;
  const el = ensurePlanBoxOverlay();
  if (!el.parentNode) svg.appendChild(el);
  const a = clientToWorld(planBoxStart.x, planBoxStart.y);
  const b = clientToWorld(planBoxCur.x, planBoxCur.y);
  if (!a || !b) return;
  // SVG y is -world z
  const x = Math.min(a.x, b.x);
  const y = Math.min(-a.z, -b.z);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.z - a.z);
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(Math.max(w, 0.001)));
  el.setAttribute("height", String(Math.max(h, 0.001)));
  // Window (L?R): solid blue; Crossing (R?L): dashed green
  const crossing = planBoxCur.x < planBoxStart.x;
  if (crossing) {
    el.setAttribute("fill", "#22c55e");
    el.setAttribute("stroke", "#16a34a");
    el.setAttribute("stroke-dasharray", "0.15 0.1");
  } else {
    el.setAttribute("fill", "#38bdf8");
    el.setAttribute("stroke", "#0284c7");
    el.removeAttribute("stroke-dasharray");
  }
  el.style.display = "";
}

function clearPlanBox() {
  planBoxDragging = false;
  planBoxStart = null;
  planBoxCur = null;
  if (planBoxOverlay) planBoxOverlay.style.display = "none";
}

function elementInPlanBox(el: any, minX: number, maxX: number, minZ: number, maxZ: number, crossing: boolean): boolean {
  const p = el.params;
  const pts: { x: number; z: number }[] = [];
  if (p?.start && p?.end) {
    pts.push({ x: p.start[0], z: p.start[1] }, { x: p.end[0], z: p.end[1] });
    pts.push({ x: (p.start[0] + p.end[0]) / 2, z: (p.start[1] + p.end[1]) / 2 });
  } else if (p?.point) {
    pts.push({ x: p.point[0], z: p.point[1] });
  } else return false;
  if (crossing) {
    // Any point inside OR segment intersects box
    for (const q of pts) {
      if (q.x >= minX && q.x <= maxX && q.z >= minZ && q.z <= maxZ) return true;
    }
    if (p?.start && p?.end) {
      // coarse: midpoint already checked; also check if bbox overlaps
      const ex0 = Math.min(p.start[0], p.end[0]), ex1 = Math.max(p.start[0], p.end[0]);
      const ez0 = Math.min(p.start[1], p.end[1]), ez1 = Math.max(p.start[1], p.end[1]);
      if (!(ex1 < minX || ex0 > maxX || ez1 < minZ || ez0 > maxZ)) return true;
    }
    return false;
  }
  // Window: all key points inside
  return pts.every((q) => q.x >= minX && q.x <= maxX && q.z >= minZ && q.z <= maxZ);
}

async function commitPlanBoxSelect(additive: boolean) {
  if (!planBoxStart || !planBoxCur) return;
  const a = clientToWorld(planBoxStart.x, planBoxStart.y);
  const b = clientToWorld(planBoxCur.x, planBoxCur.y);
  if (!a || !b) { clearPlanBox(); return; }
  const dx = Math.abs(planBoxCur.x - planBoxStart.x);
  const dy = Math.abs(planBoxCur.y - planBoxStart.y);
  // Tiny drag ? single click select at start
  if (dx < 6 && dy < 6) {
    const hit = a;
    try {
      const { getElements } = await import("./authoring");
      const els = getElements();
      (window as any).__obsAuthoredElements = els;
      // Prefer thickness-aware nearest pick (ducts/walls easier to click)
      const near = nearestAuthoredAt(hit);
      let best = near.element;
      if (!best) {
        // Fallback wider search for thin lines
        let bestD = 1.2;
        for (const el of els) {
          const p = el.params;
          if (p?.start && p?.end) {
            const ax = p.start[0], az = p.start[1], bx = p.end[0], bz = p.end[1];
            const ddx = bx - ax, ddz = bz - az;
            const L2 = ddx * ddx + ddz * ddz || 1;
            let t = ((hit.x - ax) * ddx + (hit.z - az) * ddz) / L2;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * ddx, pz = az + t * ddz;
            const half = Math.max(0.05, (p.thickness ?? 0.2) * 0.5);
            const d = Math.hypot(hit.x - px, hit.z - pz) - half;
            if (d < bestD) { bestD = d; best = el; }
          } else if (p?.point) {
            const half = Math.max(0.1, (p.thickness ?? 0.3) * 0.5);
            const d = Math.hypot(hit.x - p.point[0], hit.z - p.point[1]) - half;
            if (d < bestD) { bestD = d; best = el; }
          }
        }
        if (bestD > 0.9) best = null;
      }
      if (best) {
        setPlanSelectedElement(best, additive ? "toggle" : "replace");
        footerStatus(planSelectedIds.size > 1 ? `${planSelectedIds.size} selected` : `Selected ${best.type}${best.name ? " � " + best.name : ""}`);
      } else if (!additive) {
        setPlanSelectedElement(null);
        footerStatus("Nothing selected � click a wall, duct, or object");
      }
    } catch (err) {
      console.warn("[plan] click select", err);
    }
    clearPlanBox();
    if (currentPlan) renderPlan(currentPlan);
    return;
  }
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
  const crossing = planBoxCur.x < planBoxStart.x;
  try {
    const { getElements, setSelectedAuthored } = await import("./authoring");
    const els = getElements();
    const hits = els.filter((el: any) => elementInPlanBox(el, minX, maxX, minZ, maxZ, crossing));
    const ids = hits.map((el: any) => el.id);
    if (!additive) planSelectedIds.clear();
    for (const id of ids) planSelectedIds.add(id);
    setSelectedAuthored(ids, additive ? "add" : "replace");
    footerStatus(
      `${crossing ? "Crossing" : "Window"}: ${ids.length} element(s)` +
      (planSelectedIds.size > ids.length ? ` � total ${planSelectedIds.size}` : ""),
    );
    renderPlanProperties();
  } catch (err) {
    console.warn("[plan] box select", err);
  }
  clearPlanBox();
  if (currentPlan) renderPlan(currentPlan);
}

async function moveSelectedInPlan(dx: number, dz: number) {
  if (!planSelectedIds.size || (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9)) return;
  try {
    const { getElements, rebuildAuthored, markAuthoringDirty, expandConnectedIds } = await import("./authoring");
    const { history } = await import("./history");
    const moveIds = new Set(expandConnectedIds(planSelectedIds));
    const els = getElements().filter((el: any) => moveIds.has(el.id));
    const before = els.map((el: any) => ({ id: el.id, params: JSON.parse(JSON.stringify(el.params)) }));
    for (const el of els) {
      if (el.properties?.pinned) continue;
      if (el.params.start) { el.params.start[0] += dx; el.params.start[1] += dz; }
      if (el.params.end) { el.params.end[0] += dx; el.params.end[1] += dz; }
      if (el.params.point) { el.params.point[0] += dx; el.params.point[1] += dz; }
      if (el.params.polygon) el.params.polygon = el.params.polygon.map(([x, z]: [number, number]) => [x + dx, z + dz]);
    }
    rebuildAuthored();
    markAuthoringDirty?.();
    const after = els.map((el: any) => ({ id: el.id, params: JSON.parse(JSON.stringify(el.params)) }));
    history.push({
      label: `Move ${els.length} element(s) in plan`,
      apply: () => {
        const all = getElements();
        for (const a of after) {
          const el = all.find((x: any) => x.id === a.id);
          if (el) el.params = JSON.parse(JSON.stringify(a.params));
        }
        rebuildAuthored(); markAuthoringDirty?.();
      },
      revert: () => {
        const all = getElements();
        for (const b of before) {
          const el = all.find((x: any) => x.id === b.id);
          if (el) el.params = JSON.parse(JSON.stringify(b.params));
        }
        rebuildAuthored(); markAuthoringDirty?.();
      },
    });
  } catch (err) {
    console.warn("[plan] move", err);
  }
}


// Right-click while placing (Revit): Finish chain / Cancel / Repeat. Never the browser menu.
canvasWrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const placing = planMode === "linear" || planMode === "point" || planMode === "dim" || planMode === "tag" || planMode === "text";
  document.getElementById("obs-plan-ctx")?.remove();
  if (!placing) return;
  const m = document.createElement("div");
  m.id = "obs-plan-ctx";
  m.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:100001;background:#fff;border:1px solid #cbd5e1;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,.25);font:12px system-ui;min-width:190px;padding:3px 0;color:#111827`;
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const item = (label: string, fn: () => void, enabled = true) => {
    const d = document.createElement("div");
    d.textContent = label;
    d.style.cssText = `padding:6px 14px;cursor:${enabled ? "pointer" : "default"};opacity:${enabled ? 1 : 0.4}`;
    if (enabled) {
      d.onmouseenter = () => { d.style.background = "#e0f2fe"; };
      d.onmouseleave = () => { d.style.background = ""; };
      d.onclick = () => { m.remove(); fn(); };
    }
    m.appendChild(d);
  };
  item("Finish chain  (Enter)", () => finishPlanChain(), planMode === "linear" && planChain.length > 0);
  item("Cancel  (Esc)", () => key("Escape"));
  item("Repeat last command  (Space)", () => key(" "));
  document.body.appendChild(m);
  const close = (ev: Event) => { if (!m.contains(ev.target as Node)) { m.remove(); window.removeEventListener("pointerdown", close, true); } };
  window.addEventListener("pointerdown", close, true);
});

canvasWrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;

  // Modeling / annotation tools only (select / navigate / move handled below)
  if (planMode === "linear" || planMode === "point" || planMode === "dim" || planMode === "tag" || planMode === "text") {
    let w = clientToWorld(e.clientX, e.clientY);
    if (!w) return;
    let sn = findPlanSnap(w.x, w.z);
    if (planMode === "dim") {
      const dh = findDimensionBoundary(w);
      sn = dh ? { x: dh.point.x, z: dh.point.z, kind: "Boundary" } : null;
      if (dh) w = { x: dh.point.x, z: dh.point.z };
    } else if (sn) {
      w = { x: sn.x, z: sn.z };
    }
    planSnap = sn;
    e.preventDefault();
    e.stopPropagation();

    if (planMode === "linear") {
      // BIM continuous path: each click adds a segment
      if (planChain.length === 0) {
        planChain.push(w);
        planDrawStart = w;
        planTypedLength = "";
        footerStatus(`Click to enter ${planLinearType} next point (Shift = ortho, type a length + Enter)`);
      } else {
        const prev = planChain[planChain.length - 1];
        if (e.shiftKey) w = constrainOrtho(prev, w);
        // Ignore a double click / zero-length segment.
        if (Math.hypot(w.x - prev.x, w.z - prev.z) < 0.001) return;
        planTypedLength = "";
        planChain.push(w);
        planDrawStart = w;
        void createAuthoredLinear(prev.x, prev.z, w.x, w.z);
      }
      return;
    }

    if (planMode === "dim") {
      if (planDimStyle === "auto") { handleAutoDimClick(w); return; }
      // -- Spot Elevation / Coordinate: single click (BIM Spot tools) --
      if (planDimStyle === "elevation" || planDimStyle === "coordinate") {
        const pt = findNearestPointElement(w) ?? { x: w.x, z: w.z, elev: (() => {
          try {
            const levels = listAvailableLevels();
            const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
            return selected.elevation + planElevOffset;
          } catch { return 0; }
        })() };
        const label = planDimStyle === "elevation"
          ? `EL ${formatPlanDimension(pt.elev, getDimensionStyle())}`
          : `X ${formatPlanDimension(pt.x, getDimensionStyle())}  Z ${formatPlanDimension(pt.z, getDimensionStyle())}`;
        planDims.push({
          x1: pt.x, z1: pt.z, x2: pt.x, z2: pt.z,
          style: planDimStyle, offsetMm: DIM_OFFSET_MM,
          label, value: planDimStyle === "elevation" ? pt.elev : undefined,
        });
        if (currentPlan) renderPlan(currentPlan);
        footerStatus(`${planDimStyle === "elevation" ? "Spot Elevation" : "Spot Coordinate"}: ${label} � click next � Esc = Select`);
        return;
      }

      // -- Angular: pick two linear segments (Angular Dimension Dimension) --
      if (planDimStyle === "angular") {
        const seg = findNearestSegment(w);
        if (!seg) {
          footerStatus("Angular: pick a wall / line edge (near a segment)");
          return;
        }
        if (!planDimSeg1) {
          planDimSeg1 = { x1: seg.x1, z1: seg.z1, x2: seg.x2, z2: seg.z2 };
          planDrawStart = { x: (seg.x1 + seg.x2) / 2, z: (seg.z1 + seg.z2) / 2 };
          footerStatus("Angular: pick second line / edge");
        } else {
          const s2 = { x1: seg.x1, z1: seg.z1, x2: seg.x2, z2: seg.z2 };
          const { deg, vx, vz } = segmentAngleDeg(planDimSeg1, s2);
          planDims.push({
            x1: planDimSeg1.x1, z1: planDimSeg1.z1,
            x2: s2.x1, z2: s2.z1,
            style: "angular", offsetMm: DIM_OFFSET_MM,
            value: deg, vx, vz,
            label: `${deg.toFixed(1)}�`,
          });
          planDimSeg1 = null;
          planDrawStart = null;
          planDimStartRef = null;
          if (currentPlan) renderPlan(currentPlan);
          footerStatus(`Angular ${deg.toFixed(1)}� � click next first edge � Esc = Select`);
        }
        return;
      }

      // -- Radial / Diameter: center then edge (or edge of round element) --
      if (planDimStyle === "radial" || planDimStyle === "diameter") {
        if (!planDrawStart) {
          const center = findNearestPointElement(w) ?? { x: w.x, z: w.z, elev: 0 };
          planDrawStart = { x: center.x, z: center.z };
          footerStatus(`${planDimStyle === "radial" ? "Radial" : "Diameter"}: pick edge / radius point`);
        } else {
          const r = Math.hypot(w.x - planDrawStart.x, w.z - planDrawStart.z);
          if (r < 0.001) {
            footerStatus("Radius is zero � pick a different point");
            return;
          }
          const isRad = planDimStyle === "radial";
          const val = isRad ? r : r * 2;
          const label = isRad
            ? `R ${formatPlanDimension(r, getDimensionStyle())}`
            : `? ${formatPlanDimension(val, getDimensionStyle())}`;
          planDims.push({
            x1: planDrawStart.x, z1: planDrawStart.z,
            x2: w.x, z2: w.z,
            style: planDimStyle, offsetMm: DIM_OFFSET_MM,
            value: val, label,
          });
          planDrawStart = null;
          if (currentPlan) renderPlan(currentPlan);
          footerStatus(`${label} � click next center � Esc = Select`);
        }
        return;
      }

      // -- Arc length: two points along a segment (approx chord length) --
      if (planDimStyle === "arc") {
        const hit = findDimensionBoundary(w) ?? (findNearestSegment(w) ? {
          point: w,
          ref: { kind: "static-boundary" as const, x: w.x, z: w.z },
          distance: 0,
        } : null);
        if (!hit) {
          footerStatus("Arc: pick a point on a curved / linear edge");
          return;
        }
        const pt = "point" in hit ? hit.point : w;
        const ref = "ref" in hit ? hit.ref : { kind: "static-boundary" as const, x: pt.x, z: pt.z };
        if (!planDrawStart || !planDimStartRef) {
          planDrawStart = pt;
          planDimStartRef = ref as PlanDimensionRef;
          footerStatus("Arc length: pick second point on the arc");
        } else {
          const len = Math.hypot(pt.x - planDrawStart.x, pt.z - planDrawStart.z);
          if (len < 0.001) {
            footerStatus("Arc length is zero � pick a different point");
            return;
          }
          planDims.push({
            x1: planDrawStart.x, z1: planDrawStart.z, x2: pt.x, z2: pt.z,
            style: "arc", offsetMm: DIM_OFFSET_MM,
            ref1: planDimStartRef, ref2: ref as PlanDimensionRef,
            value: len, label: `? ${formatPlanDimension(len, getDimensionStyle())}`,
          });
          planDrawStart = null;
          planDimStartRef = null;
          if (currentPlan) renderPlan(currentPlan);
          footerStatus(`Arc ${formatPlanDimension(len, getDimensionStyle())} � click next � Esc = Select`);
        }
        return;
      }

      // Chain dimension: pick every boundary first; the dimensions appear only when an empty-space
      // click places the chain line (Enter = default offset, Esc = cancel).
      if (planDimChain && (planDimStyle === "aligned" || planDimStyle === "linear")) {
        const chainHit = findDimensionBoundary(w);
        if (chainHit) {
          const last = planDimChainPts[planDimChainPts.length - 1];
          if (last && Math.hypot(last.x - chainHit.point.x, last.z - chainHit.point.z) < 0.001) {
            footerStatus("Chain: that boundary is already picked - pick the next one");
            return;
          }
          planDimChainPts.push({ x: chainHit.point.x, z: chainHit.point.z, ref: chainHit.ref as PlanDimensionRef });
          planDrawStart = null; planDimStartRef = null;
          if (currentPlan) renderPlan(currentPlan);
          footerStatus(`Chain: ${planDimChainPts.length} boundar${planDimChainPts.length === 1 ? "y" : "ies"} picked - ${planDimChainPts.length < 2 ? "pick the next boundary" : "pick more, or click empty space to place the chain (Enter = default, Esc = cancel)"}`);
        } else {
          finishDimChain({ x: w.x, z: w.z });
        }
        return;
      }

      // Aligned / Linear: three-point flow (start, end, offset position)
      if (planDimPendingRefs && (planDimStyle === "aligned" || planDimStyle === "linear")) {
        const pr = planDimPendingRefs;
        const ddx = pr.x2 - pr.x1;
        const ddz = pr.z2 - pr.z1;
        const LL = Math.hypot(ddx, ddz);
        if (LL < 1e-6) {
          planDimPendingRefs = null;
          footerStatus("References too close - try again");
          return;
        }
        const uux = ddx / LL;
        const uuz = ddz / LL;
        const nnx = -uuz;
        const nnz = uux;
        const offset_m = (w.x - pr.x1) * nnx + (w.z - pr.z1) * nnz;
        const offsetMm = Math.max(-3000, Math.min(3000, (offset_m / planViewScale) * 1000));
        const dim: PlanDimension = {
          x1: pr.x1, z1: pr.z1, x2: pr.x2, z2: pr.z2,
          style: pr.kind,
          offsetMm,
          ref1: pr.ref1,
          ref2: pr.ref2,
        };
        { const beforeSnap = dimSnapshot(); planDims.push(dim); recordDims("Place dimension", beforeSnap); }
        const shortLen = formatPlanDimension(LL, getDimensionStyle());
        const styleName = planDimStyle === "linear" ? "Linear" : "Aligned";
        if (planDimChain) {
          planDrawStart = { x: pr.x2, z: pr.z2 };
          planDimStartRef = pr.ref2;
          planDimPendingRefs = null;
          footerStatus(styleName + " " + shortLen + " - chain: pick next boundary");
        } else {
          planDrawStart = null;
          planDimStartRef = null;
          planDimPendingRefs = null;
          footerStatus(styleName + " " + shortLen + " - click next first boundary");
        }
        if (currentPlan) renderPlan(currentPlan);
        return;
      }

      const hit = findDimensionBoundary(w);
      if (!hit) {
        footerStatus("Pick a visible model boundary - dimensions cannot terminate in empty space");
        return;
      }
      w = hit.point;
      if (!planDrawStart || !planDimStartRef) {
        planDrawStart = w;
        planDimStartRef = hit.ref;
        const name = planDimStyle === "linear" ? "Linear" : "Aligned";
        footerStatus(name + " dimension: pick second model boundary");
      } else {
        const a = planDrawStart;
        const aRef = planDimStartRef;
        let b = { x: w.x, z: w.z };
        let style: PlanDimKind = planDimStyle === "linear" ? "linear" : "aligned";
        if (planDimStyle === "linear") {
          const dx = Math.abs(w.x - a.x);
          const dz = Math.abs(w.z - a.z);
          if (dx >= dz) b = { x: w.x, z: a.z };
          else b = { x: a.x, z: w.z };
        } else {
          b = { x: w.x, z: w.z };
          style = "aligned";
        }
        if (Math.hypot(b.x - a.x, b.z - a.z) < 0.001) {
          footerStatus("Dimension is zero length - pick a different boundary");
          return;
        }
        planDimPendingRefs = {
          ref1: aRef,
          ref2: hit.ref,
          x1: a.x, z1: a.z, x2: b.x, z2: b.z,
          kind: style,
        };
        planDrawStart = null;
        planDimStartRef = null;
        footerStatus("Click to place the dimension line (third point = position)");
        if (currentPlan) renderPlan(currentPlan);
      }
      return;
    }

    if (planMode === "point") {
      void createAuthoredPoint(w.x, w.z);
      return;
    }

    if (planMode === "tag") {
      const hit = nearestAuthoredAt(w);
      if (hit.element) {
        const mode = (window as any).__obsPlanTagMode ?? "category";
        const p = hit.element.params ?? {};
        const mark = hit.element.properties?.Mark ?? hit.element.properties?.mark ?? hit.element.name ?? hit.element.type;
        const material = hit.element.properties?.Material ?? hit.element.properties?.material ?? "Material";
        const label = mode === "material" ? String(material) : mode === "room" ? `Room ${hit.element.name ?? hit.element.id}` : String(mark);
        { const beforeAnno = annoSnapshot(); planTags.push({ x:w.x, z:w.z, text:label, elementId:hit.element.id, leader:true, mode }); recordAnno("Place tag", beforeAnno); }
        if (currentPlan) renderPlan(currentPlan);
        setPlanSelectedElement(hit.element);
        footerStatus(`${mode === "room" ? "Room" : "Tag"}: ${label}`);
      } else {
        const label = prompt("Tag text:", "TAG");
        if (label != null && label.trim()) {
          { const beforeAnno = annoSnapshot(); planTags.push({ x:w.x, z:w.z, text:label.trim(), mode:"custom" }); recordAnno("Place tag", beforeAnno); }
          if (currentPlan) renderPlan(currentPlan);
          footerStatus(`Tag: ${label.trim()}`);
        }
      }
      return;
    }

    if (planMode === "text") {
      const note = prompt("Text note (use \\n for a new line):", "Note");
      if (note != null && note.trim()) {
        { const beforeAnno = annoSnapshot(); planNotes.push({ x: w.x, z: w.z, text: note.trim().replace(/\\n/g, "\n") }); recordAnno("Place note", beforeAnno); }
        if (currentPlan) renderPlan(currentPlan);
        footerStatus(`Text placed`);
      }
      return;
    }
    return;
  }

  // -- Navigate (Pan tool): left-drag pans without resetting zoom --
  if (planMode === "navigate") {
    panning = true;
    lastMouse = { x: e.clientX, y: e.clientY };
    canvasWrap.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }

  // -- Move tool: drag selected elements --
  if (planMode === "move") {
    const hit = clientToWorld(e.clientX, e.clientY);
    if (!hit) return;
    if (planSelectedIds.size === 0) {
      footerStatus("Select elements first (Modify | Select), then Move");
      return;
    }
    planMoveDragging = true;
    planMoveLast = hit;
    e.preventDefault();
    footerStatus(`Moving ${planSelectedIds.size} element(s)�`);
    return;
  }

  // -- Select: click OR start box (window L?R / crossing R?L) --
  if (planMode === "select" || planMode === "pan") {
    // Refresh authored cache so click always sees latest elements
    try {
      void import("./authoring").then((m) => {
        (window as any).__obsAuthoredElements = m.getElements();
      });
    } catch { /* */ }
    const hit = clientToWorld(e.clientX, e.clientY);
    // Dimensions are selectable / draggable like Revit: click a dimension line or its text.
    if (planMode === "select" && hit && e.button === 0) {
      const dh = hitDimension(hit.x, hit.z);
      if (dh) {
        setPlanSelectedElement(null);
        planDimSel = dh;
        planDimDrag = { members: dimMembers(dh), before: dimSnapshot(), moved: false, sx: e.clientX, sy: e.clientY };
        footerStatus(`Dimension selected${dh.chainId ? " (chain - drag moves it, E toggles EQ)" : ""} - Delete removes, double-click edits text, Esc deselects`);
        if (currentPlan) renderPlan(currentPlan);
        e.preventDefault();
        return;
      } else if (planDimSel) {
        planDimSel = null;
        if (currentPlan) renderPlan(currentPlan);
      }
      const ah = hitAnnotation(hit.x, hit.z);
      if (ah) {
        setPlanSelectedElement(null);
        planDimSel = null;
        planAnnoSel = ah;
        planAnnoDrag = { sel: ah, dx: ah.obj.x - hit.x, dz: ah.obj.z - hit.z, before: annoSnapshot(), moved: false, sx: e.clientX, sy: e.clientY };
        footerStatus(`${ah.kind === "tag" ? "Tag" : "Note"} selected - drag to move, double-click to edit, Delete removes`);
        if (currentPlan) renderPlan(currentPlan);
        e.preventDefault();
        return;
      } else if (planAnnoSel) {
        planAnnoSel = null;
        if (currentPlan) renderPlan(currentPlan);
      }
    }
    planBoxDragging = true;
    planBoxStart = { x: e.clientX, y: e.clientY, wx: hit?.x ?? 0, wz: hit?.z ?? 0 };
    planBoxCur = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }

  // Fallback click-select
  const hit = clientToWorld(e.clientX, e.clientY);
  if (hit) {
    void (async () => {
      try {
        const { getElements } = await import("./authoring");
        const els = getElements();
        (window as any).__obsAuthoredElements = els;
        let best: any = null;
        let bestD = 0.6;
        for (const el of els) {
          const p = el.params;
          if (p.start && p.end) {
            const ax = p.start[0], az = p.start[1], bx = p.end[0], bz = p.end[1];
            const dx = bx - ax, dz = bz - az;
            const L2 = dx * dx + dz * dz || 1;
            let t = ((hit.x - ax) * dx + (hit.z - az) * dz) / L2;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, pz = az + t * dz;
            const d = Math.hypot(hit.x - px, hit.z - pz);
            if (d < bestD) { bestD = d; best = el; }
          } else if (p.point) {
            const d = Math.hypot(hit.x - p.point[0], hit.z - p.point[1]);
            if (d < bestD) { bestD = d; best = el; }
          }
        }
        if (best) {
          const mode = e.ctrlKey || e.metaKey ? "toggle" : "replace";
          setPlanSelectedElement(best, mode);
          footerStatus(planSelectedIds.size > 1 ? `${planSelectedIds.size} elements selected` : `Selected ${best.type} � ${best.name ?? best.id}`);
        } else {
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setPlanSelectedElement(null);
          footerStatus(planSelectedIds.size ? `${planSelectedIds.size} elements selected` : "Nothing selected");
        }
      } catch { /* */ }
    })();
  }
});

// Dimension drag (move the dimension line / whole chain) and text edit.
window.addEventListener("mousemove", (e) => {
  const dr = planDimDrag;
  if (!dr || !currentPlan) return;
  if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return;
  const w = clientToWorld(e.clientX, e.clientY);
  if (!w) return;
  dr.moved = true;
  for (const m of dr.members) {
    const { p1, p2 } = resolvedDimPoints(m);
    moveDimLineTo(m, p1, p2, w, planViewScale);
  }
  renderPlan(currentPlan);
});
window.addEventListener("mousemove", (e) => {
  const dr = planAnnoDrag;
  if (!dr || !currentPlan) return;
  if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return;
  const w = clientToWorld(e.clientX, e.clientY);
  if (!w) return;
  dr.moved = true;
  dr.sel.obj.x = w.x + dr.dx; dr.sel.obj.z = w.z + dr.dz;
  renderPlan(currentPlan);
});
window.addEventListener("mouseup", () => {
  const dr = planAnnoDrag;
  if (!dr) return;
  planAnnoDrag = null;
  if (dr.moved) { recordAnno(dr.sel.kind === "tag" ? "Move tag" : "Move note", dr.before); footerStatus("Moved - Ctrl+Z undo"); }
});
window.addEventListener("mouseup", () => {
  const dr = planDimDrag;
  if (!dr) return;
  planDimDrag = null;
  if (dr.moved) { recordDims("Move dimension", dr.before); footerStatus("Dimension moved - Ctrl+Z undo"); }
});
canvasWrap.addEventListener("dblclick", (e) => {
  if (planMode !== "select") return;
  const w = clientToWorld(e.clientX, e.clientY);
  const an = w ? hitAnnotation(w.x, w.z) : null;
  if (an && w) {
    e.preventDefault(); e.stopPropagation();
    const beforeAnno = annoSnapshot();
    if (an.kind === "note") {
      const v = window.prompt("Note text (use \\n for a new line):", an.obj.text.replace(/\n/g, "\\n"));
      if (v == null || !v.trim()) return;
      an.obj.text = v.trim().replace(/\\n/g, "\n");
    } else {
      const t = an.obj;
      const v = window.prompt(t.elementId && t.mode === "category" ? "Tag text (sets the element's Mark):" : "Tag text:", liveTagText(t));
      if (v == null || !v.trim()) return;
      const el = t.elementId ? authoredEls().find((x) => String(x?.id) === String(t.elementId)) : null;
      if (el && t.mode === "category") {
        el.properties = { ...(el.properties ?? {}), Mark: v.trim() };
        try { import("./authoring").then((m: any) => m.markAuthoringDirty?.()); } catch { /* */ }
      } else {
        t.mode = "custom";
      }
      t.text = v.trim();
    }
    recordAnno("Edit annotation text", beforeAnno);
    planAnnoSel = an;
    if (currentPlan) renderPlan(currentPlan);
    return;
  }
  const d = w ? hitDimension(w.x, w.z) : null;
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  const cur = d.textOverride ?? "";
  const next = window.prompt("Dimension text (leave empty to show the measured value):", cur);
  if (next == null) return;
  const beforeSnap = dimSnapshot();
  const txt = next.trim();
  if (txt) d.textOverride = txt; else delete d.textOverride;
  recordDims("Edit dimension text", beforeSnap);
  planDimSel = d;
  if (currentPlan) renderPlan(currentPlan);
}, true);

// Middle-button pan (BIM). Shift+left drag pans only in Navigate/Pan: while placing, Shift = ortho constraint.
canvasWrap.addEventListener("mousedown", (e) => {
  if (e.button !== 1 && !(e.button === 0 && e.shiftKey && (planMode === "navigate" || planMode === "pan"))) return;
  if (!currentPlan) return;
  e.preventDefault();
  e.stopPropagation();
  panning = true;
  lastMouse = { x: e.clientX, y: e.clientY };
  canvasWrap.style.cursor = "grabbing";
  try { canvasWrap.setPointerCapture((e as any).pointerId ?? 1); } catch { /* */ }
});
// Prevent browser auto-scroll on middle-click
canvasWrap.addEventListener("auxclick", (e) => { e.preventDefault(); }, { passive: false });
canvasWrap.addEventListener("mouseup", (e) => {
  if (e.button === 1 && panning) {
    panning = false;
    canvasWrap.style.cursor = planMode === "navigate" ? "grab" : planMode === "move" ? "move" : "default";
  }
});

window.addEventListener("mousemove", (e) => {
  if (!currentPlan) return;

  // 1. Pan first (MMB / Shift+LMB / Navigate tool) — never blocked by tools
  if (panning) {
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    lastMouse = { x: e.clientX, y: e.clientY };
    const rect = canvasWrap.getBoundingClientRect();
    const b = currentPlan.bounds;
    const pad = planCropView ? 0.5 : 3;
    const vbW = Math.max(0.1, (b.maxX - b.minX) + 2 * pad);
    const vbH = Math.max(0.1, (b.maxZ - b.minZ) + 2 * pad);
    const scale = Math.min(rect.width / (vbW / currentZoom), rect.height / (vbH / currentZoom));
    const worldPerPx = 1 / Math.max(scale, 1e-6);
    panX -= dx * worldPerPx;
    panY -= dy * worldPerPx;
    planViewUserAdjusted = true;
    renderPlan(currentPlan);
    return;
  }

  // 2. Plan box selection rubber-band
  if (planBoxDragging && planBoxStart) {
    planBoxCur = { x: e.clientX, y: e.clientY };
    drawPlanBox();
    return;
  }

  // 3. Move selected elements
  if (planMoveDragging && planMoveLast) {
    const w = clientToWorld(e.clientX, e.clientY);
    if (w) {
      const dx = w.x - planMoveLast.x;
      const dz = w.z - planMoveLast.z;
      planMoveLast = w;
      void moveSelectedInPlan(dx, dz);
      if (currentPlan) renderPlan(currentPlan);
    }
    return;
  }

  // 4. Fast path: only update the cursor overlay (snap markers + rubber band)
  if (planMode !== "pan" && planMode !== "select" && planMode !== "navigate" && planMode !== "move") {
    const w = clientToWorld(e.clientX, e.clientY);
    if (w) {
      if (planMode === "dim") {
        resetSnapCycleIfMoved(w);
        const hit = findDimensionBoundary(w);
        if (hit) {
          const h = hit as any;
          planSnap = {
            x: hit.point.x,
            z: hit.point.z,
            kind: String(h.kind ?? "face"),
            label: h.label ? String(h.label) + (h.alt ? `  (Tab ${h.alt.index}/${h.alt.count})` : "") : undefined,
            ref: hit.ref,
          };
          planCursor = { x: hit.point.x, z: hit.point.z };
        } else {
          planSnap = null;
          planCursor = w;
        }
      } else {
        const sn = findPlanSnap(w.x, w.z);
        planSnap = sn;
        planCursor = sn ? { x: sn.x, z: sn.z } : w;
        if (planMode === "linear" && planDrawStart) {
          if (e.shiftKey) { planCursor = constrainOrtho(planDrawStart, planCursor); planSnap = null; }
          if (!planTypedLength) {
            const len = Math.hypot(planCursor.x - planDrawStart.x, planCursor.z - planDrawStart.z);
            footerStatus(`${planLinearType}  length ${len.toFixed(3)} m  angle ${angleDeg(planDrawStart, planCursor).toFixed(1)}\u00b0${e.shiftKey ? "  (ortho)" : ""}`);
          }
        }
      }
      updateSnapOverlay();
    }
    return;
  }
});

window.addEventListener("mouseup", (e) => {
  if (panning) {
    panning = false;
    canvasWrap.style.cursor = planMode === "navigate" ? "grab" : planMode === "move" ? "move" : planMode === "select" || planMode === "pan" ? "default" : "crosshair";
  }
  if (planBoxDragging) {
    const additive = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
    void commitPlanBoxSelect(additive);
  }
  if (planMoveDragging) {
    planMoveDragging = false;
    planMoveLast = null;
    footerStatus(planSelectedIds.size ? `Moved � ${planSelectedIds.size} selected � Ctrl+Z undo` : "Move done");
    void regenerate(); // sync 3D; zoom/pan preserved
  }
});

canvasWrap.addEventListener(
  "wheel",
  (e) => {
    if (!currentPlan) return;
    e.preventDefault();
    e.stopPropagation();

    // Zoom toward cursor (CAD / BIM plan behavior � not fixed to center)
    const rect = canvasWrap.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const ratioX = (e.clientX - rect.left) / rect.width;
    const ratioY = (e.clientY - rect.top) / rect.height;

    const b = currentPlan.bounds;
    const pad = 3;
    const vbW = Math.max(0.1, (b.maxX - b.minX) + 2 * pad);
    const vbH = Math.max(0.1, (b.maxZ - b.minZ) + 2 * pad);

    const oldZoom = currentZoom;
    // Smooth exponential zoom; trackpad + mouse wheel
    const factor = Math.exp(-e.deltaY * 0.0012);
    const newZoom = Math.max(0.05, Math.min(40, oldZoom * factor));
    if (Math.abs(newZoom - oldZoom) < 1e-6) return;

    // Keep the world point under the cursor fixed:
    // worldX = cx + panX + (ratioX - 0.5) * (vbW / zoom)
    // pan' = pan + (ratio - 0.5) * vb * (1/old - 1/new)
    panX += (ratioX - 0.5) * vbW * (1 / oldZoom - 1 / newZoom);
    panY += (ratioY - 0.5) * vbH * (1 / oldZoom - 1 / newZoom);
    currentZoom = newZoom;
    planViewUserAdjusted = true;
    renderPlan(currentPlan);
  },
  { passive: false },
);

canvasWrap.addEventListener("dblclick", () => {
  currentZoom = 1;
  panX = 0;
  panY = 0;
  planViewUserAdjusted = false;
  if (currentPlan) renderPlan(currentPlan);
  footerStatus("Fit view");
});

/* -------------------------------------------------------------------------
   Generation
   ------------------------------------------------------------------------- */
/**
 * Plan regeneration is coalesced: a burst of edits (drawing a chain of segments) triggers one rebuild,
 * and edits made while a rebuild is running trigger exactly one follow-up instead of being dropped.
 */
let regenTimer: ReturnType<typeof setTimeout> | null = null;
let regenWaiters: Array<() => void> = [];
let regenPending = false;
function regenerate(): Promise<void> {
  return new Promise<void>((resolve) => {
    regenWaiters.push(resolve);
    if (regenTimer) clearTimeout(regenTimer);
    regenTimer = setTimeout(() => { regenTimer = null; void runRegenerate(); }, 40);
  });
}
async function runRegenerate(): Promise<void> {
  if (generating) { regenPending = true; return; }
  const waiters = regenWaiters;
  regenWaiters = [];
  try {
    await regenerateNow();
  } finally {
    for (const w of waiters) w();
    if (regenPending || regenWaiters.length) {
      regenPending = false;
      if (regenTimer) clearTimeout(regenTimer);
      regenTimer = setTimeout(() => { regenTimer = null; void runRegenerate(); }, 0);
    }
  }
}

async function regenerateNow() {
  if (generating) return;
  generating = true;
  loading.style.display = "flex";
  loadingBarInner.style.width = "0%";
  cancelHandle = { cancelled: false };

  try {
    const levels = listAvailableLevels();
    const selected = levels[Number(levelSelect.value) || 0] ?? levels[0];
    const plan = await generatePlanView({
      levelName: selected.name,
      levelElevation: selected.elevation,
      cutHeight,
      cutDepth: Math.max(planViewRangeDepth, Math.abs(planViewRangeBottom)), // include more authored geometry at this level
      includeOverhead: true,
      includeBelow: true,
      maxSegments: 250_000,
      signal: cancelHandle,
      onProgress: (p) => {
        loadingText.textContent = p.phase;
        loadingBarInner.style.width = `${Math.min(95, (p.current / Math.max(1, p.total)) * 100)}%`;
      },
    });
    if (cancelHandle.cancelled) return;
    currentPlan = plan;
    try {
      const { getElements } = await import("./authoring");
      (window as any).__obsAuthoredElements = getElements();
    } catch { /* authored layer optional */ }
    // Preserve zoom/pan (BIM: regenerating plan does NOT fit � only explicit Fit / first open)
    if (!planViewUserAdjusted) {
      currentZoom = 1;
      panX = 0;
      panY = 0;
    }
    renderPlan(plan);
    applyCadUnderlay();
  } catch (err) {
    console.error("[plan] generation failed", err);
    alert("Plan generation failed � see console. Check model is loaded.");
  } finally {
    generating = false;
    loading.style.display = "none";
    cancelHandle = null;
  }
}

/* -------------------------------------------------------------------------
   Level dropdown population
   ------------------------------------------------------------------------- */
function populateLevels() {
  const levels = listAvailableLevels();
  levelSelect.innerHTML = levels
    .map((l, i) => `<option value="${i}">${l.name} (+${l.elevation.toFixed(2)} m)</option>`)
    .join("");
}

/* -------------------------------------------------------------------------
   Print / Export
   ------------------------------------------------------------------------- */
function printPlan() {
  if (!currentPlan) {
    alert("Generate a plan first.");
    return;
  }
  const svgMarkup = svg.outerHTML;
  const html = `
    <!doctype html><html><head><title>Plan � ${currentPlan.level.name}</title>
    <style>
      body { margin:0; padding:16px; font:12px system-ui; background:#fff; }
      svg { width:100%; height:auto; max-height:calc(100vh - 60px); }
      @page { size: A3 landscape; margin: 8mm; }
    </style>
    </head><body>${svgMarkup}
    <script>window.onload = () => setTimeout(() => window.print(), 300);</script>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) {
    alert("Popup blocked. Allow popups to print.");
    return;
  }
  w.document.write(html);
  w.document.close();
}

function exportSvg() {
  if (!currentPlan) {
    alert("Generate a plan first.");
    return;
  }
  // Build a clean SVG that keeps the current viewBox
  const svgMarkup = svg.outerHTML;
  const blob = new Blob(
    [`<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}`],
    { type: "image/svg+xml" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `plan-${currentPlan.level.name.replace(/\s+/g, "_")}-${Date.now()}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* -------------------------------------------------------------------------
   Public
   ------------------------------------------------------------------------- */
function layoutUnderRibbon() {
  // Measure ribbon so plan viewport sits exactly under tabs (like BIM).
  // Respects minimized (flat) ribbon: only tabs height remains.
  try {
    const ribbon = document.querySelector(".obs-ribbon") as HTMLElement | null;
    const h = ribbon ? ribbon.getBoundingClientRect().height : 88;
    // When minimized, height is ~32px (tabs only); keep a small minimum
    overlay.style.top = `${Math.max(28, Math.round(h))}px`;
    overlay.style.left = "0";
  } catch {
    overlay.style.top = "88px";
  }
}

// Keep plan aligned when ribbon is minimized / restored
window.addEventListener("obs-ribbon-resize", () => {
  if (isPlanViewVisible()) layoutUnderRibbon();
});
window.addEventListener("resize", () => {
  if (isPlanViewVisible()) layoutUnderRibbon();
});

export function togglePlanView() {
  const visible = overlay.style.display === "flex";
  if (visible) {
    overlay.style.display = "none";
    try {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: { message: "3D View", kind: "info" },
      }));
    } catch { /* */ }
  } else {
    layoutUnderRibbon();
    overlay.style.display = "flex";
    populateLevels();
    planMode = "select";
    planDrawStart = null;
    planChain = [];
    canvasWrap.style.cursor = "default";
    toolHint.textContent = "Modify | Select � click object � drag box � Delete � Ctrl+Z";
    // Sync from 3D model into 2D
    void regenerate();
    renderPlanProperties();
    try {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: {
          message: "Floor Plan � Properties on the left � ribbon tools model in plan",
          kind: "success",
        },
      }));
    } catch { /* */ }
  }
}

export function isPlanViewVisible() {
  return overlay.style.display === "flex";
}

/** Called when user picks Architecture Wall etc. while plan is open. */
export function setPlanToolFromRibbon(tool: string) {
  if (!isPlanViewVisible()) return;
  planDrawStart = null;
  planSnap = null;
  const linear = [
    "wall", "beam", "strip", "duct", "pipe", "cable-tray", "conduit", "mline",
    "brace", "truss",
  ];
  const points: Record<string, { type: PointKind; preset?: string }> = {
    column: { type: "column" },
    footing: { type: "footing" },
    pile: { type: "footing" },
    equipment: { type: "equipment" },
    terminal: { type: "equipment", preset: "air-terminal" },
    accessory: { type: "equipment" },
    fitting: { type: "equipment", preset: "fitting" },
    elbow: { type: "equipment", preset: "elbow" },
    tee: { type: "equipment", preset: "tee" },
    cross: { type: "equipment", preset: "cross" },
    flex: { type: "equipment" },
    equip: { type: "equipment" },
    fixture: { type: "equipment" },
    pump: { type: "equipment", preset: "pump" },
    main: { type: "equipment" },
    outlet: { type: "equipment", preset: "outlet" },
    switch: { type: "equipment", preset: "switch" },
    panel: { type: "equipment", preset: "panel" },
    "junction-box": { type: "equipment", preset: "junction-box" },
    "lighting-fixture": { type: "equipment", preset: "lighting-fixture" },
    sprinkler: { type: "equipment", preset: "sprinkler" },
    "air-terminal": { type: "equipment", preset: "air-terminal" },
    transformer: { type: "equipment", preset: "transformer" },
    generator: { type: "equipment", preset: "generator" },
    door: { type: "equipment", preset: "door" },
    window: { type: "equipment", preset: "window" },
  };
  // Remember for Backspace repeat
  try {
    import("./authoring").then((m) => {
      if (tool && tool !== "select") m.setLastCommand?.(tool);
    }).catch(() => {});
  } catch { /* */ }

  if (linear.includes(tool)) {
    planMode = "linear";
    planLinearType = (tool === "brace" || tool === "truss" ? "beam" : tool) as LinearKind;
    if (tool === "brace" || tool === "truss") planLinearType = "beam";
    else planLinearType = tool as LinearKind;
    planChain = [];
    planDrawStart = null;
    applyDefaultSizeForTool(tool === "brace" || tool === "truss" ? "beam" : tool);
    canvasWrap.style.cursor = "crosshair";
    // BIM Place order: Type active ? click start ? click end ? continue chain
    toolHint.textContent = `Modify | Place ${tool} � Enter finish path � Esc cancel � Space repeat`;
    footerStatus(`Place ${tool}: click to enter start point � snaps ON`);
    setPlanSelectedElement(null);
    renderPlanProperties();
    try {
      // Show wall location-line / chain only for walls; always show W/H/Elev for linear
      showWallOpts(tool === "wall");
    } catch { /* */ }
  } else if (points[tool]) {
    planMode = "point";
    planPointType = points[tool].type;
    planPointPreset = points[tool].preset ?? null;
    canvasWrap.style.cursor = "crosshair";
    toolHint.textContent = `${tool} � click to place � Esc cancel � Backspace repeat`;
    footerStatus(`Plan ${tool}: click to place`);
    setPlanSelectedElement(null);
    renderPlanProperties();
    try { showWallOpts(false); } catch { /* */ }
  } else if (tool === "pan" || tool === "navigate") {
    // BIM Pan: only changes navigation mode � NEVER resets zoom/fit
    planMode = "navigate";
    planChain = [];
    planDrawStart = null;
    canvasWrap.style.cursor = "grab";
    toolHint.textContent = "Pan � drag to pan � wheel zoom � view kept";
    footerStatus("Pan mode � view is not reset");
    try { showWallOpts(false); } catch { /* */ }
  } else if (tool === "select" || tool === "copy") {
    planMode = "select";
    planChain = [];
    planDrawStart = null;
    canvasWrap.style.cursor = "default";
    toolHint.textContent = "Modify | Select � click � drag box � Ctrl add � Delete remove";
    footerStatus("Select � ready � L?R window � R?L crossing");
    try { showWallOpts(false); } catch { /* */ }
  } else if (tool === "move") {
    planMode = "move";
    planChain = [];
    planDrawStart = null;
    canvasWrap.style.cursor = "move";
    toolHint.textContent = "Modify | Move � drag selected elements in plan";
    footerStatus(planSelectedIds.size ? `Move ${planSelectedIds.size} element(s) � drag` : "Select elements first, then Move");
    try { showWallOpts(false); } catch { /* */ }
  } else if (
    tool === "dim-aligned" || tool === "measure" ||
    tool === "dim-linear" || tool === "dim-horizontal" || tool === "dim-vertical" ||
    tool === "dim-angular" || tool === "dim-radial" || tool === "dim-diameter" ||
    tool === "dim-arc" || tool === "arc-length" ||
    tool === "spot-elev" || tool === "elevation" ||
    tool === "spot-coord" || tool === "coordinate"
  ) {
    planMode = "dim";
    planDimChainPts = [];
    planAutoPick = null;
    planDrawStart = null;
    planDimStartRef = null;
    planDimSeg1 = null;
    planChain = [];
    canvasWrap.style.cursor = "crosshair";
    try { showWallOpts(false); } catch { /* */ }

    if (tool === "dim-linear" || tool === "dim-horizontal" || tool === "dim-vertical") {
      planDimStyle = "linear";
      toolHint.textContent = "Modify | Place Linear Dimension � 2 boundaries � H/V";
      footerStatus("Linear: pick first model boundary");
    } else if (tool === "dim-angular") {
      planDimStyle = "angular";
      toolHint.textContent = "Modify | Place Angular Dimension � 2 edges";
      footerStatus("Angular: pick first line / wall edge");
    } else if (tool === "dim-radial") {
      planDimStyle = "radial";
      toolHint.textContent = "Modify | Place Radial Dimension � center then edge";
      footerStatus("Radial: pick center point");
    } else if (tool === "dim-diameter") {
      planDimStyle = "diameter";
      toolHint.textContent = "Modify | Place Diameter Dimension � center then edge";
      footerStatus("Diameter: pick center point");
    } else if (tool === "dim-arc" || tool === "arc-length") {
      planDimStyle = "arc";
      toolHint.textContent = "Modify | Place Arc Length Dimension � 2 points on arc";
      footerStatus("Arc length: pick first point on edge");
    } else if (tool === "spot-elev" || tool === "elevation") {
      planDimStyle = "elevation";
      toolHint.textContent = "Modify | Spot Elevation � click a point";
      footerStatus("Spot Elevation: click model point or free location");
    } else if (tool === "spot-coord" || tool === "coordinate") {
      planDimStyle = "coordinate";
      toolHint.textContent = "Modify | Spot Coordinate � click a point";
      footerStatus("Spot Coordinate: click to place X / Z label");
    } else {
      planDimStyle = "aligned";
      toolHint.textContent = "Modify | Place Aligned Dimension � 2 boundaries � snaps ON";
      footerStatus("Aligned: pick first model boundary");
    }
  } else if (tool === "auto-dim" || tool === "dim-auto") {
    planMode = "dim";
    planDimStyle = "auto";
    planAutoPick = {};
    planDrawStart = null;
    planDimStartRef = null;
    planChain = [];
    canvasWrap.style.cursor = "crosshair";
    try { showWallOpts(false); } catch { /* */ }
    toolHint.textContent = "Modify | Auto Dimension \u2014 pick FIRST edge, LAST edge, then place";
    footerStatus("Auto Dimension: pick the FIRST edge (wall, column, door or window face)");
  } else if (tool === "auto-dim-all" || tool === "dim-auto-all") {
    void runAutoDimension();
  } else if (tool === "tag-all") {
    runTagAll();
  } else if (tool === "tag" || tool === "room-tag" || tool === "material-tag") {
    planMode = "tag";
    (window as any).__obsPlanTagMode = tool === "room-tag" ? "room" : tool === "material-tag" ? "material" : "category";
    canvasWrap.style.cursor = "crosshair";
    toolHint.textContent = `${tool === "room-tag" ? "Room Tag" : tool === "material-tag" ? "Material Tag" : "Tag"} � click near element`;
  } else if (tool === "text" || tool === "model-text" || tool === "text-3d") {
    planMode = "text";
    canvasWrap.style.cursor = "crosshair";
    toolHint.textContent = "Text � click to place note";
  } else if (tool === "clear-annotations" || tool === "clear") {
    const beforeSnap = dimSnapshot();
    planDims.length = 0;
    recordDims("Clear dimensions", beforeSnap);
    const beforeAnno = annoSnapshot();
    planTags.length = 0;
    planNotes.length = 0;
    recordAnno("Clear annotations", beforeAnno);
    if (currentPlan) renderPlan(currentPlan);
    footerStatus("Annotations cleared");
  }
}

export function setupPlanViewPanel() {

// Keep the authored element cache fresh for snap lookups.
try {
  if (!(window as any).__obsAuthoredElementsRefreshTimer) {
    (window as any).__obsAuthoredElementsRefreshTimer = setInterval(() => {
      try {
        const auth: any = (ctx.features as any).authoring;
        if (auth?.getElements) {
          (window as any).__obsAuthoredElements = auth.getElements();
        }
      } catch { /* */ }
    }, 500);
  }
} catch { /* */ }

  document.body.appendChild(overlay);
  planBody.append(planProps, canvasWrap);
  overlay.append(header, planBody, footer);
  renderPlanProperties();

  // Flag for 3D handlers to defer when plan is open
  (window as any).__obsPlanVisible = () => isPlanViewVisible();

  window.addEventListener("keydown", (e) => {
    if (!isPlanViewVisible()) return;
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    // Tab: cycle through the overlapping snap points under the cursor (Revit).
    if (e.key === "Tab" && planMode === "dim" && planCursor) {
      e.preventDefault(); e.stopImmediatePropagation();
      planSnapCycle += e.shiftKey ? -1 : 1;
      const hit = findDimensionBoundary(planCursor);
      if (hit) {
        const h = hit as any;
        planSnap = { x: hit.point.x, z: hit.point.z, kind: String(h.kind ?? "face"),
          label: h.label ? String(h.label) + (h.alt ? `  (Tab ${h.alt.index}/${h.alt.count})` : "") : undefined, ref: hit.ref };
        updateSnapOverlay();
        footerStatus(`Snap: ${h.label ?? "boundary"}${h.alt ? ` (${h.alt.index}/${h.alt.count}) - Tab for next` : ""}`);
      }
      return;
    }
    // Chain dimension: Enter places at the default offset, Esc discards the picked boundaries.
    if (planMode === "dim" && planDimChain && planDimChainPts.length) {
      if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); finishDimChain(undefined); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancelDimChain(); footerStatus("Chain cancelled"); return; }
    }
    // Auto Dimension: Enter places the chain 50 cm outside the picked elements.
    if (planMode === "dim" && planDimStyle === "auto" && planAutoPick?.p2 && e.key === "Enter") {
      e.preventDefault(); e.stopImmediatePropagation();
      finishAutoRange(undefined);
      planDrawStart = null;
      return;
    }
    if (planMode === "dim" && planDimStyle === "auto" && planAutoPick?.p1 && e.key === "Escape") {
      planAutoPick = {};
      planDrawStart = null;
      footerStatus("Auto Dimension: pick the FIRST edge");
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }

    // Typed length while a segment is being drawn: digits, then Enter places it
    // along the current cursor direction (Revit temporary-dimension entry).
    if (planMode === "linear" && planDrawStart && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const startsEntry = /^[0-9.,]$/.test(e.key);
      if ((planTypedLength ? isLengthChar(e.key) : startsEntry)) {
        planTypedLength += e.key;
        footerStatus(`Length: ${planTypedLength}   (Enter = place, Esc = clear)`);
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
      if (planTypedLength && e.key === "Backspace") {
        planTypedLength = planTypedLength.slice(0, -1);
        footerStatus(planTypedLength ? `Length: ${planTypedLength}` : "Length cleared");
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
      if (planTypedLength && e.key === "Enter") {
        const len = parseLength(planTypedLength);
        planTypedLength = "";
        e.preventDefault(); e.stopImmediatePropagation();
        if (len == null) { footerStatus("Invalid length"); return; }
        const prev = planChain[planChain.length - 1] ?? planDrawStart;
        const p = pointAtLength(prev, planCursor ?? { x: prev.x + 1, z: prev.z }, len);
        planChain.push(p);
        planDrawStart = p;
        void createAuthoredLinear(prev.x, prev.z, p.x, p.z);
        return;
      }
      if (planTypedLength && e.key === "Escape") {
        planTypedLength = "";
        footerStatus("Length cleared");
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
    }

    // Enter � finish continuous path
    if (e.key === "Enter" && planMode === "linear" && planChain.length > 0) {
      finishPlanChain();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Space � repeat last command (BIM). Backspace repeats only if nothing selected.
    if (e.key === " " || (e.key === "Backspace" && planSelectedIds.size === 0)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void (async () => {
        try {
          const { getLastCommand } = await import("./authoring");
          const cmd = getLastCommand();
          if (!cmd) {
            footerStatus("No previous command to repeat");
            return;
          }
          setPlanToolFromRibbon(cmd);
          footerStatus(`Repeat last: ${cmd}`);
          try {
            window.dispatchEvent(new CustomEvent("obs-toast", {
              detail: { message: `Repeat: ${cmd}`, kind: "success" },
            }));
          } catch { /* */ }
        } catch (err) {
          console.warn("[plan] Space/Backspace repeat", err);
        }
      })();
      return;
    }

    // Selected tag / note: Delete removes it, Esc deselects.
    if (planAnnoSel && planMode !== "dim" && planMode !== "linear" && planMode !== "tag" && planMode !== "text") {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault(); e.stopImmediatePropagation();
        const beforeAnno = annoSnapshot();
        const sel = planAnnoSel;
        const arr: any[] = sel.kind === "tag" ? planTags : planNotes;
        const i = arr.indexOf(sel.obj); if (i >= 0) arr.splice(i, 1);
        planAnnoSel = null;
        recordAnno(sel.kind === "tag" ? "Delete tag" : "Delete note", beforeAnno);
        if (currentPlan) renderPlan(currentPlan);
        footerStatus(`${sel.kind === "tag" ? "Tag" : "Note"} deleted - Ctrl+Z undo`);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); planAnnoSel = null; if (currentPlan) renderPlan(currentPlan); return; }
    }

    // Selected dimension: Delete removes it (Shift = whole chain), Esc deselects.
    if (planDimSel && planMode !== "dim" && planMode !== "linear") {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault(); e.stopImmediatePropagation();
        const beforeSnap = dimSnapshot();
        const gone = new Set(e.shiftKey ? dimMembers(planDimSel) : [planDimSel]);
        for (let i = planDims.length - 1; i >= 0; i--) if (gone.has(planDims[i])) planDims.splice(i, 1);
        planDimSel = null;
        recordDims("Delete dimension", beforeSnap);
        if (currentPlan) renderPlan(currentPlan);
        footerStatus(`Deleted ${gone.size} dimension(s) - Ctrl+Z undo`);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); planDimSel = null; if (currentPlan) renderPlan(currentPlan); return; }
      if ((e.key === "e" || e.key === "E") && !e.ctrlKey && !e.metaKey && !e.altKey && planDimSel.chainId) {
        // Toggle equality display (EQ) for the selected chain.
        e.preventDefault(); e.stopImmediatePropagation();
        const beforeSnap = dimSnapshot();
        const on = !planDimSel.eq;
        for (const m of dimMembers(planDimSel)) m.eq = on;
        recordDims("Toggle EQ", beforeSnap);
        if (currentPlan) renderPlan(currentPlan);
        footerStatus(on ? (dimShowsEq(planDimSel) ? "EQ on - segments are equal" : "EQ on - shows when all segments are equal") : "EQ off");
        return;
      }
    }

    // Delete / Backspace on selection � remove selected authored elements
    if ((e.key === "Delete" || e.key === "Backspace") && planSelectedIds.size > 0 && planMode !== "linear") {
      // Backspace also used for repeat when nothing selected � handled above when size==0
      if (e.key === "Backspace" && planSelectedIds.size === 0) {
        /* fall through to repeat */
      } else {
        e.preventDefault();
        e.stopImmediatePropagation();
        void (async () => {
          try {
            const { deleteSelectedElement, getElements, setSelectedAuthored } = await import("./authoring");
            const n = planSelectedIds.size;
            // Prefer multi-delete via selection sync
            setSelectedAuthored([...planSelectedIds], "replace");
            deleteSelectedElement();
            planSelectedIds.clear();
            renderPlanProperties();
            footerStatus(`Deleted ${n} element(s) � Ctrl+Z undo`);
            void regenerate();
          } catch (err) {
            console.warn("[plan] delete", err);
          }
        })();
        return;
      }
    }

    // Esc � BIM order cancel:
    //  1) Cancel in-progress path (discard unfinished chain) stay in tool if had segments
    //  2) Exit tool ? Modify / Select
    //  3) Already Select ? close Floor Plan
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      // 1) In-progress linear path: discard unfinished and return to idle Place mode
      if (planMode === "linear" && (planChain.length > 0 || planDrawStart)) {
        const hadSegments = planChain.length > 1;
        planChain = [];
        planDrawStart = null;
        planCursor = null;
        planSnap = null;
        void import("./authoring").then((m) => m.clearLastPlanLinear?.()).catch(() => {});
        if (currentPlan) renderPlan(currentPlan);
        if (hadSegments) {
          // BIM: Esc after some segments keeps Place Wall active
          footerStatus(`Place ${planLinearType}: cancelled path � click start of next � Esc = Modify`);
          toolHint.textContent = `Modify | Place ${planLinearType} � Esc cancel � Space repeat`;
        } else {
          // No segments yet ? exit to Select
          planMode = "select";
          canvasWrap.style.cursor = "default";
          toolHint.textContent = "Modify | Select � click � box � Delete � Ctrl+Z";
          footerStatus("Cancelled � Select");
          try { showWallOpts(false); } catch { /* */ }
        }
        return;
      }
      // 2) Cancel active tool (dim/point/tag/text/linear idle) ? Select
      if (planMode !== "pan" || planDrawStart) {
        planMode = "select";
        planDrawStart = null;
        planDimStartRef = null;
        planDimSeg1 = null;
        planChain = [];
        planSnap = null;
        planCursor = null;
        canvasWrap.style.cursor = "default";
        toolHint.textContent = "Modify | Select � click � box � Delete � Ctrl+Z";
        footerStatus("Cancelled � Select");
        try { showWallOpts(false); } catch { /* */ }
        try {
          window.dispatchEvent(new CustomEvent("obs-toast", {
            detail: { message: "Cancelled � Select", kind: "info" },
          }));
        } catch { /* */ }
        return;
      }
      // 3) Already Select ? close Floor Plan (back to 3D)
      togglePlanView();
    }
  }, true);

  window.addEventListener("resize", () => {
    if (isPlanViewVisible()) layoutUnderRibbon();
  });

  // 3D ? 2D live sync when authored geometry changes
  try {
    import("./authoring").then(({ onAuthoringChange }) => {
      onAuthoringChange(() => {
        if (!isPlanViewVisible() || generating) return;
        // Debounce regenerate
        const t = (window as any).__obsPlanSyncTimer;
        if (t) clearTimeout(t);
        (window as any).__obsPlanSyncTimer = setTimeout(() => {
          void regenerate();
        }, 400);
      });
    }).catch(() => {});
  } catch { /* */ }

  window.addEventListener("obs-history", () => {
    if (!isPlanViewVisible()) return;
    // Rebuild plan after undo/redo without resetting zoom/pan
    void regenerate();
  });

  ctx.features.planView = {
    toggle: togglePlanView,
    isVisible: isPlanViewVisible,
    regenerate: () => void regenerate(),
    setTool: setPlanToolFromRibbon,
  };
}