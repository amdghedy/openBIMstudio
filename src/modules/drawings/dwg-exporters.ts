/**
 * DWG exporters and audit helpers for the Drawings engine.
 *
 * These are the in-browser equivalents of the LibreDWG utility programs:
 *   documentToJsonDump     ~ dwgread -O JSON   (full database dump)
 *   documentToSvg          ~ dwg2SVG           (2D flatten to SVG)
 *   documentToGeoJson      ~ dwg2geojson       (points/lines/polygons)
 *   documentToPostScript   ~ dwg2ps            (EPS via moveto/lineto/arc)
 *   auditDrawing           ~ dwg_audit         (structured integrity report)
 *
 * Everything here is pure and DOM-free (string in / string out over the
 * DxfDocument model) so Node tests can exercise the exact code the browser
 * runs. File pickers, dialogs and downloads live in features/libredwg-toolkit.ts.
 */

import type { DxfDocument, DxfEntity, DxfPoint } from "./dxf-types";
import { aciToRgb, rgbToCss } from "./aci";

type Any = Record<string, any>;

export interface DwgExportMeta {
  fileName?: string;
  /** DWG version stamp, e.g. "AC1032". */
  version?: string;
  generatedAt?: number;
}

/* ── shared helpers ─────────────────────────────────────────────────────── */

function modelEntities(doc: DxfDocument): DxfEntity[] {
  return Array.isArray(doc.entities) ? doc.entities : [];
}

function pts2d(p: DxfPoint): [number, number] {
  return [p.x, p.y];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBounds(doc: DxfDocument): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of modelEntities(doc)) {
    switch (e.type) {
      case "LINE":
        add(e.start.x, e.start.y); add(e.end.x, e.end.y);
        break;
      case "RAY": {
        const d = e.direction, s = e.start;
        const len = Math.hypot(d.x, d.y) || 1;
        add(s.x, s.y);
        add(s.x + d.x / len * 1e3, s.y + d.y / len * 1e3); // practical clip
        break;
      }
      case "XLINE": {
        const d = e.direction, s = e.start;
        const len = Math.hypot(d.x, d.y) || 1;
        add(s.x + d.x / len * 1e3, s.y + d.y / len * 1e3);
        add(s.x - d.x / len * 1e3, s.y - d.y / len * 1e3);
        break;
      }
      case "CIRCLE":
      case "ARC":
        add(e.center.x - e.radius, e.center.y - e.radius);
        add(e.center.x + e.radius, e.center.y + e.radius);
        break;
      case "LWPOLYLINE":
        for (const p of e.points) add(p.x, p.y);
        break;
      case "POINT":
        add(e.position.x, e.position.y);
        break;
      case "TEXT":
        add(e.position.x, e.position.y);
        add(e.position.x + (e.value?.length ?? 0) * e.height * 0.8, e.position.y + e.height);
        break;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxY)) return null;
  if (maxX - minX < 1e-9 && maxY - minY < 1e-9) { maxX += 1; maxY += 1; }
  return { minX, minY, maxX, maxY };
}

/** Full arc endpoint pair in DXF coords (angles in degrees, CCW). */
function arcEndpoints(center: DxfPoint, r: number, a0: number, a1: number): { start: [number, number]; end: [number, number]; sweep: number } {
  const rad = (d: number) => (d * Math.PI) / 180;
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360; // DXF arcs go CCW from start to end
  return {
    start: [center.x + r * Math.cos(rad(a0)), center.y + r * Math.sin(rad(a0))],
    end: [center.x + r * Math.cos(rad(a1)), center.y + r * Math.sin(rad(a1))],
    sweep,
  };
}

function arcPolyline(center: DxfPoint, r: number, a0: number, a1: number, segments = 33): [number, number][] {
  const pts: [number, number][] = [];
  const sweep = (() => { let s = a1 - a0; while (s <= 0) s += 360; return s; })();
  for (let i = 0; i <= segments; i++) {
    const a = ((a0 + (sweep * i) / segments) * Math.PI) / 180;
    pts.push([center.x + r * Math.cos(a), center.y + r * Math.sin(a)]);
  }
  return pts;
}

function circleRing(center: DxfPoint, r: number, segments = 64): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([center.x + r * Math.cos(a), center.y + r * Math.sin(a)]);
  }
  return pts;
}

/** Resolve the CSS color of an entity: true color > ACI > layer color > default. */
function entityColor(doc: DxfDocument, e: DxfEntity, fallback = "#222222"): string {
  if (typeof e.rgb === "number") return rgbToCss(e.rgb);
  if (typeof e.color === "number" && e.color > 0) return rgbToCss(aciToRgb(e.color));
  const layer = doc.layers?.find((l) => l.name === e.layer);
  if (layer) {
    if (typeof layer.rgb === "number") return rgbToCss(layer.rgb);
    if (typeof layer.color === "number" && layer.color > 0) return rgbToCss(aciToRgb(layer.color));
  }
  return fallback;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

/* ── dwg2SVG ────────────────────────────────────────────────────────────── */

/**
 * Flatten the model space of `doc` to a standalone SVG document (LibreDWG
 * dwg2SVG-compatible behavior: geometry group is y-flipped so DXF coordinates can be used
 * directly; text is emitted un-flipped with per-glyph transforms so labels
 * stay readable).
 */
export function documentToSvg(doc: DxfDocument): { svg: string; width: number; height: number } {
  const b = computeBounds(doc) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const margin = Math.max((b.maxX - b.minX), (b.maxY - b.minY)) * 0.04 + 1;
  const minX = b.minX - margin, minY = b.minY - margin;
  const w = (b.maxX - b.minX) + margin * 2;
  const h = (b.maxY - b.minY) + margin * 2;
  // K = 2*maxY of the flip matrix(1,0,0,-1,0,K): maps y -> K - y.
  const K = 2 * (b.maxY + margin);
  const sw = Math.max(w, h) / 1200;

  const geometry: string[] = [];
  const texts: string[] = [];
  const color = (e: DxfEntity) => entityColor(doc, e);

  for (const e of modelEntities(doc)) {
    const c = color(e);
    switch (e.type) {
      case "LINE":
        geometry.push(`<line x1="${num(e.start.x)}" y1="${num(e.start.y)}" x2="${num(e.end.x)}" y2="${num(e.end.y)}" stroke="${c}"/>`);
        break;
      case "RAY": {
        const d = e.direction;
        const len = Math.hypot(d.x, d.y) || 1;
        const far = 1e3 / len;
        geometry.push(`<line x1="${num(e.start.x)}" y1="${num(e.start.y)}" x2="${num(e.start.x + d.x * far)}" y2="${num(e.start.y + d.y * far)}" stroke="${c}" stroke-dasharray="${num(sw * 6)} ${num(sw * 4)}"/>`);
        break;
      }
      case "XLINE": {
        const d = e.direction;
        const len = Math.hypot(d.x, d.y) || 1;
        const far = 1e3 / len;
        geometry.push(`<line x1="${num(e.start.x - d.x * far)}" y1="${num(e.start.y - d.y * far)}" x2="${num(e.start.x + d.x * far)}" y2="${num(e.start.y + d.y * far)}" stroke="${c}" stroke-dasharray="${num(sw * 6)} ${num(sw * 4)}"/>`);
        break;
      }
      case "CIRCLE":
        geometry.push(`<circle cx="${num(e.center.x)}" cy="${num(e.center.y)}" r="${num(Math.max(e.radius, 0))}" stroke="${c}"/>`);
        break;
      case "ARC": {
        const ep = arcEndpoints(e.center, e.radius, e.startAngle, e.endAngle);
        const large = ep.sweep > 180 ? 1 : 0;
        geometry.push(`<path d="M ${num(ep.start[0])} ${num(ep.start[1])} A ${num(e.radius)} ${num(e.radius)} 0 ${large} 1 ${num(ep.end[0])} ${num(ep.end[1])}" stroke="${c}"/>`);
        break;
      }
      case "LWPOLYLINE": {
        if (!e.points.length) break;
        const d = e.points.map((p, i) => `${i ? "L" : "M"} ${num(p.x)} ${num(p.y)}`).join(" ") + (e.closed ? " Z" : "");
        if (e.hatch) {
          geometry.push(`<path d="${d}" stroke="${c}" fill="${e.hatch.solid ? c : "none"}" fill-opacity="${e.hatch.solid ? 0.85 : 0}"/>`);
        } else {
          geometry.push(`<path d="${d}" stroke="${c}"/>`);
        }
        break;
      }
      case "POINT": {
        const s = sw * 4;
        geometry.push(`<path d="M ${num(e.position.x - s)} ${num(e.position.y)} H ${num(e.position.x + s)} M ${num(e.position.x)} ${num(e.position.y - s)} V ${num(e.position.y + s)}" stroke="${c}"/>`);
        break;
      }
      case "TEXT": {
        if (!e.value) break;
        const anchor = e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
        const rot = e.rotation ? ` rotate(${num(-e.rotation)})` : "";
        texts.push(
          `<text transform="translate(${num(e.position.x)} ${num(K - e.position.y)})${rot} scale(1,-1)" ` +
          `font-size="${num(Math.max(e.height, sw))}" text-anchor="${anchor}" fill="${c}" ` +
          `${e.bold ? `font-weight="bold" ` : ""}${e.italic ? `font-style="italic" ` : ""}xml:space="preserve">${xmlEsc(e.value)}</text>`,
        );
        break;
      }
    }
  }

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="${num(minX)} ${num(minY)} ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">\n` +
    `<g transform="matrix(1,0,0,-1,0,${num(K)})" fill="none" stroke-width="${num(sw)}" stroke-linecap="round" stroke-linejoin="round" data-obs-dwg="model-space">\n` +
    geometry.join("\n") +
    `\n</g>\n` +
    texts.join("\n") +
    `\n</svg>\n`;
  return { svg, width: w, height: h };
}

/* ── dwg2geojson ────────────────────────────────────────────────────────── */

/**
 * GeoJSON FeatureCollection (LibreDWG dwg2geojson parity, plain Cartesian
 * coordinates — no CRS transform is applied to the drawing coordinates).
 */
export function documentToGeoJson(doc: DxfDocument, meta: DwgExportMeta = {}): string {
  const features: Any[] = [];

  const feature = (geometry: Any, e: DxfEntity, extra: Any = {}) => {
    features.push({
      type: "Feature",
      properties: {
        layer: e.layer,
        dwgType: e.type,
        ...((typeof e.color === "number" && e.color > 0) ? { color: e.color } : {}),
        ...extra,
      },
      geometry,
    });
  };

  for (const e of modelEntities(doc)) {
    switch (e.type) {
      case "LINE":
        feature({ type: "LineString", coordinates: [pts2d(e.start), pts2d(e.end)] }, e);
        break;
      case "RAY": {
        const len = Math.hypot(e.direction.x, e.direction.y) || 1;
        const far = 1e3 / len;
        feature({ type: "LineString", coordinates: [pts2d(e.start), [e.start.x + e.direction.x * far, e.start.y + e.direction.y * far]] }, e);
        break;
      }
      case "XLINE": {
        const len = Math.hypot(e.direction.x, e.direction.y) || 1;
        const far = 1e3 / len;
        feature({ type: "LineString", coordinates: [[e.start.x - e.direction.x * far, e.start.y - e.direction.y * far], [e.start.x + e.direction.x * far, e.start.y + e.direction.y * far]] }, e);
        break;
      }
      case "CIRCLE":
        if (e.radius > 0) {
          const ring = circleRing(e.center, e.radius);
          feature({ type: "Polygon", coordinates: [[...ring, ring[0]]] }, e);
        }
        break;
      case "ARC":
        feature({ type: "LineString", coordinates: arcPolyline(e.center, e.radius, e.startAngle, e.endAngle) }, e);
        break;
      case "LWPOLYLINE": {
        if (e.points.length < 2) break;
        const coords = e.points.map(pts2d);
        if (e.closed && !e.hatch) feature({ type: "Polygon", coordinates: [[...coords, coords[0]]] }, e);
        else feature({ type: "LineString", coordinates: coords }, e, e.hatch ? { hatch: e.hatch.pattern ?? "SOLID" } : {});
        break;
      }
      case "POINT":
        feature({ type: "Point", coordinates: pts2d(e.position) }, e);
        break;
      case "TEXT":
        feature({ type: "Point", coordinates: pts2d(e.position) }, e, { text: e.value, height: e.height });
        break;
    }
  }

  return JSON.stringify({
    type: "FeatureCollection",
    name: (meta.fileName ?? "drawing").replace(/\.(dwg|dxf)$/i, ""),
    generatedBy: "Open BIM Studio — LibreDWG toolkit (dwg2geojson)",
    generatedAt: meta.generatedAt ?? Date.now(),
    version: meta.version,
    features,
  }, null, 1);
}

/* ── dwg2ps ─────────────────────────────────────────────────────────────── */

function psEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "?");
}

/**
 * EPS writer (LibreDWG dwg2ps parity). PostScript is y-up like DXF, so no
 * coordinate flip is needed — drawing coordinates are used directly.
 */
export function documentToPostScript(doc: DxfDocument, title = "Open BIM Studio drawing"): string {
  const b = computeBounds(doc) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.02 + 1;
  const bb = [b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad].map((v) => Math.round(v));
  const lw = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 1200;

  const out: string[] = [];
  out.push("%!PS-Adobe-3.0 EPSF-3.0");
  out.push(`%%BoundingBox: ${bb[0]} ${bb[1]} ${bb[2]} ${bb[3]}`);
  out.push(`%%Title: ${title}`);
  out.push("%%Creator: Open BIM Studio — LibreDWG toolkit (dwg2ps)");
  out.push("%%EndComments");
  out.push("/m { moveto } bind def");
  out.push("/l { lineto } bind def");
  out.push("/rg { setrgbcolor } bind def");
  out.push("1 setlinejoin 1 setlinecap");
  const hexToRgb = (css: string): [number, number, number] => {
    const v = css.startsWith("#") ? css.slice(1) : "222222";
    const n = parseInt(v.length === 3 ? v.replace(/(.)/g, "$1$1") : v, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const setColor = (css: string) => {
    const [r, g, bl] = hexToRgb(css);
    out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${bl.toFixed(3)} rg`);
  };

  for (const e of modelEntities(doc)) {
    const c = entityColor(doc, e, "#111111");
    switch (e.type) {
      case "LINE":
        setColor(c); out.push("newpath");
        out.push(`${num(e.start.x)} ${num(e.start.y)} m ${num(e.end.x)} ${num(e.end.y)} l stroke`);
        break;
      case "RAY":
      case "XLINE": {
        const len = Math.hypot(e.direction.x, e.direction.y) || 1;
        const far = 1e3 / len;
        const s = e.type === "RAY" ? [e.start, { x: e.start.x + e.direction.x * far, y: e.start.y + e.direction.y * far }] : [{ x: e.start.x - e.direction.x * far, y: e.start.y - e.direction.y * far }, { x: e.start.x + e.direction.x * far, y: e.start.y + e.direction.y * far }];
        setColor(c); out.push("newpath");
        out.push(`${num(s[0].x)} ${num(s[0].y)} m ${num(s[1].x)} ${num(s[1].y)} l stroke`);
        break;
      }
      case "CIRCLE":
        if (e.radius <= 0) break;
        setColor(c); out.push("newpath");
        out.push(`${num(e.center.x)} ${num(e.center.y)} ${num(e.radius)} 0 360 arc stroke`);
        break;
      case "ARC": {
        if (e.radius <= 0) break;
        // PS arcs are CCW like DXF; angles are already degrees.
        let a0 = e.startAngle, sweep = e.endAngle - a0;
        while (sweep <= 0) sweep += 360;
        setColor(c); out.push("newpath");
        out.push(`${num(e.center.x)} ${num(e.center.y)} ${num(e.radius)} ${num(a0)} ${num(a0 + sweep)} arc stroke`);
        break;
      }
      case "LWPOLYLINE": {
        if (e.points.length < 2) break;
        setColor(c);
        if (e.hatch?.solid) out.push("newpath");
        const d = e.points.map((p, i) => `${i ? num(p.x) + " " + num(p.y) + " l" : num(p.x) + " " + num(p.y) + " m"}`).join(" ");
        out.push(d + (e.closed ? " closepath" : "") + (e.hatch?.solid ? " eofill" : " stroke"));
        break;
      }
      case "POINT":
        setColor(c); out.push("newpath");
        out.push(`${num(e.position.x)} ${num(e.position.y)} ${num(lw * 3)} 0 360 arc fill`);
        break;
      case "TEXT": {
        if (!e.value) break;
        const h = Math.max(e.height, lw * 4);
        setColor(c);
        out.push(`/${e.font && !/\.(shx|pfb)$/i.test(e.font) ? psEscape(e.font) : "Helvetica"}-Roman findfont ${num(h)} scalefont setfont`);
        out.push(`${num(e.position.x)} ${num(e.position.y)} moveto`);
        const rot = e.rotation ? `${num(e.rotation)} rotate ` : "";
        out.push(`gsave ${rot}(${psEscape(e.value)}) show grestore`);
        break;
      }
    }
  }

  out.push("showpage");
  return out.join("\n") + "\n";
}

/* ── dwgread -O JSON (database dump) ────────────────────────────────────── */

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it) || "?";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Full JSON dump of the drawing database — the platform equivalent of
 * `dwgread -O JSON`. Keeps entities verbatim so nothing is lost.
 */
export function documentToJsonDump(doc: DxfDocument, meta: DwgExportMeta = {}): string {
  const entities = modelEntities(doc);
  const dump = {
    $schema: "openbimstudio/dwg-json-dump@1",
    generator: "Open BIM Studio — LibreDWG toolkit (dwg2json)",
    generatedAt: meta.generatedAt ?? Date.now(),
    file: { name: meta.fileName, version: meta.version },
    units: doc.units ?? "unitless",
    extents: doc.extents,
    counts: {
      entities: entities.length,
      layers: doc.layers?.length ?? 0,
      linetypes: Object.keys(doc.linetypes ?? {}).length,
      textStyles: Object.keys(doc.textStyles ?? {}).length,
      dimStyles: doc.dimStyles?.length ?? 0,
      layouts: doc.layouts?.length ?? 0,
      byType: countBy(entities, (e) => e.type),
    },
    layers: doc.layers,
    linetypes: doc.linetypes,
    ltscale: doc.ltscale,
    textStyles: doc.textStyles,
    dimStyles: doc.dimStyles,
    dimStyleTable: doc.dimStyleTable,
    layouts: doc.layouts?.map((l) => ({
      name: l.name,
      entities: l.entities?.length ?? 0,
      viewports: l.viewports?.length ?? 0,
    })),
    skipped: doc.skipped,
    entities,
  };
  return JSON.stringify(dump, null, 1);
}

/* ── dwg_audit — structured integrity report ────────────────────────────── */

export interface DwgAuditIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  layer?: string;
}

export interface DwgAuditReport {
  meta: {
    fileName?: string;
    version?: string;
    units?: string;
    extents?: DxfDocument["extents"];
  };
  totals: {
    entities: number;
    layoutCount: number;
    entitiesInLayouts: number;
    layerCount: number;
    emptyLayers: number;
  };
  byType: Array<{ type: string; count: number }>;
  byLayer: Array<{ layer: string; entities: number }>;
  layers: Array<{ name: string; color: number; frozen?: boolean; off?: boolean; locked?: boolean; entities: number }>;
  skipped: Array<{ type: string; count: number }>;
  issues: DwgAuditIssue[];
  issueCounts: { error: number; warning: number; info: number };
  verdict: string;
}

/**
 * Integrity audit in the spirit of LibreDWG's dwg_audit: geometry sanity,
 * dangling references and table consistency, with a severity-ranked issue
 * list. Pure — no DOM.
 */
export function auditDrawing(doc: DxfDocument, meta: DwgExportMeta = {}): DwgAuditReport {
  const entities = modelEntities(doc);
  const issues: DwgAuditIssue[] = [];
  const push = (severity: DwgAuditIssue["severity"], code: string, message: string, layer?: string) => {
    if (issues.length < 500) issues.push({ severity, code, message, layer });
  };

  const layerNames = new Set((doc.layers ?? []).map((l) => l.name));
  const styleNames = new Set(Object.keys(doc.textStyles ?? {}).map((k) => k.toUpperCase()));

  const byTypeMap = countBy(entities, (e) => e.type);
  const byLayerMap = countBy(entities, (e) => e.layer || "?");

  let zeroLen = 0, zeroRadius = 0, degeneratePoly = 0, emptyText = 0;
  let danglingLayer = 0, danglingStyle = 0;

  for (const e of entities) {
    const L = e.layer;
    switch (e.type) {
      case "LINE":
        if (Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) < 1e-9) {
          zeroLen++;
          if (zeroLen <= 5) push("warning", "zero-length-line", "LINE with identical start and end point.", L);
        }
        break;
      case "CIRCLE":
      case "ARC":
        if (!(e.radius > 0)) {
          zeroRadius++;
          if (zeroRadius <= 5) push("warning", "zero-radius", `${e.type} with non-positive radius.`, L);
        }
        break;
      case "LWPOLYLINE":
        if (!e.hatch && e.points.length < 2) {
          degeneratePoly++;
          if (degeneratePoly <= 5) push("warning", "degenerate-polyline", "LWPOLYLINE with fewer than 2 points.", L);
        }
        break;
      case "TEXT":
        if (!e.value || !e.value.trim()) {
          emptyText++;
          if (emptyText <= 5) push("info", "empty-text", "TEXT entity with empty string.", L);
        }
        if (e.style && !styleNames.has(e.style.toUpperCase())) {
          danglingStyle++;
          if (danglingStyle <= 5) push("warning", "style-not-in-table", `TEXT references style "${e.style}" which is missing from the STYLE table.`, L);
        }
        break;
    }
    if (e.layer && !layerNames.has(e.layer)) {
      danglingLayer++;
      if (danglingLayer <= 5) push("warning", "layer-not-in-table", `Entity references layer "${e.layer}" which is missing from the LAYER table.`, L);
    }
  }
  if (zeroLen > 5) push("warning", "zero-length-line", `${zeroLen} zero-length LINE entities total (first 5 listed).`);
  if (zeroRadius > 5) push("warning", "zero-radius", `${zeroRadius} non-positive-radius circles/arcs total (first 5 listed).`);
  if (degeneratePoly > 5) push("warning", "degenerate-polyline", `${degeneratePoly} degenerate LWPOLYLINE entities total (first 5 listed).`);
  if (danglingLayer > 5) push("warning", "layer-not-in-table", `${danglingLayer} entities on layers missing from the LAYER table (first 5 listed).`);
  if (danglingStyle > 5) push("warning", "style-not-in-table", `${danglingStyle} TEXT entities reference missing text styles (first 5 listed).`);

  const emptyLayers = (doc.layers ?? []).filter((l) => !byLayerMap[l.name]);
  if (emptyLayers.length) {
    push("info", "empty-layers", `${emptyLayers.length} layer(s) contain no entities (e.g. ${emptyLayers.slice(0, 3).map((l) => `"${l.name}"`).join(", ")}).`);
  }
  const skippedEntries = Object.entries(doc.skipped ?? {}).map(([type, count]) => ({ type, count }));
  if (skippedEntries.length) {
    push("info", "skipped-types", `${skippedEntries.reduce((s, x) => s + x.count, 0)} entities of ${skippedEntries.length} type(s) were read but cannot be drawn (see the Skipped census).`);
  }
  if (!entities.length) {
    push("error", "empty-drawing", "The drawing contains no model-space entities.");
  }
  if (!doc.extents && entities.length) {
    push("info", "no-extents", "Drawing extents were not recorded by the reader.");
  }

  const layerEntities: Record<string, number> = {};
  for (const l of doc.layers ?? []) layerEntities[l.name] = byLayerMap[l.name] ?? 0;

  const issueCounts = {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
  const verdict = issueCounts.error
    ? `${issueCounts.error} error(s), ${issueCounts.warning} warning(s) — fix the errors before relying on this drawing.`
    : issueCounts.warning
      ? `${issueCounts.warning} warning(s) found — drawing is usable.`
      : "Clean — no integrity problems found.";

  return {
    meta: { fileName: meta.fileName, version: meta.version, units: doc.units, extents: doc.extents },
    totals: {
      entities: entities.length,
      layoutCount: doc.layouts?.length ?? 0,
      entitiesInLayouts: doc.layouts?.reduce((s, l) => s + (l.entities?.length ?? 0), 0) ?? 0,
      layerCount: doc.layers?.length ?? 0,
      emptyLayers: emptyLayers.length,
    },
    byType: Object.entries(byTypeMap).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byLayer: Object.entries(byLayerMap).map(([layer, n]) => ({ layer, entities: n })).sort((a, b) => b.entities - a.entities),
    layers: (doc.layers ?? []).map((l) => ({
      name: l.name,
      color: l.color,
      frozen: l.frozen || undefined,
      off: l.off || undefined,
      locked: l.locked || undefined,
      entities: byLayerMap[l.name] ?? 0,
    })),
    skipped: skippedEntries,
    issues,
    issueCounts,
    verdict,
  };
}
