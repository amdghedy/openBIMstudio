/**
 * Drawings Engine - DXF/DWG import-export + bridge to CAD engine & THREE.
 *
 * DXF: pure TypeScript parse + write (always available).
 * DWG: optional via dynamic import of `@mlightcad/libredwg-web` if installed;
 *      otherwise offers "convert externally / export DXF" path and accepts
 *      DXF that was converted from DWG.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";
import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";
import { parseDxf, parseDxfFile } from "./dxf-reader";
import { writeDxf, downloadDxf } from "./dxf-writer";
import { cadEngine, type CadEntity, type CadPt } from "../cad/cad-engine";

type Any = Record<string, any>;

export interface DrawingDocument {
  id: string;
  name: string;
  format: "dxf" | "dwg" | "internal";
  doc: DxfDocument;
  loadedAt: number;
}

const drawings = new Map<string, DrawingDocument>();
let activeId: string | null = null;
let threeGroup: THREE.Group | null = null;

function uid(): string {
  return `dwg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function toast(kind: string, message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message, timeout: 2500 } }),
    );
  } catch {
    console.log(`[drawings] ${kind}: ${message}`);
  }
}

/** ACI index - hex (subset). */
export function aciToHex(aci: number): string {
  const table: Record<number, string> = {
    1: "#ff0000",
    2: "#ffff00",
    3: "#00ff00",
    4: "#00ffff",
    5: "#0000ff",
    6: "#ff00ff",
    7: "#ffffff",
    8: "#808080",
    9: "#c0c0c0",
  };
  if (table[aci]) return table[aci];
  // AutoCAD ACI approximate
  const idx = ((aci % 255) + 255) % 255;
  const h = (idx * 37) % 360;
  return `hsl(${h} 70% 55%)`;
}

/* -- CAD - DXF conversion -------------------------------------------------- */

export function cadToDxfDocument(): DxfDocument {
  const layers = cadEngine.listLayers().map((l, i) => ({
    name: l.name,
    color: 7 - (i % 6),
  }));
  if (!layers.length) layers.push({ name: "0", color: 7 });

  const entities: DxfEntity[] = [];
  for (const e of cadEngine.getAllEntities()) {
    const layer = cadEngine.listLayers().find((l) => l.id === e.layer)?.name ?? "0";
    if (e.kind === "line" && e.b) {
      entities.push({
        type: "LINE",
        layer,
        start: { x: e.a.x, y: -e.a.y },
        end: { x: e.b.x, y: -e.b.y },
      });
    } else if (e.kind === "rect" && e.b) {
      const x0 = e.a.x, y0 = -e.a.y, x1 = e.b.x, y1 = -e.b.y;
      entities.push({
        type: "LWPOLYLINE",
        layer,
        closed: true,
        points: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      });
    } else if (e.kind === "circle" && e.r != null) {
      entities.push({
        type: "CIRCLE",
        layer,
        center: { x: e.a.x, y: -e.a.y },
        radius: e.r,
      });
    } else if (e.kind === "arc" && e.r != null && e.startAngle != null && e.endAngle != null) {
      // SVG/screen Y is flipped; angles need care - export degrees
      entities.push({
        type: "ARC",
        layer,
        center: { x: e.a.x, y: -e.a.y },
        radius: e.r,
        startAngle: (-e.endAngle * 180) / Math.PI,
        endAngle: (-e.startAngle * 180) / Math.PI,
      });
    } else if (e.kind === "polyline" && e.points) {
      entities.push({
        type: "LWPOLYLINE",
        layer,
        points: e.points.map((p) => ({ x: p.x, y: -p.y })),
        closed: false,
      });
    } else if (e.kind === "text") {
      entities.push({
        type: "TEXT",
        layer,
        position: { x: e.a.x, y: -e.a.y },
        height: 14,
        value: e.text ?? "",
      });
    }
  }

  return {
    layers,
    entities,
    units: "mm",
    sourceFormat: "cad-engine",
  };
}

export function loadDxfIntoCad(
  doc: DxfDocument,
  opts: { clear?: boolean; scale?: number; offset?: CadPt } = {},
): number {
  const scale = opts.scale ?? 1;
  const ox = opts.offset?.x ?? 40;
  const oy = opts.offset?.y ?? 40;
  if (opts.clear !== false) cadEngine.clear();

  // Ensure layers
  for (const l of doc.layers) {
    const existing = cadEngine.listLayers().find((x) => x.name === l.name);
    if (!existing) {
      cadEngine.addLayer(l.name, aciToHex(l.color));
    }
  }

  const mapLayer = (name: string): string => {
    const found = cadEngine.listLayers().find((l) => l.name === name);
    if (found) {
      cadEngine.setActiveLayer(found.id);
      return found.id;
    }
    return cadEngine.getActiveLayer().id;
  };

  const toScreen = (p: DxfPoint): CadPt => ({
    x: p.x * scale + ox,
    y: -p.y * scale + oy, // DXF Y-up - screen Y-down
  });

  let n = 0;
  for (const e of doc.entities) {
    mapLayer(e.layer);
    if (e.type === "LINE") {
      cadEngine.addLine(toScreen(e.start), toScreen(e.end));
      n++;
    } else if (e.type === "CIRCLE") {
      cadEngine.addCircle(toScreen(e.center), e.radius * scale);
      n++;
    } else if (e.type === "ARC") {
      const c = toScreen(e.center);
      const a0 = (-e.startAngle * Math.PI) / 180;
      const a1 = (-e.endAngle * Math.PI) / 180;
      cadEngine.addArc(c, e.radius * scale, a0, a1);
      n++;
    } else if (e.type === "LWPOLYLINE") {
      const pts = e.points.map(toScreen);
      if (e.closed && pts.length) pts.push({ ...pts[0] });
      cadEngine.addPolyline(pts);
      n++;
    } else if (e.type === "TEXT") {
      cadEngine.addText(toScreen(e.position), e.value);
      n++;
    }
  }
  return n;
}

/* -- THREE preview group --------------------------------------------------- */

function ensureThreeGroup(): THREE.Group | null {
  const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
  if (!scene) return null;
  if (!threeGroup) {
    threeGroup = new THREE.Group();
    threeGroup.name = "obs-drawings-dxf";
    scene.add(threeGroup);
  }
  return threeGroup;
}

export function loadDxfIntoScene(doc: DxfDocument, opts: { scale?: number } = {}): number {
  const group = ensureThreeGroup();
  if (!group) return 0;
  while (group.children.length) {
    const ch = group.children[0];
    group.remove(ch);
    (ch as Any).geometry?.dispose?.();
  }

  const scale = opts.scale ?? 0.001; // mm - m default
  const mat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
  let n = 0;

  const addLine = (a: DxfPoint, b: DxfPoint, color?: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x * scale, (a.z ?? 0) * scale, -a.y * scale),
      new THREE.Vector3(b.x * scale, (b.z ?? 0) * scale, -b.y * scale),
    ]);
    const m = color != null ? new THREE.LineBasicMaterial({ color: new THREE.Color(aciToHex(color)) }) : mat;
    group!.add(new THREE.Line(geo, m));
    n++;
  };

  for (const e of doc.entities) {
    if (e.type === "LINE") addLine(e.start, e.end, e.color);
    else if (e.type === "CIRCLE") {
      const curve = new THREE.EllipseCurve(
        0, 0, e.radius, e.radius, 0, Math.PI * 2, false, 0,
      );
      const pts = curve.getPoints(48).map(
        (p) =>
          new THREE.Vector3(
            (e.center.x + p.x) * scale,
            (e.center.z ?? 0) * scale,
            -(e.center.y + p.y) * scale,
          ),
      );
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.LineLoop(geo, mat));
      n++;
    } else if (e.type === "LWPOLYLINE") {
      for (let i = 0; i < e.points.length - 1; i++) {
        addLine(e.points[i], e.points[i + 1], e.color);
      }
      if (e.closed && e.points.length > 1) {
        addLine(e.points[e.points.length - 1], e.points[0], e.color);
      }
    } else if (e.type === "ARC") {
      const a0 = (e.startAngle * Math.PI) / 180;
      const a1 = (e.endAngle * Math.PI) / 180;
      const curve = new THREE.EllipseCurve(
        0, 0, e.radius, e.radius, a0, a1, false, 0,
      );
      const pts = curve.getPoints(32).map(
        (p) =>
          new THREE.Vector3(
            (e.center.x + p.x) * scale,
            (e.center.z ?? 0) * scale,
            -(e.center.y + p.y) * scale,
          ),
      );
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(new THREE.Line(geo, mat));
      n++;
    }
  }
  return n;
}

/* -- Import / export API --------------------------------------------------- */

export async function importDxfText(
  text: string,
  name = "drawing.dxf",
  opts?: { intoCad?: boolean; intoScene?: boolean; clearCad?: boolean },
): Promise<DrawingDocument> {
  const doc = parseDxf(text);
  const id = uid();
  const drawing: DrawingDocument = {
    id,
    name,
    format: "dxf",
    doc,
    loadedAt: Date.now(),
  };
  drawings.set(id, drawing);
  activeId = id;

  if (opts?.intoCad !== false) {
    const n = loadDxfIntoCad(doc, { clear: opts?.clearCad !== false });
    toast("success", `DXF - CAD: ${n} entities`);
  }
  if (opts?.intoScene) {
    const n = loadDxfIntoScene(doc);
    toast("info", `DXF - 3D: ${n} objects`);
  }
  return drawing;
}

export async function importDxfFile(
  file: File,
  opts?: { intoCad?: boolean; intoScene?: boolean },
): Promise<DrawingDocument> {
  const text = await file.text();
  return importDxfText(text, file.name, opts);
}

/**
 * Try DWG via optional @mlightcad/libredwg-web.
 * If not installed, returns null and caller should prompt for DXF.
 */
export async function tryImportDwg(file: File): Promise<DrawingDocument | null> {
  try {
    // Optional peer dependency
    // Must be a bare specifier WITHOUT @vite-ignore so Vite can resolve + prebundle it.
    // @ts-ignore optional dependency
    const mod: Any = await import("@mlightcad/libredwg-web");
    const LibreDwg = mod.LibreDwg ?? mod.default?.LibreDwg;
    const Dwg_File_Type = mod.Dwg_File_Type ?? mod.default?.Dwg_File_Type;
    if (!LibreDwg?.create) {
      console.warn("[dwg-engine] libredwg-web loaded but API mismatch");
      return null;
    }
    const lib = await LibreDwg.create();
    const buf = new Uint8Array(await file.arrayBuffer());
    const raw = lib.dwg_read_data(buf, Dwg_File_Type?.DWG ?? 0);
    const db = lib.convert?.(raw) ?? raw;

    // Best-effort extract entities from converted DB
    const entities: DxfEntity[] = [];
    const layers: DxfLayer[] = [{ name: "0", color: 7 }];
    const ents = db?.entities ?? db?.modelSpace?.entities ?? [];
    for (const e of ents) {
      const type = String(e.type ?? e.entityType ?? "").toUpperCase();
      const layer = e.layer ?? e.layerName ?? "0";
      if (type.includes("LINE") && e.start && e.end) {
        entities.push({
          type: "LINE",
          layer,
          start: { x: e.start.x, y: e.start.y, z: e.start.z },
          end: { x: e.end.x, y: e.end.y, z: e.end.z },
        });
      } else if (type.includes("CIRCLE") && e.center && e.radius != null) {
        entities.push({
          type: "CIRCLE",
          layer,
          center: { x: e.center.x, y: e.center.y },
          radius: e.radius,
        });
      }
    }

    const doc: DxfDocument = {
      layers,
      entities,
      sourceFormat: "dwg",
    };
    const id = uid();
    const drawing: DrawingDocument = {
      id,
      name: file.name,
      format: "dwg",
      doc,
      loadedAt: Date.now(),
    };
    drawings.set(id, drawing);
    activeId = id;
    loadDxfIntoCad(doc);
    loadDxfIntoScene(doc);
    toast("success", `DWG imported: ${entities.length} entities`);
    return drawing;
  } catch (err) {
    console.warn("[dwg-engine] DWG import unavailable:", err);
    return null;
  }
}

export async function importDrawingFile(file: File): Promise<DrawingDocument | null> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".dxf")) {
    return importDxfFile(file, { intoCad: true, intoScene: true });
  }
  if (name.endsWith(".dwg")) {
    const result = await tryImportDwg(file);
    if (result) return result;
    toast(
      "warn",
      "DWG needs @mlightcad/libredwg-web - export DXF from CAD, or: npm i @mlightcad/libredwg-web",
    );
    return null;
  }
  toast("warn", "Use .dxf or .dwg files");
  return null;
}

export function exportActiveDxf(filename?: string): void {
  const doc =
    (activeId && drawings.get(activeId)?.doc) || cadToDxfDocument();
  downloadDxf(doc, filename ?? drawings.get(activeId!)?.name ?? "drawing.dxf");
  toast("success", "DXF exported");
}

export function exportCadAsDxf(filename = "cad-export.dxf"): void {
  downloadDxf(cadToDxfDocument(), filename);
  toast("success", "CAD - DXF exported");
}

export function listDrawings(): DrawingDocument[] {
  return [...drawings.values()];
}

export function getActiveDrawing(): DrawingDocument | null {
  return activeId ? drawings.get(activeId) ?? null : null;
}

export function clearDrawingsScene(): void {
  if (threeGroup) {
    while (threeGroup.children.length) {
      const ch = threeGroup.children[0];
      threeGroup.remove(ch);
    }
  }
}

export function setupDwgEngine(): void {
  (ctx.features as Any).drawings = {
    importDxfText,
    importDxfFile,
    importDrawingFile,
    exportActiveDxf,
    exportCadAsDxf,
    cadToDxfDocument,
    loadDxfIntoCad,
    loadDxfIntoScene,
    listDrawings,
    getActiveDrawing,
    clearDrawingsScene,
    parseDxf,
    writeDxf,
  };
  (window as Any).__obsDrawings = (ctx.features as Any).drawings;
  console.log("[dwg-engine] Drawings DXF/DWG engine ready");
}
