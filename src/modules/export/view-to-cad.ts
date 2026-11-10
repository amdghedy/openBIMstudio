/**
 * View → CAD drawing: converts a generated 2D view (plan / section / elevation Scene2D) into a DXF document,
 * the way Revit's "Export > CAD Formats" turns a view into DWG/DXF.
 *
 *   scene (x, z) → DXF (X, Y). Plan: X east, Y north. Section / elevation: X along the cut, Y = elevation.
 *   Geometry is written 1:1 in the chosen units (metres or millimetres). Text heights are the paper height times the
 *   view scale, so a 2.5 mm note on a 1:100 view is 250 mm tall in the drawing, as in a Revit export.
 *
 * Layers follow an AIA-style scheme (A-CUT, A-PROJ, …) with an optional prefix. Limits are listed in
 * docs/EXPORT-VIEW-TO-CAD.md: no blocks/xrefs, symbols become circles + a label, dashed strokes use a DASHED linetype,
 * hatch patterns are written as pattern names (CAD packages substitute their own pattern definitions).
 */
import type { Scene2D, SceneEntity, StrokeStyle } from "../views/scene";
import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "../drawings/dxf-types";

export type CadUnits = "m" | "mm";

export interface ViewToCadOptions {
  /** Output units; geometry is scaled by 1 (m) or 1000 (mm). Default "mm", what architects' CAD standards expect. */
  units?: CadUnits;
  /** Prefix for every layer name, e.g. a discipline ("ARC-"). */
  layerPrefix?: string;
  /** View scale denominator (1:100 → 100) used to size text. */
  scale?: number;
  /** Which scene layers to export. Default: all. */
  include?: Partial<Record<keyof Scene2D["layers"], boolean>>;
  /** Add the view name as a title line under the drawing. Default true. */
  title?: string | null;
  /** Draw hatches as real fills. Default true. */
  hatches?: boolean;
}

export const SCENE_LAYER_NAMES: Record<keyof Scene2D["layers"], { name: string; color: number; plot: boolean }> = {
  cut: { name: "A-CUT", color: 7, plot: true },
  project: { name: "A-PROJ", color: 8, plot: true },
  overhead: { name: "A-OVHD", color: 4, plot: true },
  below: { name: "A-BELW", color: 9, plot: true },
  grid: { name: "A-GRID", color: 1, plot: true },
  annotation: { name: "A-ANNO", color: 3, plot: true },
  symbols: { name: "A-SYMB", color: 6, plot: true },
};
const TITLE_LAYER = "A-ANNO-TTLB";
const PT_MM = 25.4 / 72;

export function hexToRgb(hex: string): number | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? (() => { const s = /^#?([0-9a-f]{3})$/i.exec(hex.trim()); return s ? [null, s[1].split("").map((c) => c + c).join("")] : null; })();
  return m ? parseInt(m[1] as string, 16) : undefined;
}

function dashedFor(stroke: StrokeStyle): string | undefined {
  if (!stroke.dash || !stroke.dash.length) return undefined;
  const total = stroke.dash.reduce((a, b) => a + b, 0);
  return total > 0 ? "DASHED" : undefined;
}

export interface ViewToCadResult {
  doc: DxfDocument;
  stats: { entities: number; byLayer: Record<string, number>; skipped: Record<string, number> };
}

export function sceneToDxfDocument(scene: Scene2D, opts: ViewToCadOptions = {}): ViewToCadResult {
  const k = (opts.units ?? "mm") === "mm" ? 1000 : 1;
  const prefix = opts.layerPrefix ?? "";
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 100;
  const wantHatch = opts.hatches !== false;
  const entities: DxfEntity[] = [];
  const byLayer: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const used = new Set<string>();

  const P = (x: number, z: number): DxfPoint => ({ x: round(x * k), y: round(z * k), z: 0 });
  const common = (layerKey: keyof Scene2D["layers"], stroke?: StrokeStyle) => {
    const layer = prefix + SCENE_LAYER_NAMES[layerKey].name;
    used.add(layer);
    byLayer[layer] = (byLayer[layer] ?? 0) + 1;
    const rgb = stroke ? hexToRgb(stroke.color) : undefined;
    return {
      layer,
      ...(rgb !== undefined ? { rgb } : {}),
      ...(stroke ? { lineweight: Math.max(0.05, Math.round(stroke.widthPt * PT_MM * 100) / 100) } : {}),
      ...(stroke && dashedFor(stroke) ? { lineType: "DASHED" } : {}),
    };
  };
  const skip = (kind: string) => { skipped[kind] = (skipped[kind] ?? 0) + 1; };

  const push = (layerKey: keyof Scene2D["layers"], e: SceneEntity) => {
    switch (e.kind) {
      case "line":
        entities.push({ type: "LINE", ...common(layerKey, e.stroke), start: P(e.x1, e.z1), end: P(e.x2, e.z2) });
        break;
      case "polyline": {
        if (e.points.length < 2) { skip("polyline<2"); break; }
        const base = common(layerKey, e.stroke);
        const pts = e.points.map(([x, z]) => P(x, z));
        const ent: DxfEntity = { type: "LWPOLYLINE", ...base, points: pts, closed: e.closed };
        if (e.fill && e.closed && wantHatch) {
          ent.hatch = { solid: true, loops: [pts] };
          const f = hexToRgb(e.fill.color);
          if (f !== undefined) ent.rgb = f;
        }
        entities.push(ent);
        break;
      }
      case "arc": {
        // Scene arcs are counter-clockwise from a0 to a1 when a1 > a0, clockwise otherwise; DXF arcs are always CCW.
        const [from, to] = e.a1 >= e.a0 ? [e.a0, e.a1] : [e.a1, e.a0];
        entities.push({ type: "ARC", ...common(layerKey, e.stroke), center: P(e.cx, e.cz), radius: round(e.r * k), startAngle: norm((from * 180) / Math.PI), endAngle: norm((to * 180) / Math.PI) });
        break;
      }
      case "circle": {
        const ent: DxfEntity = { type: "CIRCLE", ...common(layerKey, e.stroke), center: P(e.cx, e.cz), radius: round(e.r * k) };
        entities.push(ent);
        break;
      }
      case "text": {
        const h = round(e.sizePt * PT_MM * scale * k / 1000);
        const base = common(layerKey);
        const rgb = hexToRgb(e.color);
        entities.push({ type: "TEXT", ...base, ...(rgb !== undefined ? { rgb } : {}), position: P(e.x, e.z), height: h > 0 ? h : round(2.5 * scale * k / 1000), value: e.text, rotation: e.rotation || undefined, align: e.anchor === "middle" ? "center" : e.anchor === "end" ? "right" : "left" });
        if (e.leader && e.leaderTarget) {
          entities.push({ type: "LINE", ...common(layerKey, { color: e.color, widthPt: 0.5, dash: null }), start: P(e.x, e.z), end: P(e.leaderTarget[0], e.leaderTarget[1]) });
        }
        break;
      }
      case "symbol": {
        const r = (e.size || 0.3) / 2;
        entities.push({ type: "CIRCLE", ...common(layerKey), center: P(e.x, e.z), radius: round(r * k) });
        entities.push({ type: "TEXT", ...common(layerKey), position: P(e.x + r * 1.2, e.z), height: round(2.5 * PT_MM * scale * k / 1000 * 1.4), value: e.name });
        break;
      }
      case "hatch": {
        if (e.polygon.length < 3) { skip("hatch<3"); break; }
        const pts = e.polygon.map(([x, z]) => P(x, z));
        const rgb = hexToRgb(e.color);
        const ent: DxfEntity = { type: "LWPOLYLINE", ...common(layerKey), ...(rgb !== undefined ? { rgb } : {}), points: pts, closed: true };
        if (wantHatch) ent.hatch = { solid: /solid/i.test(e.pattern), pattern: e.pattern, scale: Math.max(0.001, e.scale * k), loops: [pts] };
        entities.push(ent);
        break;
      }
      default:
        skip((e as { kind: string }).kind);
    }
  };

  (Object.keys(scene.layers) as Array<keyof Scene2D["layers"]>).forEach((key) => {
    if (opts.include && opts.include[key] === false) return;
    for (const e of scene.layers[key]) push(key, e);
  });

  if (opts.title) {
    const b = scene.bounds;
    const h = round(5 * PT_MM * scale * k / 1000);
    used.add(prefix + TITLE_LAYER);
    byLayer[prefix + TITLE_LAYER] = 1;
    entities.push({ type: "TEXT", layer: prefix + TITLE_LAYER, position: P(b.minX, b.minZ - 3 * (scale / 100) - h / k * 2), height: h, value: `${opts.title}   1:${scale}` });
  }

  const layers: DxfLayer[] = [{ name: "0", color: 7 }];
  for (const key of Object.keys(SCENE_LAYER_NAMES) as Array<keyof Scene2D["layers"]>) {
    const name = prefix + SCENE_LAYER_NAMES[key].name;
    if (used.has(name)) layers.push({ name, color: SCENE_LAYER_NAMES[key].color });
  }
  if (used.has(prefix + TITLE_LAYER)) layers.push({ name: prefix + TITLE_LAYER, color: 7 });

  const doc: DxfDocument = {
    layers,
    entities,
    units: opts.units === "m" ? "m" : "mm",
    sourceFormat: "cad-engine",
    linetypes: { DASHED: [12, -6] },
  };
  return { doc, stats: { entities: entities.length, byLayer, skipped } };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const norm = (d: number) => ((d % 360) + 360) % 360;

/** A safe file base name for a view. */
export function cadFileName(viewName: string, ext: "dxf" | "dwg", used: Set<string> = new Set()): string {
  let base = viewName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "view";
  let name = `${base}.${ext}`, i = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${i++}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}
