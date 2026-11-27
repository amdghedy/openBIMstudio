/**
 * DXF ASCII writer (DWG R2010 / AC1024 compatible subset).
 * Pure TypeScript - no native deps.
 */

import type { DxfDimStyle, DxfDocument, DxfEntity, DxfLayer, DxfLayout, DxfPoint, DxfViewport } from "./dxf-types";
import { ensureLinetypes, fontDxfFile, isTrueTypeFont, lineweightToDxf, linetypesInUse } from "./cad-styles";
import { PAPER_MM, TEXT_LINE_PITCH } from "../cad-viewer/viewer-math";
import { polylineBBox } from "./dxf-geometry";
import { tableCorners, tableTextHeight } from "./cad-table";
import { nativeIfValid, splineDxfBody, ellipseDxfBody } from "./native-curves";
import type { DxfAttDef, DxfBlockDef, DxfInsert } from "./dxf-types";

/** INSERT with its ATTRIB records and SEQEND (DXF requires them to directly follow the INSERT). */
function writeInsert(e: DxfInsert): string {
  const attrs = e.attributes ?? [];
  let s = entityHead(e, "INSERT");
  if (!legacyPrologue) s += pair(100, "AcDbBlockReference");
  if (attrs.length) s += pair(66, 1);
  s += pair(2, e.name);
  s += writePoint([10, 20, 30], e.position);
  const sc = e.scale;
  if (sc && (sc.x !== 1 || sc.y !== 1 || (sc.z ?? 1) !== 1)) s += pair(41, sc.x) + pair(42, sc.y) + pair(43, sc.z ?? 1);
  if (e.rotation) s += pair(50, e.rotation);
  if ((e.columns ?? 1) > 1 || (e.rows ?? 1) > 1) {
    s += pair(70, e.columns ?? 1) + pair(71, e.rows ?? 1) + pair(44, e.columnSpacing ?? 0) + pair(45, e.rowSpacing ?? 0);
  }
  if (attrs.length) {
    for (const a of attrs) {
      let t = pair(0, "ATTRIB");
      if (!legacyPrologue) t += pair(5, nextHandle()) + pair(100, "AcDbEntity");
      t += pair(8, a.layer ?? e.layer);
      if (!legacyPrologue) t += pair(100, "AcDbText");
      t += writePoint([10, 20, 30], a.position) + pair(40, a.height) + pair(1, a.value);
      if (a.rotation) t += pair(50, a.rotation);
      if (!legacyPrologue) t += pair(100, "AcDbAttribute");
      t += pair(2, a.tag) + pair(70, a.invisible ? 1 : 0);
      s += t;
    }
    s += pair(0, "SEQEND");
    if (!legacyPrologue) s += pair(5, nextHandle()) + pair(100, "AcDbEntity");
    s += pair(8, e.layer);
  }
  return s;
}

function writeAttDef(d: DxfAttDef): string {
  let s = pair(0, "ATTDEF") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(8, d.layer ?? "0") + pair(100, "AcDbText");
  s += writePoint([10, 20, 30], d.position) + pair(40, d.height) + pair(1, d.defaultValue);
  if (d.rotation) s += pair(50, d.rotation);
  s += pair(100, "AcDbAttributeDefinition") + pair(3, d.prompt || d.tag) + pair(2, d.tag);
  s += pair(70, (d.invisible ? 1 : 0) | (d.constant ? 2 : 0) | (d.verify ? 4 : 0) | (d.preset ? 8 : 0));
  return s;
}

function writeBlockDef(b: DxfBlockDef, styleName: (t: Extract<DxfEntity, { type: "TEXT" }>) => string, hatches: boolean): string {
  let s = pair(0, "BLOCK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(8, "0");
  s += pair(100, "AcDbBlockBegin") + pair(2, b.name) + pair(70, b.name.startsWith("*") ? 1 : 0);
  s += writePoint([10, 20, 30], b.base) + pair(3, b.name) + pair(1, "");
  for (const d of b.attdefs) s += writeAttDef(d);
  for (const e of b.entities) s += writeEntity(e, styleName, hatches);
  s += pair(0, "ENDBLK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(8, "0") + pair(100, "AcDbBlockEnd");
  return s;
}

function blockRecordTable(
  blocks: DxfBlockDef[],
  paperRecords: Array<{ name: string; layoutHandle: string; recordHandle: string }> = [],
): string {
  const total = blocks.length + paperRecords.length;
  let s = pair(0, "TABLE") + pair(2, "BLOCK_RECORD") + pair(5, nextHandle()) + pair(100, "AcDbSymbolTable") + pair(70, total);
  for (const b of blocks) s += pair(0, "BLOCK_RECORD") + pair(5, nextHandle()) + pair(100, "AcDbSymbolTableRecord") + pair(100, "AcDbBlockTableRecord") + pair(2, b.name);
  // Paper-space block records carry group 340 -> their LAYOUT object, so a
  // reader can resolve the layout name for the block (A8/A19). Their handles
  // are pre-assigned by the caller: the LAYOUT objects point back at them
  // (group 330), so both sides must agree before either is written.
  for (const p of paperRecords) s += pair(0, "BLOCK_RECORD") + pair(5, p.recordHandle) + pair(100, "AcDbSymbolTableRecord") + pair(100, "AcDbBlockTableRecord") + pair(2, p.name) + pair(340, p.layoutHandle);
  return s + pair(0, "ENDTAB");
}

function pair(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

function writePoint(codes: [number, number, number], p: DxfPoint): string {
  return (
    pair(codes[0], p.x) +
    pair(codes[1], p.y) +
    pair(codes[2], p.z ?? 0)
  );
}

let handleSeq = 0x100;
const nextHandle = (): string => (handleSeq++).toString(16).toUpperCase();

function layerTable(layers: DxfLayer[]): { text: string; handles: Map<string, string> } {
  let s = "";
  const handles = new Map<string, string>();
  s += pair(0, "TABLE");
  s += pair(2, "LAYER");
  s += pair(5, "2");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, layers.length);
  for (const layer of layers) {
    s += pair(0, "LAYER");
    const handle = nextHandle();
    // 2D-6: a viewport's per-viewport freeze (group 331) names layers by
    // handle, so the handle of every layer is recorded here.
    if (!handles.has(layer.name)) handles.set(layer.name, handle);
    s += pair(5, handle);
    s += pair(100, "AcDbSymbolTableRecord");
    s += pair(100, "AcDbLayerTableRecord");
    s += pair(2, layer.name);
    s += pair(70, (layer.frozen ? 1 : 0) | (layer.locked ? 4 : 0));
    const aci = layer.color || 7;
    s += pair(62, layer.off ? -aci : aci); // negative colour = layer off
    s += pair(6, layer.lineType || "Continuous");
    if (layer.lineweight != null) s += pair(370, lineweightToDxf(layer.lineweight));
    if (layer.rgb != null) s += pair(420, layer.rgb & 0xffffff);
    if (layer.transparency) s += pair(440, layer.transparency << 24);
    if (layer.plot === false) s += pair(290, 0);
  }
  s += pair(0, "ENDTAB");
  return { text: s, handles };
}

function linetypeTable(defs: Record<string, number[]>): string {
  const names = Object.keys(defs).filter((n) => defs[n].length >= 2 && n !== "CONTINUOUS");
  let s = "";
  s += pair(0, "TABLE");
  s += pair(2, "LTYPE");
  s += pair(5, "1");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, names.length + 1);
  s += pair(0, "LTYPE");
  s += pair(5, nextHandle());
  s += pair(100, "AcDbSymbolTableRecord");
  s += pair(100, "AcDbLinetypeTableRecord");
  s += pair(2, "Continuous");
  s += pair(70, 0);
  s += pair(3, "Solid line");
  s += pair(72, 65);
  s += pair(73, 0);
  s += pair(40, 0);
  for (const name of names) {
    const pat = defs[name];
    s += pair(0, "LTYPE");
    s += pair(5, nextHandle());
    s += pair(100, "AcDbSymbolTableRecord");
    s += pair(100, "AcDbLinetypeTableRecord");
    s += pair(2, name);
    s += pair(70, 0);
    s += pair(3, "");
    s += pair(72, 65);
    s += pair(73, pat.length);
    s += pair(40, pat.reduce((a, v) => a + Math.abs(v), 0));
    for (const v of pat) { s += pair(49, v); s += pair(74, 0); }
  }
  s += pair(0, "ENDTAB");
  return s;
}

/** Text styles needed by the TEXT entities; returns the STYLE table and a per-entity style name lookup. */
function styleTable(entities: DxfEntity[]): { table: string; nameFor: (e: Extract<DxfEntity, { type: "TEXT" }>) => string } {
  const byKey = new Map<string, { name: string; font?: string; bold: boolean; italic: boolean }>();
  const used = new Set<string>(["STANDARD"]);
  const keyOf = (e: Extract<DxfEntity, { type: "TEXT" }>) => `${(e.font ?? "").toLowerCase()}|${e.bold ? 1 : 0}|${e.italic ? 1 : 0}`;
  for (const e of entities) {
    if (e.type !== "TEXT") continue;
    const k = keyOf(e);
    if (byKey.has(k)) continue;
    if (!e.font && !e.bold && !e.italic) continue; // plain: use Standard
    let name = (e.style || (e.font ?? "Style").replace(/\.(shx|ttf|otf|ttc)$/i, "")).replace(/[^A-Za-z0-9_$-]/g, "_") || "Style";
    let n = 1; const base = name;
    while (used.has(name.toUpperCase())) name = `${base}_${++n}`;
    used.add(name.toUpperCase());
    byKey.set(k, { name, font: e.font, bold: !!e.bold, italic: !!e.italic });
  }
  const recs = [{ name: "Standard", font: undefined as string | undefined, bold: false, italic: false }, ...byKey.values()];
  let s = "";
  s += pair(0, "TABLE");
  s += pair(2, "STYLE");
  s += pair(5, "3");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, recs.length);
  for (const r of recs) {
    s += pair(0, "STYLE");
    s += pair(5, nextHandle());
    s += pair(100, "AcDbSymbolTableRecord");
    s += pair(100, "AcDbTextStyleTableRecord");
    s += pair(2, r.name);
    s += pair(70, 0);
    s += pair(40, 0);
    s += pair(41, 1);
    s += pair(50, 0);
    s += pair(71, 0);
    s += pair(42, 2.5);
    s += pair(3, r.font ? fontDxfFile(r.font) : "arial.ttf");
    s += pair(4, "");
    if (!r.font) {
      s += pair(1001, "ACAD");
      s += pair(1000, "Arial");
      s += pair(1071, 0);
    } else if (isTrueTypeFont(r.font)) {
      s += pair(1001, "ACAD");
      s += pair(1000, r.font);
      s += pair(1071, (r.bold ? 0x2000000 : 0) | (r.italic ? 0x1000000 : 0));
    } else if (r.bold || r.italic) {
      s += pair(1001, "ACAD");
      s += pair(1071, (r.bold ? 0x2000000 : 0) | (r.italic ? 0x1000000 : 0));
    }
  }
  s += pair(0, "ENDTAB");
  return { table: s, nameFor: (e) => (!e.font && !e.bold && !e.italic ? e.style && e.style.toUpperCase() !== "STANDARD" && used.has(e.style.toUpperCase()) ? e.style : "Standard" : byKey.get(keyOf(e))!.name) };
}

/** Common entity attributes: layer, ACI colour, linetype, lineweight, true colour, lt-scale, transparency. */
function common(e: DxfEntity): string {
  let s = pair(8, e.layer || "0");
  if (e.lineType) s += pair(6, e.lineType);
  s += pair(62, e.color ?? 256); // 256 = ByLayer
  if (e.invisible) s += pair(60, 1); // group 60 Invisible — HIDEOBJECTS/ISOLATEOBJECTS state
  if (e.lineweight != null) s += pair(370, lineweightToDxf(e.lineweight));
  if (e.rgb != null) s += pair(420, e.rgb & 0xffffff);
  if (e.ltScale != null && Math.abs(e.ltScale - 1) > 1e-9) s += pair(48, e.ltScale);
  if (e.transparency) s += pair(440, e.transparency << 24);
  // 2D-8: elevation (38) and thickness (39) are AcDbEntity groups, so
  // they ride in the common prologue for every entity type that carries
  // them; only non-zero values are written.
  if (e.elevation != null && e.elevation !== 0) s += pair(38, e.elevation);
  if (e.thickness != null && e.thickness !== 0) s += pair(39, e.thickness);
  return s;
}

/**
 * Conformant entity prologue: type + handle + the required AcDbEntity subclass
 * marker, then the common properties. External DXF loaders (ezdxf, desktop CAD)
 * key their parsers off subclass markers — an entity written as bare
 * "0/HATCH + 8/layer + 100/AcDbHatch" is rejected as structurally invalid even
 * though lenient readers accept it.
 */

/**
 * Extra paper-space sheets written into the BLOCKS section keep the legacy
 * marker-less entity form: the pinned acadrust converter maps *Paper_SpaceN blocks back
 * to sheets with exactly that structure, and conformant prologues inside those blocks
 * drop the last sheet and leak its content into model space (bisected against
 * tests/cad-dwg-roundtrip). Everything in the ENTITIES section is conformant.
 */
let legacyPrologue = false;

function entityHead(e: DxfEntity, type: string): string {
  let s = pair(0, type);
  if (!legacyPrologue) {
    s += pair(5, nextHandle());
    s += pair(100, "AcDbEntity");
  }
  s += common(e);
  return s;
}

/**
 * HATCH entity for a polyline that carries fill data: solid fills and patterned fills
 * (with the real pattern lines when the entity has them). Boundaries are written as
 * closed polyline paths; the first loop is the external one. Without this a hatch was
 * saved as a bare outline and the fill was lost.
 */
function writeHatch(e: Extract<DxfEntity, { type: "LWPOLYLINE" }>): string {
  const h = e.hatch!;
  const loops = h.loops.filter((l) => l.length >= 3);
  const solid = h.solid || !h.pattern || h.pattern.toUpperCase() === "SOLID";
  let s = entityHead(e, "HATCH");
  s += pair(100, "AcDbHatch");
  s += pair(10, 0) + pair(20, 0) + pair(30, 0);
  s += pair(210, 0) + pair(220, 0) + pair(230, 1);
  s += pair(2, solid ? "SOLID" : h.pattern!);
  s += pair(70, solid ? 1 : 0);
  s += pair(71, 0);
  s += pair(91, loops.length);
  loops.forEach((loop, i) => {
    s += pair(92, i === 0 ? 3 : 2); // polyline path; external for the first loop
    s += pair(72, 0) + pair(73, 1) + pair(93, loop.length);
    for (const p of loop) s += pair(10, p.x) + pair(20, p.y);
    s += pair(97, 0);
  });
  s += pair(75, 0); // hatch style: normal
  s += pair(76, 1); // pattern type: predefined
  if (!solid) {
    // Pattern-space families (authored hatches, DXF HATCH imports) still carry
    // the hatch's own angle/scale — write both so native CAD applies them.
    // Drawing-space families (DWG imports, already transformed by the mapper)
    // must export at 0/1 or native CAD would apply the transform twice.
    // Hatches without families keep their angle/scale: native CAD resolves the
    // predefined pattern name from its own library and applies them there.
    const baked = !!h.patternLines?.length && !h.patternSpace;
    s += pair(52, baked ? 0 : h.angle ?? 0);
    s += pair(41, baked ? 1 : h.scale ?? 1);
    s += pair(77, 0);
    const lines = h.patternLines ?? [];
    s += pair(78, lines.length);
    for (const ln of lines) {
      s += pair(53, (ln.angle * 180) / Math.PI);
      s += pair(43, ln.base[0]) + pair(44, ln.base[1]);
      s += pair(45, ln.offset[0]) + pair(46, ln.offset[1]);
      s += pair(79, ln.dashes.length);
      for (const d of ln.dashes) s += pair(49, d);
    }
  }
  s += pair(47, 1);
  s += pair(98, 0);
  return s;
}

/** Mark an entity record as paper space (group 67 = 1 inside the AcDbEntity subclass). */
function inPaperSpace(rec: string): string {
  if (legacyPrologue) return rec.replace(/^(0\n[^\n]+\n)/, "$167\n1\n");
  return rec.replace(/^(0\n[^\n]+\n5\n[0-9A-F]+\n100\nAcDbEntity\n)/, "$167\n1\n");
}

/** VIEWPORT entity; returns the written text plus its handle (null in the legacy form, which has none). A8: a locked viewport carries group 90 bit 16384; a clipped viewport carries group 340 pointing at its clip-boundary entity. 2D-6: a per-viewport freeze carries group 331 per frozen layer (soft-pointer handle to the LAYER object); names with no layer handle are dropped. */
function writeViewport(vp: DxfViewport, id: number, clipHandle?: string | null, layerHandles?: Map<string, string>): { text: string; handle: string | null } {
  let handle: string | null = null;
  let s = pair(0, "VIEWPORT");
  if (legacyPrologue) {
    // A8/A19: the AcDbEntity marker is REQUIRED here even in the legacy
    // form — without it a strict reader (ezdxf) cannot split the
    // AcDbViewport subclass and the viewport's geometry reads back as
    // defaults (proven by patching one record). The handle stays omitted:
    // a full conformant prologue in these blocks breaks the DWG converter
    // (see the legacyPrologue note above); the marker alone does not
    // (verified by the DWG round-trip suite).
    s += pair(8, "0") + pair(67, 1) + pair(100, "AcDbEntity") + pair(100, "AcDbViewport");
  } else {
    handle = nextHandle();
    s += pair(5, handle) + pair(100, "AcDbEntity") + pair(67, 1) + pair(8, "0") + pair(100, "AcDbViewport");
  }
  s += pair(10, vp.center.x) + pair(20, vp.center.y) + pair(30, 0);
  s += pair(40, vp.width) + pair(41, vp.height);
  s += pair(68, 1) + pair(69, id);
  s += pair(12, vp.viewCenter.x) + pair(22, vp.viewCenter.y);
  s += pair(45, vp.viewHeight);
  if (vp.twist) s += pair(51, vp.twist);
  // A8: the rectangular clip boundary is the LWPOLYLINE whose handle group
  // 340 names (DXF reference, VIEWPORT group 340). The boundary is written
  // by the caller (writeClipBoundary) before the viewport.
  if (clipHandle) s += pair(340, clipHandle);
  // A8: viewport zoom lock — DXF reference, VIEWPORT group 90 bit 16384.
  if (vp.locked) s += pair(90, 16384);
  // 2D-6: per-viewport freeze — DXF reference, VIEWPORT group 331, one
  // soft-pointer handle per frozen layer. Stale names (no layer handle)
  // are dropped rather than written as dangling pointers.
  for (const name of vp.frozenLayers ?? []) {
    const h = layerHandles?.get(name);
    if (h) s += pair(331, h);
  }
  return { text: s, handle };
}

/**
 * A viewport's rectangular clip boundary: a closed 4-point LWPOLYLINE in
 * sheet coordinates, paper space (group 67 = 1). Written with the conformant
 * prologue (handle + AcDbEntity + AcDbPolyline) even inside the legacy
 * extra-sheet blocks — without a handle the viewport's group 340 cannot
 * reference it, and the converter tolerates the marker/handle here (the
 * DWG round-trip suite covers a clipped viewport in an extra sheet).
 * The caller writes the boundary before the viewport and passes the handle.
 */
function writeClipBoundary(clip: { minX: number; minY: number; maxX: number; maxY: number }): { text: string; handle: string } {
  const handle = nextHandle();
  const { minX, minY, maxX, maxY } = clip;
  let s = pair(0, "LWPOLYLINE") + pair(5, handle) + pair(100, "AcDbEntity") + pair(67, 1) + pair(8, "0") + pair(100, "AcDbPolyline");
  s += pair(90, 4) + pair(70, 1);
  for (const [x, y] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as const) s += pair(10, x) + pair(20, y);
  return { text: s, handle };
}

/**
 * Layouts that a DXF save cannot keep: none since A8/A19 — every layout is
 * written with a real LAYOUT object (plus its *Paper_SpaceN block), so a
 * plain DXF round-trips all sheets with their names. Kept as the callers'
 * hook: it now always returns 0.
 */
export function layoutsNotSaved(_doc: Pick<DxfDocument, "layouts">): number {
  return 0;
}

/** Resolved plot settings for one layout: its named setup wins, else its own stamped values. */
function layoutPlotSettings(
  doc: DxfDocument,
  layout: DxfLayout,
): { setupName: string; paper: string; orient: "landscape" | "portrait"; scale: number | "fit"; area: "display" | "extents" | "window" | "layout" } {
  const setup = layout.pageSetup ? doc.pageSetups?.[layout.pageSetup] : undefined;
  return {
    setupName: setup?.name ?? layout.pageSetup ?? "",
    paper: setup?.paper ?? layout.paper ?? "A3",
    // Viewer sheets are portrait A3 by default (addLayout); a named setup
    // brings its own orientation.
    orient: setup?.orient ?? "portrait",
    scale: setup?.scale ?? layout.plotScale ?? "fit",
    area: setup?.area ?? layout.plotArea ?? "layout",
  };
}

/** Paper dimensions in mm for a paper name + orientation (A3 when unknown). */
function layoutPaperMm(paper: string, orient: "landscape" | "portrait"): { w: number; h: number } {
  const [s, l] = PAPER_MM[paper] ?? PAPER_MM.A3;
  return orient === "landscape" ? { w: l, h: s } : { w: s, h: l };
}

/** Plot scale as a reduced numerator/denominator pair (DXF groups 142/143). "fit" writes 1/1 — the fit choice itself lives in the setup, not the file. */
function scaleNumDen(scale: number | "fit"): [number, number] {
  if (scale === "fit") return [1, 1];
  const den = 1 / scale;
  const n = Math.round(den);
  if (Number.isFinite(den) && den > 0 && Math.abs(den - n) < 1e-9) return [1, n];
  const num = Math.round(scale * 10000), d = 10000;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(Math.abs(num), d) || 1;
  return [num / g, d / g];
}

/**
 * One LAYOUT object (DXF reference, verified against ezdxf 1.4.5 output):
 * AcDbPlotSettings carries the page-setup name (group 1), paper name (4),
 * paper size in mm (44/45), custom plot scale (142/143), paper units (72=mm)
 * and plot area type (74: 0 display, 1 extents, 4 window, 5 layout);
 * AcDbLayout carries the layout name (1), tab order (71) and paper extents
 * (10/20 min, 11/21 max). The FIRST group 330 is the owning ACAD_LAYOUT
 * dictionary; the LAST group 330 is the paper-space BLOCK_RECORD (extra
 * sheets only — the first sheet and Model have no such record); 331 lists
 * the viewport handles (only the first sheet's, which are conformant).
 */
function writeLayoutObject(o: {
  handle: string;
  name: string;
  tabOrder: number;
  paper: string;
  orient: "landscape" | "portrait";
  setupName: string;
  scale: number | "fit";
  area: "display" | "extents" | "window" | "layout";
  dictHandle: string;
  recordHandle?: string;
  viewportHandles?: string[];
}): string {
  const { w, h } = layoutPaperMm(o.paper, o.orient);
  const [num, den] = scaleNumDen(o.scale);
  const area74 = o.area === "display" ? 0 : o.area === "extents" ? 1 : o.area === "window" ? 4 : 5;
  let s = pair(0, "LAYOUT") + pair(5, o.handle) + pair(330, o.dictHandle);
  s += pair(100, "AcDbPlotSettings");
  s += pair(1, o.setupName);
  s += pair(4, o.paper);
  s += pair(6, "");
  s += pair(40, 0) + pair(41, 0) + pair(42, 0) + pair(43, 0);
  s += pair(44, w) + pair(45, h);
  s += pair(46, 0) + pair(47, 0);
  s += pair(48, 0) + pair(49, 0);
  s += pair(140, 0) + pair(141, 0) + pair(142, num) + pair(143, den);
  s += pair(70, 0) + pair(72, 1) + pair(73, 0) + pair(74, area74);
  s += pair(7, "");
  s += pair(75, 16) + pair(76, 0) + pair(77, 2) + pair(78, 300);
  s += pair(147, 1) + pair(148, 0) + pair(149, 0);
  s += pair(100, "AcDbLayout");
  s += pair(1, o.name);
  s += pair(70, 1) + pair(71, o.tabOrder);
  s += pair(10, 0) + pair(20, 0) + pair(11, w) + pair(21, h);
  s += pair(12, 0) + pair(22, 0) + pair(32, 0);
  s += pair(14, 1e20) + pair(24, 1e20) + pair(34, 1e20);
  s += pair(15, -1e20) + pair(25, -1e20) + pair(35, -1e20);
  s += pair(146, 0);
  s += pair(13, 0) + pair(23, 0) + pair(33, 0);
  s += pair(16, 1) + pair(26, 0) + pair(36, 0);
  s += pair(17, 0) + pair(27, 1) + pair(37, 0);
  s += pair(76, 1);
  if (o.recordHandle) s += pair(330, o.recordHandle);
  for (const vh of o.viewportHandles ?? []) s += pair(331, vh);
  return s;
}

/**
 * DIMENSION entity (DXF reference): definition points per type, style name,
 * measurement text, and the anonymous block holding the drawn geometry.
 * Group 70 carries the type in bits 0-2 plus bit 5 (32) when the block is
 * referenced only by this dimension. Group 50 (dimension-line rotation) is
 * derived from the definition points: rotated-linear is horizontal (0) or
 * vertical (90) by the extension origins; aligned uses their true angle.
 * Radius/diameter carry no rotation — the reader measures them from the
 * centre + curve point. Group 40 (leader length) is omitted: the model
 * stores no leader length, and inventing one would misplace the fallback
 * text; the anonymous block is authoritative.
 */
function writeDimensionEntity(e: Extract<DxfEntity, { type: "DIMENSION" }>, blockName?: string): string {
  let s = entityHead(e, "DIMENSION");
  s += pair(100, "AcDbDimension");
  if (blockName) s += pair(2, blockName);
  if (e.styleName) s += pair(3, e.styleName);
  s += writePoint([10, 20, 30], e.defPoint);
  if (e.textPoint) s += writePoint([11, 21, 31], e.textPoint);
  if (e.dimType === 0 || e.dimType === 1) {
    if (e.extOrigin1) s += writePoint([13, 23, 33], e.extOrigin1);
    if (e.extOrigin2) s += writePoint([14, 24, 34], e.extOrigin2);
    if (e.extOrigin1 && e.extOrigin2) {
      const dx = e.extOrigin2.x - e.extOrigin1.x, dy = e.extOrigin2.y - e.extOrigin1.y;
      const rot =
        e.dimType === 0
          ? Math.abs(dx) >= Math.abs(dy)
            ? 0
            : 90
          : ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      s += pair(50, rot);
    }
  } else if (e.dimType === 6) {
    // Ordinate: group 13 is the leader end (the dimension's text
    // position); no group 50 — an ordinate has no dimension-line rotation.
    if (e.leaderEnd) s += writePoint([13, 23, 33], e.leaderEnd);
  } else {
    if (e.curvePoint) s += writePoint([15, 25, 35], e.curvePoint);
  }
  if (e.text != null) s += pair(1, e.text);
  s += pair(70, e.dimType | (blockName ? 32 : 0));
  return s;
}

function writeEntity(e: DxfEntity, styleName: (t: Extract<DxfEntity, { type: "TEXT" }>) => string, hatchEntities = true, dimBlockByEntity?: ReadonlyMap<DxfEntity, string>): string {
  let s = "";

  if (e.type === "LINE") {
    s += entityHead(e, "LINE");
    s += writePoint([10, 20, 30], e.start);
    s += writePoint([11, 21, 31], e.end);
  } else if (e.type === "CIRCLE") {
    s += entityHead(e, "CIRCLE");
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
  } else if (e.type === "ARC") {
    s += entityHead(e, "ARC");
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
    s += pair(50, e.startAngle);
    s += pair(51, e.endAngle);
  } else if (hatchEntities && e.type === "LWPOLYLINE" && e.hatch && !e.hatch.wipeout && e.hatch.loops.some((l) => l.length >= 3)) {
    s += writeHatch(e);
  } else if (e.type === "INSERT") {
    s += writeInsert(e);
  } else if (e.type === "LWPOLYLINE" && !legacyPrologue && nativeIfValid(e)) {
    const n = nativeIfValid(e)!;
    s += entityHead(e, n.kind);
    s += n.kind === "SPLINE" ? splineDxfBody(n, pair) : ellipseDxfBody(n, pair);
  } else if (e.type === "LWPOLYLINE") {
    s += entityHead(e, "LWPOLYLINE");
    // A8/A19: the AcDbPolyline subclass marker is REQUIRED by strict DXF
    // readers (ezdxf raises DXFStructureError without it) — the writer's
    // own header states loaders key off subclass markers. LINE/CIRCLE/ARC
    // tolerate a missing marker, LWPOLYLINE does not. The marker is part of
    // the entity body, not the prologue, so the legacy extra-sheet form
    // keeps working (verified by the DWG round-trip suite).
    s += pair(100, "AcDbPolyline");
    s += pair(90, e.points.length);
    s += pair(70, e.closed ? 1 : 0);
    // A7: the constant width (43) and, per vertex, the bulge (42) and the
    // start/end widths (40/41) — without them an arc segment in a
    // polyline came back from save as many straight chords, and a wide
    // polyline came back hairline. Only segments that exist carry them:
    // the last vertex of an open polyline starts no segment.
    if (e.width != null && e.width > 0) s += pair(43, e.width);
    const segCount = e.closed ? e.points.length : Math.max(0, e.points.length - 1);
    e.points.forEach((p, i) => {
      s += pair(10, p.x);
      s += pair(20, p.y);
      if (i < segCount && e.bulges?.[i]) s += pair(42, e.bulges[i]);
      if (i < segCount && e.startWidths?.[i] != null) s += pair(40, e.startWidths[i]);
      if (i < segCount && e.endWidths?.[i] != null) s += pair(41, e.endWidths[i]);
    });
  } else if (e.type === "TEXT") {
    if (e.wrapWidth && e.wrapWidth > 0) {
      // Wrapped text is a real MTEXT entity (AcDbMText), not a plain TEXT:
      // the column width (group 41) and the paragraph text with \P
      // separators (group 1) survive a DXF round-trip, so the wrapping the
      // user placed comes back as wrapping — plain TEXT would lose it.
      let t = entityHead(e, "MTEXT");
      t += pair(100, "AcDbMText");
      t += writePoint([10, 20, 30], e.position);
      t += pair(40, e.height);
      t += pair(41, e.wrapWidth);
      if (e.lineSpacing != null) t += pair(44, e.lineSpacing);
      if (e.rotation != null) t += pair(50, e.rotation);
      // Attachment point: rows top/middle/bottom, columns left/center/right
      // (the reader maps ap = (row - 1) * 3 + col back to align/valign).
      const row = e.valign === "top" ? 0 : e.valign === "middle" ? 1 : 2;
      const col = e.align === "left" ? 1 : e.align === "center" ? 2 : 3;
      t += pair(71, row * 3 + col);
      t += pair(1, String(e.value ?? "").split("\n").join("\\P"));
      t += pair(7, styleName(e));
      s += t;
    } else {
    // A DXF TEXT record cannot hold a line break — a multi-line value (MTEXT
    // \P paragraphs read back as one TEXT) would corrupt the code/value stream
    // on re-import. Native CAD does the same: emit one TEXT per visual line,
    // offset along the text's own baseline direction exactly as drawn.
    const emitText = (value: string, pos: DxfPoint, withValign: boolean): string => {
      let t = entityHead(e, "TEXT");
      t += writePoint([10, 20, 30], pos);
      t += pair(40, e.height);
      t += pair(1, value);
      if (e.rotation != null) t += pair(50, e.rotation);
      if (e.widthFactor && Math.abs(e.widthFactor - 1) > 1e-6) t += pair(41, e.widthFactor);
      if (e.oblique && Math.abs(e.oblique) > 1e-6) t += pair(51, e.oblique);
      t += pair(7, styleName(e));
      const tg = (e.backwards ? 2 : 0) | (e.upsideDown ? 4 : 0);
      if (tg) t += pair(71, tg);
      // Horizontal alignment always; the vertical anchor only on the single-line
      // record — per-line records have it baked into their shifted position.
      const h = e.align === "center" ? 1 : e.align === "right" ? 2 : 0;
      const v = withValign ? (e.valign === "bottom" ? 1 : e.valign === "middle" ? 2 : e.valign === "top" ? 3 : 0) : 0;
      if (h !== 0 || v !== 0) {
        t += pair(72, h);
        t += writePoint([11, 21, 31], pos);
        t += pair(73, v);
      }
      return t;
    };
    const lines = String(e.value ?? "").split("\n");
    if (lines.length <= 1) {
      s += emitText(e.value, e.position, true);
    } else {
      // Mirror viewer-math textLineBaselines: baseline i sits (top - h - i*pitch)
      // from the anchor, in the text's own frame (rotation applies to the offset).
      const pitch = e.height * Math.max(e.lineSpacing ?? 1, 0.1) * TEXT_LINE_PITCH;
      const H = e.height + (lines.length - 1) * pitch;
      const top = e.valign === "top" ? 0 : e.valign === "middle" ? H / 2 : e.valign === "bottom" ? H : e.height;
      const rot = ((e.rotation ?? 0) * Math.PI) / 180;
      const ux = -Math.sin(rot), uy = Math.cos(rot);
      lines.forEach((line, li) => {
        const bl = top - e.height - li * pitch;
        s += emitText(line, {
          x: e.position.x + ux * bl,
          y: e.position.y + uy * bl,
          z: e.position.z,
        }, false);
      });
    }
    } // else: plain TEXT (no wrap width)
  } else if (e.type === "POINT") {
    s += entityHead(e, "POINT");
    s += writePoint([10, 20, 30], e.position);
  } else if (e.type === "RAY" || e.type === "XLINE") {
    // Construction lines: one point on the line (10/20/30) + direction (11/21/31).
    s += entityHead(e, e.type);
    s += writePoint([10, 20, 30], e.start);
    s += writePoint([11, 21, 31], e.direction);
  } else if (e.type === "DIMENSION") {
    // The anonymous block name is assigned by writeDxf's pre-pass (the
    // block holds this dimension's drawn geometry); without one the entity
    // still carries its definition points for the native fallback.
    s += writeDimensionEntity(e, dimBlockByEntity?.get(e));
  } else if (e.type === "TABLE") {
    s += writeTableEntity(e);
  }
  return s;
}

/**
 * Real ACAD_TABLE (Autodesk DXF reference, AcDbTable): insertion point (10),
 * horizontal direction (11), row/column counts (91/92), row heights (141,
 * one per row), column widths (142, one per column), then one cell record
 * per cell in row-major order (171 text type, 172-176 flags, 91 override,
 * 178 virtual edge, 145 rotation, 1 text — empty cells still emit group 1
 * so the reader can align texts with cells), then the table-level
 * overrides (281 header suppressed, 140 text height). No TABLESTYLE handle
 * (342) and no anonymous *T block (2/343) are written: this file carries
 * no TABLESTYLE table and no *T block definition, so those pointers would
 * dangle — native CAD and ezdxf read the geometry and text from the
 * groups above, and merged cells are not represented.
 */
function writeTableEntity(e: Extract<DxfEntity, { type: "TABLE" }>): string {
  const rows = e.rowHeights.length, cols = e.colWidths.length;
  const rot = ((e.rotation ?? 0) * Math.PI) / 180;
  let s = entityHead(e, "ACAD_TABLE");
  if (!legacyPrologue) s += pair(100, "AcDbBlockReference");
  s += writePoint([10, 20, 30], e.position);
  if (!legacyPrologue) s += pair(100, "AcDbTable");
  s += pair(280, 0); // table data version: 0 = 2010
  s += writePoint([11, 21, 31], { x: Math.cos(rot), y: Math.sin(rot), z: 0 });
  s += pair(90, 0);
  s += pair(91, rows);
  s += pair(92, cols);
  s += pair(93, 0) + pair(94, 0) + pair(95, 0) + pair(96, 0);
  for (const h of e.rowHeights) s += pair(141, h);
  for (const w of e.colWidths) s += pair(142, w);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      s += pair(171, 1) + pair(172, 0) + pair(173, 0) + pair(174, 0) + pair(175, 1) + pair(176, 1);
      s += pair(91, 0) + pair(178, 0) + pair(145, 0);
      s += pair(1, e.cells[r]?.[c] ?? "");
    }
  }
  s += pair(281, e.headerRow ? 0 : 1);
  s += pair(140, tableTextHeight(e));
  return s;
}

function computeExtents(entities: DxfEntity[]): { min: DxfPoint; max: DxfPoint } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: DxfPoint) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const e of entities) {
    if (e.type === "LINE") {
      add(e.start);
      add(e.end);
    } else if (e.type === "CIRCLE" || e.type === "ARC") {
      add({ x: e.center.x - e.radius, y: e.center.y - e.radius });
      add({ x: e.center.x + e.radius, y: e.center.y + e.radius });
    } else if (e.type === "LWPOLYLINE") {
      // Bulged arcs reach past their chord, and a wide polyline reaches
      // past its centreline by half its width — the header extents must
      // cover both, or ZOOM E in the next CAD to open the file clips them.
      const mw = Math.max(0, e.width ?? 0, ...(e.startWidths ?? []), ...(e.endWidths ?? []));
      const b = polylineBBox(e.points, e.bulges, !!e.closed, mw / 2);
      add({ x: b.minX, y: b.minY });
      add({ x: b.maxX, y: b.maxY });
    } else if (e.type === "TEXT" || e.type === "POINT") {
      add(e.position);
    } else if (e.type === "DIMENSION") {
      add(e.defPoint);
      if (e.extOrigin1) add(e.extOrigin1);
      if (e.extOrigin2) add(e.extOrigin2);
      if (e.curvePoint) add(e.curvePoint);
      if (e.leaderEnd) add(e.leaderEnd);
      if (e.textPoint) add(e.textPoint);
    } else if (e.type === "TABLE") {
      for (const p of tableCorners(e)) add(p);
    } else if (e.type === "RAY" || e.type === "XLINE") {
      // Native behaviour: infinite lines do not define the drawing extents.
    }
  }
  if (!Number.isFinite(minX)) {
    return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** DIMSTYLE table (DXF reference groups): the styles a DIMENSION entity's group 3 can name. */
function dimstyleTable(styles: Record<string, DxfDimStyle>): string {
  const names = Object.keys(styles);
  let s = "";
  s += pair(0, "TABLE");
  s += pair(2, "DIMSTYLE");
  s += pair(5, nextHandle());
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, names.length);
  for (const name of names) {
    const st = styles[name];
    s += pair(0, "DIMSTYLE");
    s += pair(5, nextHandle());
    s += pair(100, "AcDbSymbolTableRecord");
    s += pair(100, "AcDbDimStyleTableRecord");
    s += pair(2, name);
    s += pair(70, 0);
    if (st.scale != null) s += pair(40, st.scale);
    if (st.arrowSize != null) s += pair(41, st.arrowSize);
    if (st.extOffset != null) s += pair(42, st.extOffset);
    if (st.extExtend != null) s += pair(44, st.extExtend);
    if (st.textHeight != null) s += pair(140, st.textHeight);
    if (st.textGap != null) s += pair(147, st.textGap);
    if (st.decimals != null) s += pair(271, st.decimals);
    if (st.linearFactor != null) s += pair(143, st.linearFactor);
    if (st.postFix != null) s += pair(3, st.postFix);
  }
  s += pair(0, "ENDTAB");
  return s;
}

/** Serialize a document to DXF R2010 ASCII. */
/** DWG / DXF file versions the writer can target. All were round-tripped through the real DWG engine. */
export type DwgVersionCode = "AC1015" | "AC1018" | "AC1021" | "AC1024" | "AC1027" | "AC1032";

export const DWG_VERSIONS: ReadonlyArray<{ code: DwgVersionCode; label: string; note?: string }> = [
  { code: "AC1015", label: "DWG 2000 / 2000i / 2002", note: "True colours are converted to the nearest DWG colour index." },
  { code: "AC1018", label: "DWG 2004 / 2005 / 2006" },
  { code: "AC1021", label: "DWG 2007 / 2008 / 2009" },
  { code: "AC1024", label: "DWG 2010 / 2011 / 2012 (default)" },
  { code: "AC1027", label: "DWG 2013 to 2017" },
  { code: "AC1032", label: "DWG 2018 and later" },
];
export const DEFAULT_DWG_VERSION: DwgVersionCode = "AC1024";

export function dwgVersionLabel(code: string): string {
  return DWG_VERSIONS.find((v) => v.code === code)?.label ?? code;
}

export interface WriteDxfOptions {
  /**
   * How hatch fills are written. "hatch" (default) writes real HATCH entities, which
   * the DWG converter keeps as fills. "outline" keeps them as closed polylines.
   */
  hatches?: "hatch" | "outline";
  /** File version written to $ACADVER (and so the DWG version after conversion). Default DWG 2010. */
  version?: DwgVersionCode;
  // Every layout is written with a real LAYOUT object (A8/A19): there is no
  // longer an allLayouts option — plain DXF and the DWG conversion path write
  // the same complete structure.
}

interface CollectedDimension {
  /** The DIMENSION entity as written, with its text resolved from the drawn geometry. */
  entity: Extract<DxfEntity, { type: "DIMENSION" }>;
  /** The DIMENSION entity object as it appears in doc.entities. */
  original: Extract<DxfEntity, { type: "DIMENSION" }>;
  dimId: string;
  /** Anonymous block holding the dimension's drawn geometry (undefined when it has none). */
  blockName?: string;
  /** Tagged entities (meta.dimId) that move into the anonymous block. */
  geometry: DxfEntity[];
}

/**
 * Validates the DIMENSION entities in the document and resolves each one's
 * drawn geometry + measurement text. A DIMENSION without its required
 * definition points (extension origins for linear/aligned, curve point for
 * radius/diameter) is skipped — its geometry stays plain, today's behaviour,
 * rather than writing a DIMENSION no reader can measure. A second DIMENSION
 * reusing an already-consumed dimId keeps its definition points but gets no
 * block, so the geometry is never written twice. Angular, arc-length and
 * centre-mark dimensions have no DIMENSION entity in this model and are
 * never collected here.
 */
function collectDimensions(doc: DxfDocument): CollectedDimension[] {
  const takenNames = new Set(Object.values(doc.blocks ?? {}).map((b) => b.name.toUpperCase()));
  const usedBlockNames = new Set<string>();
  const usedDimIds = new Set<string>();
  const out: CollectedDimension[] = [];
  let n = 0;
  for (const e of doc.entities) {
    if (e.type !== "DIMENSION") continue;
    const supported = e.dimType === 0 || e.dimType === 1 || e.dimType === 3 || e.dimType === 4 || e.dimType === 6;
    const valid =
      supported &&
      Number.isFinite(e.defPoint?.x) &&
      Number.isFinite(e.defPoint?.y) &&
      ((e.dimType === 0 || e.dimType === 1) ? !!e.extOrigin1 && !!e.extOrigin2 : e.dimType === 6 ? !!e.leaderEnd : !!e.curvePoint);
    if (!valid) continue;
    const dimId = e.dimId ?? "";
    const freshId = dimId && !usedDimIds.has(dimId);
    if (freshId) usedDimIds.add(dimId);
    const geometry = freshId ? doc.entities.filter((g) => g.meta?.dimId === dimId) : [];
    // Measurement text comes from the drawn TEXT entity — the geometry is
    // the source of truth for what the dimension shows; the entity's own
    // text field is only a fallback for a DIMENSION without geometry.
    const textEnt = geometry.find((g): g is Extract<DxfEntity, { type: "TEXT" }> => g.type === "TEXT");
    const entity = {
      ...e,
      ...(textEnt ? { text: textEnt.value, textPoint: { ...textEnt.position } } : {}),
    };
    let blockName: string | undefined;
    if (geometry.length) {
      do {
        blockName = `*D${++n}`;
      } while (takenNames.has(blockName) || usedBlockNames.has(blockName));
      usedBlockNames.add(blockName);
    }
    out.push({ entity, original: e, dimId, blockName, geometry });
  }
  return out;
}

export function writeDxf(doc: DxfDocument, opts: WriteDxfOptions = {}): string {
  const layers =
    doc.layers.length > 0
      ? doc.layers
      : [{ name: "0", color: 7 }];
  const userBlocks = Object.values(doc.blocks ?? {}).filter((b) => !/^\*(model_space|paper_space)/i.test(b.name));
  // A5: a DIMENSION's drawn geometry lives in its anonymous *D<n> block, not
  // as plain entities — collect the dimensions before anything else reads
  // the entity list, and resolve each DIMENSION's text from its geometry.
  const dims = collectDimensions(doc);
  const dimGeometry = new Set(dims.flatMap((d) => d.geometry));
  // Anonymous block per DIMENSION *entity* (not per dimId): two DIMENSIONs
  // sharing one dimId must not both claim the same block.
  const dimBlockByEntity = new Map(dims.filter((d) => d.blockName).map((d) => [d.entity as DxfEntity, d.blockName!]));
  const dimBlocks: DxfBlockDef[] = dims
    .filter((d) => d.blockName)
    .map((d) => ({ name: d.blockName!, base: { x: 0, y: 0 }, entities: d.geometry, attdefs: [] }));
  const resolvedDimByOriginal = new Map(dims.map((d) => [d.original as DxfEntity, d.entity]));
  // Styles and linetypes used inside block bodies must be declared too.
  const allEntities = userBlocks.length ? [...doc.entities, ...userBlocks.flatMap((b) => b.entities)] : doc.entities;
  const extents = doc.extents ?? computeExtents(doc.entities);
  handleSeq = 0x100;
  // A8/A19: every layout gets a real LAYOUT object in the OBJECTS section.
  // Their handles (and the extra sheets' BLOCK_RECORD handles, which the
  // LAYOUT objects point back at via group 330) are pre-assigned here so
  // both sides agree before either section is written. The first layout has
  // no *Paper_Space block of its own — its entities live in ENTITIES (67=1),
  // as before — so its LAYOUT object carries no 330 owner.
  const layouts = doc.layouts ?? [];
  const modelLayoutHandle = nextHandle();
  const layoutHandles = layouts.map(() => nextHandle());
  const extraRecordHandles = layouts.slice(1).map(() => nextHandle());
  // The named-objects dictionary and the ACAD_LAYOUT dictionary the LAYOUT
  // objects belong to (their first group 330). Only ACAD_LAYOUT is written:
  // this file claims no other named dictionaries.
  const rootDictHandle = nextHandle();
  const layoutDictHandle = nextHandle();
  // Phase 4c: recorded constraints ride along as XRECORDs in a named dictionary (absent when there are none).
  const stored = (doc.constraints ?? []).filter((c) => Array.isArray(c.refs) && c.refs.length > 0);
  const consDictHandle = stored.length ? nextHandle() : "";
  const consHandles = stored.map(() => nextHandle());
  const paperRecords = layouts.slice(1).map((_, k) => ({
    name: `*Paper_Space${k + 1}`,
    layoutHandle: layoutHandles[k + 1],
    recordHandle: extraRecordHandles[k],
  }));
  // Handles of the first layout's viewports (conformant form), for the
  // LAYOUT object's group 331. Extra sheets' viewports are legacy (no
  // handle) and are left out — 331 is optional.
  const firstLayoutViewportHandles: string[] = [];
  // Linetype definitions: those in the file plus any library linetype the drawing uses.
  const lt = { linetypes: { ...(doc.linetypes ?? {}) }, units: doc.units };
  ensureLinetypes(lt, linetypesInUse({ layers, entities: allEntities }));
  const defs = lt.linetypes;
  const styles = styleTable(allEntities);

  let s = "";
  // HEADER
  s += pair(0, "SECTION");
  s += pair(2, "HEADER");
  s += pair(9, "$ACADVER");
  s += pair(1, opts.version ?? DEFAULT_DWG_VERSION);
  s += pair(9, "$INSUNITS");
  const unitsMap: Record<string, number> = {
    unitless: 0,
    in: 1,
    ft: 2,
    mm: 4,
    cm: 5,
    m: 6,
  };
  s += pair(70, unitsMap[doc.units ?? "mm"] ?? 4);
  s += pair(9, "$EXTMIN");
  s += writePoint([10, 20, 30], extents.min);
  s += pair(9, "$EXTMAX");
  s += writePoint([10, 20, 30], extents.max);
  if (doc.ltscale && doc.ltscale > 0) {
    s += pair(9, "$LTSCALE");
    s += pair(40, doc.ltscale);
  }
  s += pair(0, "ENDSEC");

  // TABLES
  s += pair(0, "SECTION");
  s += pair(2, "TABLES");
  s += linetypeTable(defs);
  const layerTableOut = layerTable(layers);
  s += layerTableOut.text;
  s += styles.table;
  // The style names a DIMENSION's group 3 can reference; only written when
  // the file actually carries dimensions, so dimension-free saves are
  // byte-identical to before.
  if (dims.length && doc.dimStyleTable && Object.keys(doc.dimStyleTable).length) s += dimstyleTable(doc.dimStyleTable);
  if (userBlocks.length || dimBlocks.length || paperRecords.length) s += blockRecordTable([...userBlocks, ...dimBlocks], paperRecords);
  s += pair(0, "ENDSEC");

  // BLOCKS: native block definitions, then every extra sheet (all layouts are
  // written now, A8/A19 — plain DXF and the DWG conversion path share one
  // complete structure; the first sheet still lives in ENTITIES, as before).
  const extraSheets = layouts.slice(1);
  const xrefDecls = (doc.xrefs ?? []).filter((x) => !userBlocks.some((b) => b.name === x.name));
  if (extraSheets.length || userBlocks.length || xrefDecls.length || dimBlocks.length) {
    s += pair(0, "SECTION");
    s += pair(2, "BLOCKS");
    // External references: an empty block flagged 4 (xref) / 12 (overlay) carrying the stored path (group 1).
    for (const x of xrefDecls) {
      s += pair(0, "BLOCK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(8, "0");
      s += pair(100, "AcDbBlockBegin") + pair(2, x.name) + pair(70, x.kind === "overlay" ? 12 : 4);
      s += pair(10, 0) + pair(20, 0) + pair(30, 0) + pair(3, x.name) + pair(1, x.path);
      s += pair(0, "ENDBLK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(8, "0") + pair(100, "AcDbBlockEnd");
    }
    for (const b of userBlocks) s += writeBlockDef(b, styles.nameFor, (opts.hatches ?? "hatch") === "hatch");
    legacyPrologue = true; // DWG-converter block contents use the legacy entity form (see above)
    extraSheets.forEach((sheet, i) => {
      const name = `*Paper_Space${i + 1}`;
      s += pair(0, "BLOCK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(67, 1) + pair(8, "0");
      s += pair(100, "AcDbBlockBegin") + pair(2, name) + pair(70, 0);
      s += pair(10, 0) + pair(20, 0) + pair(30, 0) + pair(3, name) + pair(1, "");
      for (const e of sheet.entities) s += inPaperSpace(writeEntity(e, styles.nameFor, (opts.hatches ?? "hatch") === "hatch"));
      sheet.viewports.forEach((vp, k) => {
        // A8: the clip boundary is written before the viewport that points at it.
        const clip = vp.clip ? writeClipBoundary(vp.clip) : null;
        if (clip) s += clip.text;
        s += writeViewport(vp, k + 2, clip?.handle, layerTableOut.handles).text;
      });
      s += pair(0, "ENDBLK") + pair(5, nextHandle()) + pair(100, "AcDbEntity") + pair(67, 1) + pair(8, "0") + pair(100, "AcDbBlockEnd");
    });
    legacyPrologue = false;
    // Anonymous dimension blocks: the drawn geometry of each DIMENSION.
    // Written AFTER the extra sheets, with the conformant prologue like user
    // blocks. A8/A19: a conformant *D block BEFORE the legacy paper blocks
    // makes the converter drop the extra sheets' viewports (proven by the
    // 4-case probe in the A19 suite notes) — the paper blocks come first so
    // the converter maps them while still in legacy-block mode.
    for (const b of dimBlocks) s += writeBlockDef(b, styles.nameFor, (opts.hatches ?? "hatch") === "hatch");
    s += pair(0, "ENDSEC");
  }

  // ENTITIES
  s += pair(0, "SECTION");
  s += pair(2, "ENTITIES");
  const hatchFlag = (opts.hatches ?? "hatch") === "hatch";
  for (const e of doc.entities) {
    // Drawn dimension geometry lives in its DIMENSION's anonymous block.
    if (dimGeometry.has(e)) continue;
    // A DIMENSION collectDimensions rejected (unmeasurable definition
    // points) is not written at all — its geometry stays plain.
    if (e.type === "DIMENSION" && !resolvedDimByOriginal.has(e)) continue;
    const toWrite = e.type === "DIMENSION" ? (resolvedDimByOriginal.get(e) ?? e) : e;
    s += writeEntity(toWrite, styles.nameFor, hatchFlag, dimBlockByEntity);
  }
  // The first paper-space layout is the drawing's active sheet: its entities and
  // viewports are written with group 67 = 1, which is how DXF stores paper space.
  const sheet = doc.layouts?.[0];
  if (sheet) {
    for (const e of sheet.entities) s += inPaperSpace(writeEntity(e, styles.nameFor, (opts.hatches ?? "hatch") === "hatch"));
    sheet.viewports.forEach((vp, i) => {
      // A8: the clip boundary is written before the viewport that points at it.
      const clip = vp.clip ? writeClipBoundary(vp.clip) : null;
      if (clip) s += clip.text;
      const w = writeViewport(vp, i + 2, clip?.handle, layerTableOut.handles);
      s += w.text;
      if (w.handle) firstLayoutViewportHandles.push(w.handle);
    });
  }
  s += pair(0, "ENDSEC");

  // OBJECTS: one real LAYOUT object per layout (A8/A19) — Model first, then
  // the paper layouts in tab order — carrying each layout's plot settings
  // (AcDbPlotSettings: setup name, paper, scale, plot area) and its name
  // (AcDbLayout). A reader that understands LAYOUT objects recovers the
  // sheet names and plot settings; the DWG converter ignores them and keeps
  // its block-based sheets (see the A19 follow-up in the test suite).
  s += pair(0, "SECTION");
  s += pair(2, "OBJECTS");
  // Named-objects dictionary (root) + the ACAD_LAYOUT dictionary listing
  // every layout by name -> handle, exactly as ezdxf writes them.
  s += pair(0, "DICTIONARY") + pair(5, rootDictHandle) + pair(330, "0") + pair(100, "AcDbDictionary") + pair(281, 1);
  s += pair(3, "ACAD_LAYOUT") + pair(350, layoutDictHandle);
  if (stored.length) s += pair(3, "OPENBIMSTUDIO_CONSTRAINTS") + pair(350, consDictHandle);
  s += pair(0, "DICTIONARY") + pair(5, layoutDictHandle) + pair(330, rootDictHandle) + pair(100, "AcDbDictionary") + pair(281, 1);
  s += pair(3, "Model") + pair(350, modelLayoutHandle);
  layouts.forEach((l, i) => { s += pair(3, l.name) + pair(350, layoutHandles[i]); });
  s += writeLayoutObject({
    handle: modelLayoutHandle,
    name: "Model",
    tabOrder: 0,
    paper: "A3",
    orient: "landscape",
    setupName: "",
    scale: "fit",
    area: "layout",
    dictHandle: layoutDictHandle,
  });
  layouts.forEach((l, i) => {
    const ps = layoutPlotSettings(doc, l);
    s += writeLayoutObject({
      handle: layoutHandles[i],
      name: l.name,
      tabOrder: i + 1,
      paper: ps.paper,
      orient: ps.orient,
      setupName: ps.setupName,
      scale: ps.scale,
      area: ps.area,
      dictHandle: layoutDictHandle,
      recordHandle: i === 0 ? undefined : extraRecordHandles[i - 1],
      viewportHandles: i === 0 ? firstLayoutViewportHandles : undefined,
    });
  });
  if (stored.length) {
    s += pair(0, "DICTIONARY") + pair(5, consDictHandle) + pair(330, rootDictHandle) + pair(100, "AcDbDictionary") + pair(281, 1);
    stored.forEach((_, i) => { s += pair(3, `C${i + 1}`) + pair(350, consHandles[i]); });
    stored.forEach((c, i) => {
      s += pair(0, "XRECORD") + pair(5, consHandles[i]) + pair(330, consDictHandle) + pair(100, "AcDbXrecord") + pair(280, 1);
      s += pair(1, "OBS_CONSTRAINT") + pair(1, c.kind);
      if (c.value !== undefined && Number.isFinite(c.value)) s += pair(40, c.value);
      c.refs.forEach((r, k) => { s += pair(90, r) + pair(1, c.fp[k] ?? ""); });
    });
  }
  s += pair(0, "ENDSEC");

  s += pair(0, "EOF");
  return s;
}

/** Download a DXF string as a file in the browser. */
export function downloadDxf(doc: DxfDocument, filename = "drawing.dxf"): void {
  const text = writeDxf(doc);
  const blob = new Blob([text], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".dxf") ? filename : `${filename}.dxf`;
  a.click();
  URL.revokeObjectURL(url);
}
