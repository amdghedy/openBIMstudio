/**
 * CAD style libraries: linetypes, lineweights, fonts and text styles.
 *
 * Pure TypeScript (no DOM) so it is shared by the DXF reader/writer, the CAD
 * editor UI and the tests.
 */
import type { DxfDocument, DxfEntity, DxfUnits } from "./dxf-types";

/* ───────────────────────────── linetypes ───────────────────────────── */

export interface LinetypeDef {
  name: string;
  description: string;
  /** Pattern in millimetres: +dash, -gap, 0 = dot (DXF group 49 convention). */
  pattern: number[];
  group: "Basic" | "Centre / Phantom" | "Dash-dot" | "ISO" | "Utility";
}

const lt = (name: string, description: string, pattern: number[], group: LinetypeDef["group"]): LinetypeDef => ({ name, description, pattern, group });

/** Standard DWG acadiso.lin set plus a few drafting-office extras. Patterns in mm. */
export const LINETYPE_LIBRARY: readonly LinetypeDef[] = [
  lt("DASHED", "Dashed", [12.7, -6.35], "Basic"),
  lt("DASHED2", "Dashed (.5x)", [6.35, -3.175], "Basic"),
  lt("DASHEDX2", "Dashed (2x)", [25.4, -12.7], "Basic"),
  lt("HIDDEN", "Hidden", [6.35, -3.175], "Basic"),
  lt("HIDDEN2", "Hidden (.5x)", [3.175, -1.5875], "Basic"),
  lt("HIDDENX2", "Hidden (2x)", [12.7, -6.35], "Basic"),
  lt("DOT", "Dot", [0, -6.35], "Basic"),
  lt("DOT2", "Dot (.5x)", [0, -3.175], "Basic"),
  lt("DOTX2", "Dot (2x)", [0, -12.7], "Basic"),
  lt("LONGDASH", "Long dash", [38.1, -6.35], "Utility"),
  lt("SHORTDASH", "Short dash", [3.175, -3.175], "Utility"),
  lt("CENTER", "Center", [31.75, -6.35, 6.35, -6.35], "Centre / Phantom"),
  lt("CENTER2", "Center (.5x)", [19.05, -3.175, 3.175, -3.175], "Centre / Phantom"),
  lt("CENTERX2", "Center (2x)", [63.5, -12.7, 12.7, -12.7], "Centre / Phantom"),
  lt("PHANTOM", "Phantom", [31.75, -6.35, 6.35, -6.35, 6.35, -6.35], "Centre / Phantom"),
  lt("PHANTOM2", "Phantom (.5x)", [15.875, -3.175, 3.175, -3.175, 3.175, -3.175], "Centre / Phantom"),
  lt("PHANTOMX2", "Phantom (2x)", [63.5, -12.7, 12.7, -12.7, 12.7, -12.7], "Centre / Phantom"),
  lt("DASHDOT", "Dash dot", [12.7, -6.35, 0, -6.35], "Dash-dot"),
  lt("DASHDOT2", "Dash dot (.5x)", [6.35, -3.175, 0, -3.175], "Dash-dot"),
  lt("DASHDOTX2", "Dash dot (2x)", [25.4, -12.7, 0, -12.7], "Dash-dot"),
  lt("DIVIDE", "Divide", [12.7, -6.35, 0, -6.35, 0, -6.35], "Dash-dot"),
  lt("DIVIDE2", "Divide (.5x)", [6.35, -3.175, 0, -3.175, 0, -3.175], "Dash-dot"),
  lt("DIVIDEX2", "Divide (2x)", [25.4, -12.7, 0, -12.7, 0, -12.7], "Dash-dot"),
  lt("BORDER", "Border", [12.7, -6.35, 12.7, -6.35, 0, -6.35], "Dash-dot"),
  lt("BORDER2", "Border (.5x)", [6.35, -3.175, 6.35, -3.175, 0, -3.175], "Dash-dot"),
  lt("BORDERX2", "Border (2x)", [25.4, -12.7, 25.4, -12.7, 0, -12.7], "Dash-dot"),
  lt("ACAD_ISO02W100", "ISO dash", [12, -3], "ISO"),
  lt("ACAD_ISO03W100", "ISO dash space", [12, -18], "ISO"),
  lt("ACAD_ISO04W100", "ISO long-dash dot", [24, -3, 0, -3], "ISO"),
  lt("ACAD_ISO05W100", "ISO long-dash double-dot", [24, -3, 0, -3, 0, -3], "ISO"),
  lt("ACAD_ISO06W100", "ISO long-dash triple-dot", [24, -3, 0, -3, 0, -3, 0, -3], "ISO"),
  lt("ACAD_ISO07W100", "ISO dot", [0, -3], "ISO"),
  lt("ACAD_ISO08W100", "ISO long-dash short-dash", [24, -3, 6, -3], "ISO"),
  lt("ACAD_ISO09W100", "ISO long-dash double-short-dash", [24, -3, 6, -3, 6, -3], "ISO"),
  lt("ACAD_ISO10W100", "ISO dash dot", [12, -3, 0, -3], "ISO"),
  lt("ACAD_ISO11W100", "ISO double-dash dot", [12, -3, 12, -3, 0, -3], "ISO"),
  lt("ACAD_ISO12W100", "ISO dash double-dot", [12, -3, 0, -3, 0, -3], "ISO"),
  lt("ACAD_ISO13W100", "ISO double-dash double-dot", [12, -3, 12, -3, 0, -3, 0, -3], "ISO"),
  lt("ACAD_ISO14W100", "ISO dash triple-dot", [12, -3, 0, -3, 0, -3, 0, -3], "ISO"),
  lt("ACAD_ISO15W100", "ISO double-dash triple-dot", [12, -3, 12, -3, 0, -3, 0, -3, 0, -3], "ISO"),
];

/** Names that always exist and need no table entry. */
export const BUILTIN_LINETYPES = ["CONTINUOUS", "BYLAYER", "BYBLOCK"] as const;

export function findLinetype(name: string): LinetypeDef | undefined {
  const n = name.trim().toUpperCase();
  return LINETYPE_LIBRARY.find((l) => l.name === n);
}

/** Multiplier from the millimetre library to a drawing's units. */
export function linetypeUnitScale(units: DxfUnits | undefined): number {
  switch (units) {
    case "cm": return 0.1;
    case "m": return 0.001;
    case "in": return 1 / 25.4;
    case "ft": return 1 / 304.8;
    default: return 1; // mm and unitless
  }
}

/** Library pattern converted to the drawing's units. */
export function scaledPattern(def: LinetypeDef, units: DxfUnits | undefined): number[] {
  const k = linetypeUnitScale(units);
  return def.pattern.map((v) => (v === 0 ? 0 : +(v * k).toPrecision(8)));
}

/**
 * Make sure every named linetype that the library knows is defined in `doc.linetypes`
 * (so the renderer and the DXF writer both see it). Returns the names that were added.
 */
export function ensureLinetypes(doc: Pick<DxfDocument, "linetypes" | "units">, names: Iterable<string | undefined>): string[] {
  const added: string[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const key = raw.trim().toUpperCase();
    if ((BUILTIN_LINETYPES as readonly string[]).includes(key)) continue;
    if (doc.linetypes?.[key]?.length) continue;
    const def = findLinetype(key);
    if (!def) continue;
    doc.linetypes = doc.linetypes ?? {};
    doc.linetypes[key] = scaledPattern(def, doc.units);
    added.push(key);
  }
  return added;
}

/** Linetype names referenced by layers and entities (excluding built-ins). */
export function linetypesInUse(doc: Pick<DxfDocument, "layers" | "entities">): string[] {
  const set = new Set<string>();
  const add = (n?: string) => {
    const k = n?.trim().toUpperCase();
    if (k && !(BUILTIN_LINETYPES as readonly string[]).includes(k)) set.add(k);
  };
  for (const l of doc.layers) add(l.lineType);
  for (const e of doc.entities) add(e.lineType);
  return [...set];
}

/** Dash array in CSS px for a small preview swatch of a pattern. `unit` = px per mm. */
export function previewDash(pattern: number[], unit = 1.6): number[] {
  if (pattern.length < 2) return [];
  return pattern.map((v) => (Math.abs(v) < 1e-9 ? 1.2 : Math.max(Math.abs(v) * unit, 1)));
}

/* ───────────────────────────── lineweights ───────────────────────────── */

/** DWG standard lineweights in mm. */
export const LINEWEIGHTS_MM: readonly number[] = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11,
];

export function nearestLineweight(mm: number): number {
  let best = LINEWEIGHTS_MM[0];
  for (const w of LINEWEIGHTS_MM) if (Math.abs(w - mm) < Math.abs(best - mm)) best = w;
  return best;
}
/** DXF group 370 value (1/100 mm). */
export const lineweightToDxf = (mm: number): number => Math.round(nearestLineweight(mm) * 100);
/** mm from DXF group 370, or undefined for ByLayer (-1) / ByBlock (-2) / Default (-3). */
export const lineweightFromDxf = (v: number): number | undefined => (Number.isFinite(v) && v >= 0 ? v / 100 : undefined);
export const lineweightLabel = (mm: number | undefined): string => (mm == null ? "ByLayer" : mm === 0 ? "0.00 mm" : `${mm.toFixed(2)} mm`);

/* ───────────────────────────── fonts ───────────────────────────── */

export type FontKind = "sans" | "serif" | "mono" | "script" | "stroke";

export interface CadFont {
  id: string;
  label: string;
  /** CSS font-family stack used on screen. */
  css: string;
  kind: FontKind;
  /** File name written to DXF STYLE (group 3). */
  file: string;
}

const f = (id: string, label: string, css: string, kind: FontKind, file: string): CadFont => ({ id, label, css, kind, file });

/** System fonts plus on-screen equivalents of the common DWG stroke (SHX) fonts. */
export const CAD_FONTS: readonly CadFont[] = [
  f("Arial", "Arial", '"Arial", "Helvetica", sans-serif', "sans", "arial.ttf"),
  f("Arial Narrow", "Arial Narrow", '"Arial Narrow", "Arial", sans-serif', "sans", "arialn.ttf"),
  f("Helvetica", "Helvetica", '"Helvetica", "Arial", sans-serif', "sans", "arial.ttf"),
  f("Calibri", "Calibri", '"Calibri", "Carlito", sans-serif', "sans", "calibri.ttf"),
  f("Segoe UI", "Segoe UI", '"Segoe UI", system-ui, sans-serif', "sans", "segoeui.ttf"),
  f("Verdana", "Verdana", '"Verdana", sans-serif', "sans", "verdana.ttf"),
  f("Tahoma", "Tahoma", '"Tahoma", sans-serif', "sans", "tahoma.ttf"),
  f("Trebuchet MS", "Trebuchet MS", '"Trebuchet MS", sans-serif', "sans", "trebuc.ttf"),
  f("Century Gothic", "Century Gothic", '"Century Gothic", "Arial", sans-serif', "sans", "gothic.ttf"),
  f("Times New Roman", "Times New Roman", '"Times New Roman", Times, serif', "serif", "times.ttf"),
  f("Georgia", "Georgia", '"Georgia", serif', "serif", "georgia.ttf"),
  f("Cambria", "Cambria", '"Cambria", serif', "serif", "cambria.ttc"),
  f("Garamond", "Garamond", '"Garamond", serif', "serif", "gara.ttf"),
  f("Palatino Linotype", "Palatino Linotype", '"Palatino Linotype", "Book Antiqua", serif', "serif", "pala.ttf"),
  f("Courier New", "Courier New", '"Courier New", Courier, monospace', "mono", "cour.ttf"),
  f("Consolas", "Consolas", '"Consolas", monospace', "mono", "consola.ttf"),
  f("Lucida Console", "Lucida Console", '"Lucida Console", monospace', "mono", "lucon.ttf"),
  f("Segoe Script", "Segoe Script", '"Segoe Script", "Brush Script MT", cursive', "script", "segoesc.ttf"),
  f("Bradley Hand", "Bradley Hand", '"Bradley Hand ITC", "Bradley Hand", cursive', "script", "bradhitc.ttf"),
  f("simplex.shx", "Simplex (SHX)", "system-ui, sans-serif", "stroke", "simplex.shx"),
  f("romans.shx", "RomanS (SHX)", "system-ui, sans-serif", "stroke", "romans.shx"),
  f("romanc.shx", "RomanC (SHX)", '"Times New Roman", serif', "stroke", "romanc.shx"),
  f("romant.shx", "RomanT (SHX)", '"Times New Roman", serif', "stroke", "romant.shx"),
  f("isocp.shx", "ISOCP (SHX)", "system-ui, sans-serif", "stroke", "isocp.shx"),
  f("isocpeur.shx", "ISOCPEUR (SHX)", "system-ui, sans-serif", "stroke", "isocpeur.ttf"),
  f("txt.shx", "Txt (SHX)", '"Courier New", monospace', "stroke", "txt.shx"),
  f("monotxt.shx", "MonoTxt (SHX)", '"Courier New", monospace', "stroke", "monotxt.shx"),
  f("italicc.shx", "ItalicC (SHX)", '"Times New Roman", serif', "stroke", "italicc.shx"),
  f("scriptc.shx", "ScriptC (SHX)", '"Segoe Script", cursive', "stroke", "scriptc.shx"),
];

export function findFont(name: string | undefined): CadFont | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  const stem = n.replace(/\.(shx|ttf|otf|ttc)$/i, "");
  return CAD_FONTS.find((x) => x.id.toLowerCase() === n || x.file.toLowerCase() === n || x.id.toLowerCase().replace(/\.shx$/, "") === stem || x.label.toLowerCase() === n);
}

/** File name to store in a DXF STYLE record for a font selection. */
export function fontDxfFile(font: string | undefined): string {
  if (!font) return "txt";
  const known = findFont(font);
  if (known) return known.file;
  if (/\.(shx|ttf|otf|ttc)$/i.test(font)) return font;
  return font.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) + ".ttf";
}

/** Is the font a TrueType family (needs the extended face record) rather than an SHX file? */
export const isTrueTypeFont = (font: string | undefined): boolean => !!font && !/\.shx$/i.test(font);

/* ───────────────────────────── text styles ───────────────────────────── */

export interface TextStyle {
  name: string;
  font: string;
  height: number;
  widthFactor?: number;
  oblique?: number;
  bold?: boolean;
  italic?: boolean;
  /** One-line description for the UI. */
  note?: string;
}

/** Ready-made text styles (heights are in drawing units for a 1:1 mm drawing). */
export const TEXT_STYLE_PRESETS: readonly TextStyle[] = [
  { name: "Standard", font: "Arial", height: 2.5, note: "General notes" },
  { name: "Title", font: "Arial", height: 7, bold: true, note: "Sheet / drawing titles" },
  { name: "Subtitle", font: "Arial", height: 5, note: "View titles" },
  { name: "Notes", font: "Arial Narrow", height: 2.5, note: "General notes, narrow" },
  { name: "Dimension", font: "isocp.shx", height: 2.5, note: "Dimension text" },
  { name: "ISO 3098", font: "isocpeur.shx", height: 3.5, oblique: 15, italic: true, note: "ISO lettering, 15° slant" },
  { name: "Architectural", font: "Segoe Script", height: 3, note: "Hand-lettered look" },
  { name: "Engineering", font: "romans.shx", height: 2.5, note: "Engineering block lettering" },
  { name: "Serif", font: "Times New Roman", height: 3, note: "Report style" },
  { name: "Monospace", font: "Consolas", height: 2.5, note: "Schedules and tables" },
];

/** Copy a style's fields onto a TEXT entity (returns a new entity; the input is not mutated). */
export function applyTextStyle<T extends Extract<DxfEntity, { type: "TEXT" }>>(e: T, st: TextStyle, opts: { keepHeight?: boolean } = {}): T {
  const out: T = { ...e, style: st.name, font: st.font };
  if (!opts.keepHeight) out.height = st.height;
  if (st.widthFactor && Math.abs(st.widthFactor - 1) > 1e-6) out.widthFactor = st.widthFactor; else delete out.widthFactor;
  if (st.oblique && Math.abs(st.oblique) > 1e-6) out.oblique = st.oblique; else delete out.oblique;
  if (st.bold) out.bold = true; else delete out.bold;
  if (st.italic) out.italic = true; else delete out.italic;
  return out;
}

/** Canvas font shorthand for a text with the given font, honouring the CAD font table. */
export function cssFontFor(font: string | undefined, px: number, bold?: boolean, italic?: boolean): string {
  const known = findFont(font);
  const stack = known ? known.css : font ? `"${font.replace(/\.(shx|ttf|otf|ttc)$/i, "").replace(/[^A-Za-z0-9 _-]/g, "")}", sans-serif` : "sans-serif";
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${px}px ${stack}`;
}
