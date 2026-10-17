/**
 * DXF ASCII writer (AutoCAD R2010 / AC1024 compatible subset).
 * Pure TypeScript - no native deps.
 */

import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";

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

function layerTable(layers: DxfLayer[]): string {
  let s = "";
  s += pair(0, "TABLE");
  s += pair(2, "LAYER");
  s += pair(5, "2");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, layers.length);
  for (const layer of layers) {
    s += pair(0, "LAYER");
    s += pair(5, Math.floor(Math.random() * 0xfffff).toString(16));
    s += pair(100, "AcDbSymbolTableRecord");
    s += pair(100, "AcDbLayerTableRecord");
    s += pair(2, layer.name);
    s += pair(70, layer.frozen ? 1 : 0);
    s += pair(62, layer.color || 7);
    s += pair(6, layer.lineType || "Continuous");
  }
  s += pair(0, "ENDTAB");
  return s;
}

function writeEntity(e: DxfEntity): string {
  let s = "";
  const layer = e.layer || "0";
  const color = e.color ?? 256; // ByLayer

  if (e.type === "LINE") {
    s += pair(0, "LINE");
    s += pair(8, layer);
    s += pair(62, color);
    s += writePoint([10, 20, 30], e.start);
    s += writePoint([11, 21, 31], e.end);
  } else if (e.type === "CIRCLE") {
    s += pair(0, "CIRCLE");
    s += pair(8, layer);
    s += pair(62, color);
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
  } else if (e.type === "ARC") {
    s += pair(0, "ARC");
    s += pair(8, layer);
    s += pair(62, color);
    s += writePoint([10, 20, 30], e.center);
    s += pair(40, e.radius);
    s += pair(50, e.startAngle);
    s += pair(51, e.endAngle);
  } else if (e.type === "LWPOLYLINE") {
    s += pair(0, "LWPOLYLINE");
    s += pair(8, layer);
    s += pair(62, color);
    s += pair(90, e.points.length);
    s += pair(70, e.closed ? 1 : 0);
    for (const p of e.points) {
      s += pair(10, p.x);
      s += pair(20, p.y);
    }
  } else if (e.type === "TEXT") {
    s += pair(0, "TEXT");
    s += pair(8, layer);
    s += pair(62, color);
    s += writePoint([10, 20, 30], e.position);
    s += pair(40, e.height);
    s += pair(1, e.value);
    if (e.rotation != null) s += pair(50, e.rotation);
  } else if (e.type === "POINT") {
    s += pair(0, "POINT");
    s += pair(8, layer);
    s += pair(62, color);
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
    m: 6,
  };
  s += pair(70, unitsMap[doc.units ?? "mm"] ?? 4);
  s += pair(9, "$EXTMIN");
  s += writePoint([10, 20, 30], extents.min);
  s += pair(9, "$EXTMAX");
  s += writePoint([10, 20, 30], extents.max);
  s += pair(0, "ENDSEC");

  // TABLES
  s += pair(0, "SECTION");
  s += pair(2, "TABLES");
  // LTYPE
  s += pair(0, "TABLE");
  s += pair(2, "LTYPE");
  s += pair(5, "1");
  s += pair(100, "AcDbSymbolTable");
  s += pair(70, 1);
  s += pair(0, "LTYPE");
  s += pair(5, "10");
  s += pair(100, "AcDbSymbolTableRecord");
  s += pair(100, "AcDbLinetypeTableRecord");
  s += pair(2, "Continuous");
  s += pair(70, 0);
  s += pair(3, "Solid line");
  s += pair(72, 65);
  s += pair(73, 0);
  s += pair(40, 0);
  s += pair(0, "ENDTAB");
  s += layerTable(layers);
  s += pair(0, "ENDSEC");

  // ENTITIES
  s += pair(0, "SECTION");
  s += pair(2, "ENTITIES");
  for (const e of doc.entities) {
    s += writeEntity(e);
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
