/**
 * CAD editor style tools: appearance editor for the selection (layer, colour,
 * linetype, lineweight, text font/style), Linetype Manager, Text Style Manager,
 * the Text tool dialog, layer property editing and Match Properties.
 *
 * The CAD viewer owns the drawing state; it passes a small `CadStyleApi` so this
 * file never reaches into its closure.
 */
import type { DxfDocument, DxfEntity, DxfTextStyle } from "../modules/drawings/dxf-types";
import { aciToRgb, rgbToCss } from "../modules/drawings/aci";
import {
  CAD_FONTS, LINETYPE_LIBRARY, LINEWEIGHTS_MM, TEXT_STYLE_PRESETS,
  applyTextStyle, cssFontFor, ensureLinetypes, findFont, lineweightLabel, previewDash, scaledPattern,
  type TextStyle,
} from "../modules/drawings/cad-styles";
import { openFormModal } from "./form-modal";

type TextEnt = Extract<DxfEntity, { type: "TEXT" }>;

export interface CadStyleApi {
  doc(): DxfDocument | null;
  entities(): DxfEntity[];
  /** Indices (into entities()) of the selected objects. */
  selection(): number[];
  commitModify(before: DxfEntity[], after: DxfEntity[]): void;
  addEntity(e: DxfEntity): void;
  redraw(): void;
  log(msg: string): void;
  /** Refresh layer list / layer manager after layer property edits. */
  refreshLayers(): void;
  currentLayer(): string;
}

/* ───────────────────── current properties for new objects ───────────────────── */

export interface CurrentProps { lineType?: string; lineweight?: number; color?: number; textStyle: TextStyle }

const STYLE_KEY = "obs.cad.textStyles";
const CUR_KEY = "obs.cad.currentTextStyle";
const current: CurrentProps = { textStyle: TEXT_STYLE_PRESETS[0] };

function readJson<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function writeJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export function customTextStyles(): TextStyle[] {
  const v = readJson<TextStyle[]>(STYLE_KEY);
  return Array.isArray(v) ? v.filter((s) => s && typeof s.name === "string" && typeof s.font === "string" && Number.isFinite(s.height)) : [];
}
export function allTextStyles(): TextStyle[] {
  const custom = customTextStyles();
  const names = new Set(custom.map((s) => s.name.toLowerCase()));
  return [...TEXT_STYLE_PRESETS.filter((s) => !names.has(s.name.toLowerCase())), ...custom];
}
export function getCurrent(): CurrentProps {
  const saved = readJson<string>(CUR_KEY);
  if (saved && saved !== current.textStyle.name) {
    const st = allTextStyles().find((s) => s.name === saved);
    if (st) current.textStyle = st;
  }
  return current;
}
function setCurrentTextStyle(st: TextStyle): void { current.textStyle = st; writeJson(CUR_KEY, st.name); }

/** Properties a newly drawn object should carry (only the non-default ones). */
export function newObjectProps(): { lineType?: string; lineweight?: number; color?: number } {
  const out: { lineType?: string; lineweight?: number; color?: number } = {};
  if (current.lineType) out.lineType = current.lineType;
  if (current.lineweight != null) out.lineweight = current.lineweight;
  if (current.color != null) out.color = current.color;
  return out;
}

/** On-screen line width (px) for a lineweight in mm. */
export const lineweightPx = (mm: number): number => Math.min(6, Math.max(1, 0.8 + mm * 2.4));

/* ───────────────────────────── small DOM helpers ───────────────────────────── */

const CARD = "background:#151a23;color:#e5e7eb;border:1px solid #334155;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);font:12px system-ui,sans-serif";
const INPUT = "background:#0e1017;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:4px;padding:3px 6px;font:12px system-ui,sans-serif";
const BTN = "background:#1b212c;color:#e5e7eb;border:1px solid #2f3846;border-radius:5px;padding:3px 9px;cursor:pointer;font:12px system-ui,sans-serif";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

function modal(title: string, width: number, build: (body: HTMLElement, close: () => void) => void): void {
  const ov = el("div", "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center");
  const card = el("div", `${CARD};width:min(${width}px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden`);
  const head = el("div", "display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2a2e3a;background:#10141b");
  head.append(el("b", "flex:1;font-size:14px;color:#38bdf8", title));
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const x = el("button", BTN, "Close"); x.onclick = close; head.append(x);
  const body = el("div", "padding:12px 14px;overflow:auto");
  card.append(head, body); ov.append(card);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  document.body.append(ov);
  build(body, close);
}

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const o = document.createElement("option"); o.value = value; o.textContent = label; o.selected = selected; return o;
}

function fontSelect(value: string | undefined, withKeep = false): HTMLSelectElement {
  const s = el("select", INPUT + ";max-width:170px");
  if (withKeep) s.append(option("", "(varies)", true));
  const groups: Record<string, string> = { sans: "Sans-serif", serif: "Serif", mono: "Monospace", script: "Handwriting", stroke: "CAD stroke fonts (SHX)" };
  for (const kind of Object.keys(groups)) {
    const g = document.createElement("optgroup"); g.label = groups[kind];
    for (const f of CAD_FONTS.filter((x) => x.kind === kind)) g.append(option(f.id, f.label, !withKeep && findFont(value)?.id === f.id));
    s.append(g);
  }
  if (!withKeep && value && !findFont(value)) s.prepend(option(value, value + " (custom)", true));
  return s;
}

function linetypeOptions(doc: DxfDocument | null, selected: string | undefined, extra: Array<[string, string]> = []): HTMLOptionElement[] | HTMLOptGroupElement[] {
  const out: Array<HTMLOptionElement | HTMLOptGroupElement> = [];
  for (const [v, l] of extra) out.push(option(v, l, (selected ?? "") === v));
  out.push(option("Continuous", "Continuous", selected?.toUpperCase() === "CONTINUOUS"));
  const known = new Set(LINETYPE_LIBRARY.map((l) => l.name));
  const own = Object.keys(doc?.linetypes ?? {}).filter((n) => !known.has(n) && n !== "CONTINUOUS");
  if (own.length) {
    const g = document.createElement("optgroup"); g.label = "In this drawing";
    for (const n of own) g.append(option(n, n, selected?.toUpperCase() === n));
    out.push(g);
  }
  for (const group of ["Basic", "Centre / Phantom", "Dash-dot", "Utility", "ISO"] as const) {
    const g = document.createElement("optgroup"); g.label = group;
    for (const l of LINETYPE_LIBRARY.filter((x) => x.group === group)) g.append(option(l.name, `${l.name} - ${l.description}`, selected?.toUpperCase() === l.name));
    out.push(g);
  }
  return out as HTMLOptionElement[];
}

function lineweightOptions(selected: number | undefined, byLayerLabel = "ByLayer"): HTMLOptionElement[] {
  return [option("", byLayerLabel, selected == null), ...LINEWEIGHTS_MM.map((w) => option(String(w), lineweightLabel(w), selected === w))];
}

function linePreview(pattern: number[], w = 150, h = 14, color = "#e5e7eb"): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = w * dpr; c.height = h * dpr; c.style.cssText = `width:${w}px;height:${h}px;background:#0c0e13;border-radius:3px`;
  const g = c.getContext("2d");
  if (g) {
    g.scale(dpr, dpr); g.strokeStyle = color; g.lineWidth = 1.5;
    g.setLineDash(previewDash(pattern)); g.beginPath(); g.moveTo(4, h / 2); g.lineTo(w - 4, h / 2); g.stroke();
  }
  return c;
}

/* ───────────────────────── apply changes to the selection ───────────────────────── */

function applyToSelection(api: CadStyleApi, label: string, patch: (e: DxfEntity) => DxfEntity | null): number {
  const ents = api.entities();
  const before: DxfEntity[] = [], after: DxfEntity[] = [];
  for (const i of api.selection()) {
    const e = ents[i]; if (!e) continue;
    const n = patch(e);
    if (n) { before.push(e); after.push(n); }
  }
  if (!before.length) return 0;
  const doc = api.doc();
  if (doc) ensureLinetypes(doc, after.map((e) => e.lineType));
  api.commitModify(before, after);
  api.log(`${label}: ${before.length} object(s)`);
  api.redraw();
  return before.length;
}

function withoutKeys<T extends object>(e: T, ...keys: string[]): T {
  const c: Record<string, unknown> = { ...(e as Record<string, unknown>) };
  for (const k of keys) delete c[k];
  return c as T;
}

/* ───────────────────────────── appearance editor ───────────────────────────── */

/**
 * Fills `host` with controls that edit the selected objects' layer, colour, linetype,
 * lineweight and (for TEXT) font, style and text options. Every change is one undo step.
 */
export function renderAppearanceEditor(host: HTMLElement, api: CadStyleApi): void {
  host.textContent = "";
  const doc = api.doc();
  const ents = api.entities();
  const sel = api.selection().map((i) => ents[i]).filter(Boolean);
  if (!doc || !sel.length) return;

  const wrap = el("div", "margin-top:8px;border-top:1px solid #2a3140;padding-top:6px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;font-size:11px");
  const lab = (t: string) => el("span", "color:#9aa4b2", t);
  const same = <T,>(f: (e: DxfEntity) => T): T | undefined => { const v = f(sel[0]); return sel.every((e) => f(e) === v) ? v : undefined; };

  // Layer
  const layerSel = el("select", INPUT);
  const curLayer = same((e) => e.layer);
  if (curLayer === undefined) layerSel.append(option("", "(varies)", true));
  for (const l of doc.layers) layerSel.append(option(l.name, l.name, l.name === curLayer));
  layerSel.onchange = () => { if (layerSel.value) applyToSelection(api, "Layer", (e) => (e.layer === layerSel.value ? null : { ...e, layer: layerSel.value })); };
  wrap.append(lab("Layer"), layerSel);

  // Colour
  const colorRow = el("div", "display:flex;gap:4px;align-items:center");
  const colorIn = el("input", "width:34px;height:22px;padding:0;background:none;border:1px solid #2a2e3a;border-radius:3px") as HTMLInputElement;
  colorIn.type = "color";
  const e0 = sel[0];
  const layerColor = doc.layers.find((l) => l.name === e0.layer)?.color ?? 7;
  colorIn.value = rgbToCss(e0.rgb ?? aciToRgb(e0.color ?? layerColor, 0xffffff)).slice(0, 7);
  colorIn.onchange = () => {
    const v = parseInt(colorIn.value.slice(1), 16);
    applyToSelection(api, "Colour", (e) => ({ ...e, rgb: v }));
  };
  const byLayerBtn = el("button", BTN, "ByLayer");
  byLayerBtn.onclick = () => applyToSelection(api, "Colour ByLayer", (e) => (e.rgb == null && e.color == null ? null : withoutKeys(e, "rgb", "color")));
  colorRow.append(colorIn, byLayerBtn);
  wrap.append(lab("Colour"), colorRow);

  // Linetype
  const ltSel = el("select", INPUT + ";max-width:200px");
  const ltVal = same((e) => e.lineType ?? "");
  if (ltVal === undefined) ltSel.append(option("__varies", "(varies)", true));
  for (const o of linetypeOptions(doc, ltVal || undefined, [["", "ByLayer"]])) ltSel.append(o);
  ltSel.onchange = () => {
    const v = ltSel.value; if (v === "__varies") return;
    applyToSelection(api, "Linetype", (e) => ((e.lineType ?? "") === v ? null : v ? { ...e, lineType: v } : withoutKeys(e, "lineType")));
  };
  wrap.append(lab("Linetype"), ltSel);

  // Lineweight
  const lwSel = el("select", INPUT);
  const lwVal = same((e) => e.lineweight);
  if (lwVal === undefined && sel.some((e) => e.lineweight != null)) lwSel.append(option("__varies", "(varies)", true));
  for (const o of lineweightOptions(lwVal)) lwSel.append(o);
  lwSel.onchange = () => {
    const v = lwSel.value; if (v === "__varies") return;
    applyToSelection(api, "Lineweight", (e) => (v === "" ? (e.lineweight == null ? null : withoutKeys(e, "lineweight")) : e.lineweight === Number(v) ? null : { ...e, lineweight: Number(v) }));
  };
  wrap.append(lab("Lineweight"), lwSel);

  // Text options
  const texts = sel.filter((e): e is TextEnt => e.type === "TEXT");
  if (texts.length) {
    const tt = (f: (e: TextEnt) => unknown) => { const v = f(texts[0]); return texts.every((e) => f(e) === v) ? v : undefined; };
    const patchText = (label: string, p: (e: TextEnt) => TextEnt | null) =>
      applyToSelection(api, label, (e) => (e.type === "TEXT" ? p(e) : null));

    wrap.append(el("div", "grid-column:1/-1;color:#38bdf8;font-weight:600;margin-top:4px", "Text"));

    if (texts.length === 1) {
      const val = el("textarea", INPUT + ";width:100%;min-height:42px;resize:vertical") as HTMLTextAreaElement;
      val.value = texts[0].value;
      val.onchange = () => patchText("Edit text", (e) => (e.value === val.value ? null : { ...e, value: val.value }));
      wrap.append(lab("Contents"), val);
    }

    const stSel = el("select", INPUT + ";max-width:170px");
    stSel.append(option("", "Apply style...", true));
    for (const s of allTextStyles()) stSel.append(option(s.name, `${s.name} - ${s.font}, ${s.height}`));
    stSel.onchange = () => {
      const st = allTextStyles().find((s) => s.name === stSel.value);
      if (st) patchText("Text style", (e) => applyTextStyle(e, st));
    };
    wrap.append(lab("Style"), stSel);

    const fSel = fontSelect(tt((e) => e.font) as string | undefined, tt((e) => e.font) === undefined);
    fSel.onchange = () => { if (fSel.value) patchText("Font", (e) => (e.font === fSel.value ? null : { ...e, font: fSel.value })); };
    wrap.append(lab("Font"), fSel);

    const num = (label: string, get: (e: TextEnt) => number, set: (e: TextEnt, v: number) => TextEnt, step: string, min?: number) => {
      const i = el("input", INPUT + ";width:80px") as HTMLInputElement;
      i.type = "number"; i.step = step; if (min != null) i.min = String(min);
      const v = tt(get) as number | undefined; i.value = v === undefined ? "" : String(+v.toFixed(4)); i.placeholder = v === undefined ? "varies" : "";
      i.onchange = () => { const n = Number(i.value); if (Number.isFinite(n) && (min == null || n >= min)) patchText(label, (e) => (get(e) === n ? null : set(e, n))); };
      wrap.append(lab(label), i);
    };
    num("Height", (e) => e.height, (e, v) => ({ ...e, height: v }), "0.1", 0.0001);
    num("Rotation", (e) => e.rotation ?? 0, (e, v) => ({ ...e, rotation: v }), "1");
    num("Width factor", (e) => e.widthFactor ?? 1, (e, v) => (Math.abs(v - 1) < 1e-9 ? withoutKeys(e, "widthFactor") : { ...e, widthFactor: v }), "0.1", 0.01);
    num("Oblique", (e) => e.oblique ?? 0, (e, v) => (Math.abs(v) < 1e-9 ? withoutKeys(e, "oblique") : { ...e, oblique: v }), "1");

    const flags = el("div", "display:flex;gap:10px");
    const flag = (label: string, key: "bold" | "italic") => {
      const l = el("label", "display:flex;gap:4px;align-items:center;cursor:pointer");
      const c = el("input", "") as HTMLInputElement; c.type = "checkbox"; c.checked = !!tt((e) => !!e[key]);
      c.onchange = () => patchText(label, (e) => (!!e[key] === c.checked ? null : c.checked ? { ...e, [key]: true } : withoutKeys(e, key)));
      l.append(c, document.createTextNode(label)); flags.append(l);
    };
    flag("Bold", "bold"); flag("Italic", "italic");
    wrap.append(lab("Format"), flags);

    const aSel = el("select", INPUT);
    const aVal = tt((e) => e.align ?? "left") as string | undefined;
    for (const a of ["left", "center", "right"]) aSel.append(option(a, a[0].toUpperCase() + a.slice(1), a === aVal));
    aSel.onchange = () => patchText("Justify", (e) => ((e.align ?? "left") === aSel.value ? null : { ...e, align: aSel.value as TextEnt["align"] }));
    wrap.append(lab("Justify"), aSel);
  }
  host.append(wrap);
}

/* ───────────────────────────── Linetype Manager ───────────────────────────── */

export function openLinetypeManager(api: CadStyleApi): void {
  const doc = api.doc();
  if (!doc) { api.log("Open a drawing first"); return; }
  modal("Linetype Manager", 780, (body) => {
    const top = el("div", "display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:10px");
    const ltsLabel = el("label", "display:flex;gap:6px;align-items:center", "Global scale (LTSCALE)");
    const lts = el("input", INPUT + ";width:80px") as HTMLInputElement; lts.type = "number"; lts.step = "0.1"; lts.min = "0.0001"; lts.value = String(doc.ltscale ?? 1);
    lts.onchange = () => { const v = Number(lts.value); if (v > 0) { doc.ltscale = v; api.redraw(); api.log(`LTSCALE set to ${v}`); } };
    ltsLabel.append(lts);
    const curLabel = el("label", "display:flex;gap:6px;align-items:center", "Current linetype for new objects");
    const curSel = el("select", INPUT + ";max-width:230px");
    const fillCur = () => { curSel.textContent = ""; for (const o of linetypeOptions(doc, current.lineType, [["", "ByLayer"]])) curSel.append(o); };
    fillCur();
    curSel.onchange = () => { current.lineType = curSel.value || undefined; if (curSel.value) ensureLinetypes(doc, [curSel.value]); api.log(`Current linetype: ${curSel.value || "ByLayer"}`); };
    curLabel.append(curSel);
    const curW = el("label", "display:flex;gap:6px;align-items:center", "Lineweight");
    const wSel = el("select", INPUT); for (const o of lineweightOptions(current.lineweight)) wSel.append(o);
    wSel.onchange = () => { current.lineweight = wSel.value === "" ? undefined : Number(wSel.value); };
    curW.append(wSel);
    top.append(ltsLabel, curLabel, curW);

    const list = el("div", "display:flex;flex-direction:column;gap:2px");
    const render = () => {
      list.textContent = "";
      const row = (name: string, desc: string, pattern: number[], inDoc: boolean, lib: boolean) => {
        const r = el("div", "display:grid;grid-template-columns:160px 220px 1fr auto;gap:8px;align-items:center;padding:3px 4px;border-bottom:1px solid #1f2633");
        r.append(linePreview(inDoc ? pattern : scaledPattern({ name, description: desc, pattern, group: "Basic" }, doc.units)), el("b", "", name), el("span", "color:#9aa4b2", desc));
        const acts = el("div", "display:flex;gap:4px");
        if (lib && !inDoc) {
          const load = el("button", BTN, "Load"); load.onclick = () => { ensureLinetypes(doc, [name]); api.log(`Linetype loaded: ${name}`); render(); fillCur(); }; acts.append(load);
        }
        const use = el("button", BTN, "Apply to selection");
        use.onclick = () => { const n = applyToSelection(api, "Linetype", (e) => (e.lineType === name ? null : { ...e, lineType: name })); if (!n) api.log("Select objects first"); render(); };
        const setCur = el("button", BTN, "Set current");
        setCur.onclick = () => { ensureLinetypes(doc, [name]); current.lineType = name; fillCur(); api.log(`Current linetype: ${name}`); };
        acts.append(use, setCur);
        r.append(acts); list.append(r);
      };
      const own = Object.keys(doc.linetypes ?? {}).filter((n) => !LINETYPE_LIBRARY.some((l) => l.name === n) && n !== "CONTINUOUS");
      if (own.length) { list.append(el("div", "margin:8px 0 2px;color:#38bdf8;font-weight:600", "In this drawing")); for (const n of own) row(n, "Defined by the file", doc.linetypes![n], true, false); }
      for (const group of ["Basic", "Centre / Phantom", "Dash-dot", "Utility", "ISO"] as const) {
        list.append(el("div", "margin:8px 0 2px;color:#38bdf8;font-weight:600", group));
        for (const l of LINETYPE_LIBRARY.filter((x) => x.group === group)) {
          const inDoc = !!doc.linetypes?.[l.name]?.length;
          row(l.name, l.description + (inDoc ? " (loaded)" : ""), inDoc ? doc.linetypes![l.name] : l.pattern, inDoc, true);
        }
      }
    };
    render();
    body.append(top, list);
  });
}

/* ───────────────────────────── Text Style Manager ───────────────────────────── */

/**
 * Fonts offered by the style editor: the built-in CAD font list plus every font
 * the open drawing references (STYLE table + text entities), so fonts read from
 * the file are selectable, with SHX and TTF font faces supplied by the drawing.
 */
export function fontOptionsFor(api: CadStyleApi | null): Array<[string, string]> {
  const fileFonts = new Set<string>();
  for (const st of Object.values(api?.doc()?.textStyles ?? {})) if (st.font) fileFonts.add(st.font);
  for (const e of api?.entities() ?? []) if (e.type === "TEXT" && e.font) fileFonts.add(e.font);
  const known = (f: string) => CAD_FONTS.some((x) => x.id.toLowerCase() === f.toLowerCase() || x.file.toLowerCase() === f.toLowerCase());
  const extra = [...fileFonts].filter((f) => !known(f)).sort((a, b) => a.localeCompare(b)).map((f) => [f, `${f} (from file)`] as [string, string]);
  return [...CAD_FONTS.map((f) => [f.id, f.label] as [string, string]), ...extra];
}

/** Convert a STYLE-table record read from the drawing into an editable TextStyle. */
export function fileStyleToTextStyle(name: string, s: DxfTextStyle): TextStyle {
  const st: TextStyle = {
    name,
    font: s.font ?? "txt.shx",
    height: s.height && s.height > 0 ? s.height : 2.5,
    note: "Read from the drawing's STYLE table",
  };
  if (s.width && Math.abs(s.width - 1) > 1e-9) st.widthFactor = s.width;
  if (s.oblique && Math.abs(s.oblique) > 1e-9) st.oblique = s.oblique;
  if (s.bold) st.bold = true;
  if (s.italic) st.italic = true;
  return st;
}

async function editTextStyle(api: CadStyleApi | null, initial?: TextStyle): Promise<TextStyle | null> {
  const fontOptions: Array<[string, string]> = fontOptionsFor(api);
  const v = await openFormModal({
    title: initial ? `Edit text style "${initial.name}"` : "New text style",
    fields: [
      { kind: "text", key: "name", label: "Style name", default: initial?.name ?? "", validate: (x) => (String(x).trim() ? null : "Name is required") },
      { kind: "select", key: "font", label: "Font", default: initial?.font ?? "Arial", options: fontOptions },
      { kind: "number", key: "height", label: "Text height", default: initial?.height ?? 2.5, min: 0.0001, step: 0.1, validate: (x) => (Number(x) > 0 ? null : "Height must be positive") },
      { kind: "number", key: "widthFactor", label: "Width factor", default: initial?.widthFactor ?? 1, min: 0.01, step: 0.1 },
      { kind: "number", key: "oblique", label: "Oblique angle", default: initial?.oblique ?? 0, step: 1, unit: "deg" },
      { kind: "checkbox", key: "bold", label: "Bold", default: !!initial?.bold },
      { kind: "checkbox", key: "italic", label: "Italic", default: !!initial?.italic },
    ],
    submitLabel: initial ? "Save style" : "Create style",
  });
  if (!v) return null;
  const st: TextStyle = { name: String(v.name).trim(), font: String(v.font), height: Number(v.height) };
  if (Math.abs(Number(v.widthFactor) - 1) > 1e-9) st.widthFactor = Number(v.widthFactor);
  if (Math.abs(Number(v.oblique)) > 1e-9) st.oblique = Number(v.oblique);
  if (v.bold) st.bold = true;
  if (v.italic) st.italic = true;
  return st;
}

export function openTextStyleManager(api: CadStyleApi): void {
  modal("Text Style Manager", 760, (body) => {
    const list = el("div", "display:flex;flex-direction:column;gap:2px");
    const saveCustom = (next: TextStyle[]) => writeJson(STYLE_KEY, next);
    const render = () => {
      list.textContent = "";
      const custom = customTextStyles();
      for (const st of allTextStyles()) {
        const isCustom = custom.some((c) => c.name.toLowerCase() === st.name.toLowerCase());
        const r = el("div", "display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:center;padding:5px 4px;border-bottom:1px solid #1f2633");
        const nm = el("div", "");
        nm.append(el("b", "", st.name + (getCurrent().textStyle.name === st.name ? "  (current)" : "")), el("div", "color:#9aa4b2;font-size:10px", `${findFont(st.font)?.label ?? st.font}, h=${st.height}${st.widthFactor ? `, w=${st.widthFactor}` : ""}${st.oblique ? `, ${st.oblique}°` : ""}`));
        const sample = el("div", `font:${cssFontFor(st.font, 18, st.bold, st.italic)};color:#e8eaf0;white-space:nowrap;overflow:hidden;transform:${st.widthFactor ? `scaleX(${st.widthFactor})` : "none"};transform-origin:left;${st.oblique ? `font-style:italic;` : ""}`, "AaBbCc 0123456789  Plan 1:50");
        const acts = el("div", "display:flex;gap:4px");
        const cur = el("button", BTN, "Set current"); cur.onclick = () => { setCurrentTextStyle(st); api.log(`Current text style: ${st.name}`); render(); };
        const app = el("button", BTN, "Apply to selected text");
        app.onclick = () => {
          const n = applyToSelection(api, "Text style", (e) => (e.type === "TEXT" ? applyTextStyle(e, st) : null));
          if (!n) api.log("Select text objects first");
        };
        acts.append(cur, app);
        if (isCustom) {
          const ed = el("button", BTN, "Edit"); ed.onclick = () => void editTextStyle(api, st).then((n) => { if (n) { saveCustom(customTextStyles().map((c) => (c.name === st.name ? n : c))); if (getCurrent().textStyle.name === st.name) setCurrentTextStyle(n); render(); } });
          const del = el("button", BTN, "Delete"); del.onclick = () => { saveCustom(customTextStyles().filter((c) => c.name !== st.name)); render(); };
          acts.append(ed, del);
        }
        r.append(nm, sample, acts); list.append(r);
      }
    };
    const add = el("button", BTN + ";margin-bottom:8px", "+ New style");
    add.onclick = () => void editTextStyle(api).then((n) => {
      if (!n) return;
      const rest = customTextStyles().filter((c) => c.name.toLowerCase() !== n.name.toLowerCase());
      writeJson(STYLE_KEY, [...rest, n]); render();
    });
    const note = el("div", "color:#7c8696;font-size:11px;margin-bottom:8px", "Fonts are system fonts; SHX stroke fonts are drawn with a similar-looking font on screen and keep their names in saved DXF files.");

    // ── "From this file" — the STYLE and DIMSTYLE tables exactly as read from the drawing ──
    const fileStyles = Object.entries(api.doc()?.textStyles ?? {});
    const fileDims = api.doc()?.dimStyles ?? [];
    if (fileStyles.length || fileDims.length) {
      const fileBox = el("div", "border:1px solid #1f2633;border-radius:6px;padding:8px 10px;margin-bottom:8px;background:#12141c");
      fileBox.append(el("div", "color:#38bdf8;font-size:11px;font-weight:600;margin-bottom:6px", "From this file (STYLE / DIMSTYLE tables)"));
      if (fileStyles.length) {
        const grid = el("div", "display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;font-size:10.5px;color:#c3cad6");
        const adopt = (name: string, st: DxfTextStyle) => {
          const ts = fileStyleToTextStyle(name, st);
          const rest = customTextStyles().filter((c) => c.name.toLowerCase() !== ts.name.toLowerCase());
          writeJson(STYLE_KEY, [...rest, ts]);
          setCurrentTextStyle(ts);
          api.log(`Current text style: ${ts.name} (from file)`);
          render();
        };
        for (const [name, st] of fileStyles) {
          const bits = [
            st.font ? (findFont(st.font)?.label ?? st.font) : undefined,
            st.height ? `fixed h=${st.height}` : undefined,
            st.width ? `w=${st.width}` : undefined,
            st.oblique ? `${st.oblique}°` : undefined,
            st.bold ? "bold" : undefined,
            st.italic ? "italic" : undefined,
            st.backwards ? "backwards" : undefined,
            st.upsideDown ? "upside-down" : undefined,
            st.bigFont ? `big: ${st.bigFont}` : undefined,
          ].filter(Boolean).join(", ");
          const row = el("div", "display:flex;align-items:center;gap:6px;min-width:0");
          const label = el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1");
          label.title = `${name}: ${bits}`;
          label.append(el("b", "", name), document.createTextNode(` — ${bits || "default"}`));
          const use = el("button", BTN + ";font-size:10px;padding:1px 7px;flex:none", "Set current");
          use.title = "Make this STYLE from the drawing the current style for new text";
          use.onclick = () => adopt(name, st);
          row.append(label, use);
          grid.append(row);
        }
        fileBox.append(grid);
      }
      if (fileDims.length) {
        fileBox.append(el("div", "color:#9aa4b2;font-size:10.5px;margin-top:6px", `Dimension styles (${fileDims.length}): ${fileDims.slice(0, 12).join(", ")}${fileDims.length > 12 ? ", …" : ""}`));
      }
      body.append(fileBox);
    }

    body.append(add, note, list);
    render();
  });
}

/* ───────────────────────────── Text tool ───────────────────────────── */

/** Ask for text and place a TEXT entity at `p` using the current text style. */
export async function placeText(api: CadStyleApi, p: { x: number; y: number }): Promise<void> {
  const st = getCurrent().textStyle;
  const v = await openFormModal({
    title: "Text",
    subtitle: `Style: ${st.name}`,
    fields: [
      { kind: "textarea", key: "text", label: "Text", default: "", validate: (x) => (String(x).trim() ? null : "Enter some text") },
      { kind: "select", key: "style", label: "Style", default: st.name, options: allTextStyles().map((s) => [s.name, s.name] as [string, string]) },
      { kind: "number", key: "height", label: "Height", default: st.height, min: 0.0001, step: 0.1 },
      { kind: "number", key: "rotation", label: "Rotation", default: 0, step: 1, unit: "deg" },
      { kind: "select", key: "align", label: "Justify", default: "left", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]] },
    ],
    submitLabel: "Place text",
  });
  if (!v) return;
  const chosen = allTextStyles().find((s) => s.name === v.style) ?? st;
  setCurrentTextStyle(chosen);
  const base: TextEnt = { type: "TEXT", layer: api.currentLayer(), position: { x: p.x, y: p.y }, height: Number(v.height) || chosen.height, value: String(v.text), ...newObjectProps() };
  let e = applyTextStyle(base, chosen, { keepHeight: true });
  if (Number(v.rotation)) e = { ...e, rotation: Number(v.rotation) };
  if (v.align !== "left") e = { ...e, align: v.align as TextEnt["align"] };
  api.addEntity(e);
  api.log(`TEXT placed (${chosen.name})`);
}

/* ───────────────────────────── layer property editing ───────────────────────────── */

export type LayerField = "color" | "lineType" | "lineweight";

/** Edit one property of a layer through a small dialog. Returns true if it changed. */
export async function editLayerProperty(api: CadStyleApi, layerName: string, field: LayerField): Promise<boolean> {
  const doc = api.doc(); const lyr = doc?.layers.find((l) => l.name === layerName);
  if (!doc || !lyr) return false;
  if (field === "color") {
    const v = await openFormModal({
      title: `Layer "${layerName}" colour`,
      fields: [{ kind: "number", key: "aci", label: "ACI colour index (1-255)", default: lyr.color || 7, min: 1, max: 255, step: 1, hint: "1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black" }],
      submitLabel: "Set colour",
    });
    if (!v) return false;
    lyr.color = Math.min(255, Math.max(1, Math.round(Number(v.aci))));
    return true;
  }
  if (field === "lineType") {
    const names: Array<[string, string]> = [["Continuous", "Continuous"], ...Object.keys(doc.linetypes ?? {}).filter((n) => n !== "CONTINUOUS").map((n) => [n, n] as [string, string]), ...LINETYPE_LIBRARY.filter((l) => !doc.linetypes?.[l.name]).map((l) => [l.name, `${l.name} - ${l.description}`] as [string, string])];
    const v = await openFormModal({ title: `Layer "${layerName}" linetype`, fields: [{ kind: "select", key: "lt", label: "Linetype", default: lyr.lineType || "Continuous", options: names }], submitLabel: "Set linetype" });
    if (!v) return false;
    lyr.lineType = String(v.lt);
    ensureLinetypes(doc, [lyr.lineType]);
    return true;
  }
  const v = await openFormModal({
    title: `Layer "${layerName}" lineweight`,
    fields: [{ kind: "select", key: "lw", label: "Lineweight", default: lyr.lineweight == null ? "" : String(lyr.lineweight), options: [["", "Default"], ...LINEWEIGHTS_MM.map((w) => [String(w), lineweightLabel(w)] as [string, string])] }],
    submitLabel: "Set lineweight",
  });
  if (!v) return false;
  if (v.lw === "") delete lyr.lineweight; else lyr.lineweight = Number(v.lw);
  return true;
}

/* ───────────────────────────── Match Properties ───────────────────────────── */

/** Copy layer, colour, linetype and lineweight (and text style fields for text->text) from `source` onto `targets`. */
export function matchProperties(api: CadStyleApi, source: DxfEntity, targetIdx: number[]): number {
  const ents = api.entities();
  const before: DxfEntity[] = [], after: DxfEntity[] = [];
  for (const i of targetIdx) {
    const t = ents[i]; if (!t || t === source) continue;
    let n: DxfEntity = { ...t, layer: source.layer };
    for (const k of ["color", "rgb", "lineType", "lineweight"] as const) {
      if (source[k] == null) n = withoutKeys(n, k); else n = { ...n, [k]: source[k] } as DxfEntity;
    }
    if (n.type === "TEXT" && source.type === "TEXT") {
      for (const k of ["font", "style", "bold", "italic", "widthFactor", "oblique"] as const) {
        const sv = source[k]; n = (sv == null ? withoutKeys(n, k) : { ...n, [k]: sv }) as DxfEntity;
      }
    }
    before.push(t); after.push(n);
  }
  if (!before.length) return 0;
  const doc = api.doc(); if (doc) ensureLinetypes(doc, after.map((e) => e.lineType));
  api.commitModify(before, after);
  api.log(`MATCHPROP: properties copied to ${before.length} object(s)`);
  api.redraw();
  return before.length;
}
