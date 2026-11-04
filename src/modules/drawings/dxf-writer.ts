/**
 * DXF ASCII writer (AutoCAD R2010 / AC1024 compatible subset).
 * Pure TypeScript - no native deps.
 */

import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";
import { ensureLinetypes, fontDxfFile, isTrueTypeFont, lineweightToDxf, linetypesInUse } from "./cad-styles";

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

function layerTable(layers: DxfLayer[]): string {
  let s = "";
  s += pair(0, "TABLE");
  s += pair(2, "LAYER");
  s += pair(5, "2");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, layers.length);
  for (const layer of layers) {
    s += pair(0, "LAYER");
    s += pair(5, nextHandle());
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
  return s;
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
  if (e.lineweight != null) s += pair(370, lineweightToDxf(e.lineweight));
  if (e.rgb != null) s += pair(420, e.rgb & 0xffffff);
  if (e.ltScale != null && Math.abs(e.ltScale - 1) > 1e-9) s += pair(48, e.ltScale);
  if (e.transparency) s += pair(440, e.transparency << 24);
  return s;
}

function writeEntity(e: DxfEntity, styleName: (t: Extract<DxfEntity, { type: "TEXT" }>) => string): string {
  let s = "";

  if (e.type === "LINE") {
    s += pair(0, "LINE");
    s += common(e);
    s += writePoint([10, 20, 30], e.start);
    s += writePoint([11, 21, 31], e.end);
  } else if (e.type === "CIRCLE") {
    s += pair(0, "CIRCLE");
    s += common(e);
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
  } else if (e.type === "ARC") {
    s += pair(0, "ARC");
    s += common(e);
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
    s += pair(50, e.startAngle);
    s += pair(51, e.endAngle);
  } else if (e.type === "LWPOLYLINE") {
    s += pair(0, "LWPOLYLINE");
    s += common(e);
    s += pair(90, e.points.length);
    s += pair(70, e.closed ? 1 : 0);
    for (const p of e.points) {
      s += pair(10, p.x);
      s += pair(20, p.y);
    }
  } else if (e.type === "TEXT") {
    s += pair(0, "TEXT");
    s += common(e);
    s += writePoint([10, 20, 30], e.position);
    s += pair(40, e.height);
    s += pair(1, e.value);
    if (e.rotation != null) s += pair(50, e.rotation);
    if (e.widthFactor && Math.abs(e.widthFactor - 1) > 1e-6) s += pair(41, e.widthFactor);
    if (e.oblique && Math.abs(e.oblique) > 1e-6) s += pair(51, e.oblique);
    s += pair(7, styleName(e));
    const tg = (e.backwards ? 2 : 0) | (e.upsideDown ? 4 : 0);
    if (tg) s += pair(71, tg);
    const h = e.align === "center" ? 1 : e.align === "right" ? 2 : 0;
    const v = e.valign === "bottom" ? 1 : e.valign === "middle" ? 2 : e.valign === "top" ? 3 : 0;
    if (h !== 0 || v !== 0) {
      s += pair(72, h);
      s += writePoint([11, 21, 31], e.position);
      s += pair(73, v);
    }
  } else if (e.type === "POINT") {
    s += pair(0, "POINT");
    s += common(e);
    s += writePoint([10, 20, 30], e.position);
  }
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
      e.points.forEach(add);
    } else if (e.type === "TEXT" || e.type === "POINT") {
      add(e.position);
    }
  }
  if (!Number.isFinite(minX)) {
    return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Serialize a document to DXF R2010 ASCII. */
export function writeDxf(doc: DxfDocument): string {
  const layers =
    doc.layers.length > 0
      ? doc.layers
      : [{ name: "0", color: 7 }];
  const extents = doc.extents ?? computeExtents(doc.entities);
  handleSeq = 0x100;
  // Linetype definitions: those in the file plus any library linetype the drawing uses.
  const lt = { linetypes: { ...(doc.linetypes ?? {}) }, units: doc.units };
  ensureLinetypes(lt, linetypesInUse({ layers, entities: doc.entities }));
  const defs = lt.linetypes;
  const styles = styleTable(doc.entities);

  let s = "";
  // HEADER
  s += pair(0, "SECTION");
  s += pair(2, "HEADER");
  s += pair(9, "$ACADVER");
  s += pair(1, "AC1024");
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
  s += layerTable(layers);
  s += styles.table;
  s += pair(0, "ENDSEC");

  // ENTITIES
  s += pair(0, "SECTION");
  s += pair(2, "ENTITIES");
  for (const e of doc.entities) {
    s += writeEntity(e, styles.nameFor);
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
