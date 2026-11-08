/**
 * Site-context readers: GeoJSON and ESRI Shapefile (.shp, optional .dbf). Pure TypeScript, no DOM, no dependencies.
 *
 * Coordinates: if every x is within ±180 and every y within ±90 the data is treated as WGS84 longitude/latitude
 * and projected to local metres with an equirectangular approximation about the layer centre (error grows with
 * extent; fine for a site, not for survey work). Anything else is assumed to be in a projected CRS already in
 * metres (the .prj file is NOT read) and is only re-centred. Both cases are reported in `crsNote`.
 * Output axes follow the app: x = east, z = north (y is up and left to the caller).
 */
export type GisKind = "point" | "line" | "polygon";
export interface GisFeature { kind: GisKind; /** parts (lines) or rings (polygons) or single-point lists, as [x,y] pairs in source units */ parts: number[][][]; props: Record<string, string | number | boolean | null> }
export interface GisLayer { name: string; features: GisFeature[]; warnings: string[] }
export interface LocalFeature { kind: GisKind; parts: Array<Array<[number, number]>>; props: GisFeature["props"] }
export interface LocalLayer { name: string; features: LocalFeature[]; warnings: string[]; crsNote: string; origin: { x: number; y: number }; geographic: boolean; widthM: number; heightM: number }

/* ───────────────────────────── GeoJSON ───────────────────────────── */

export function parseGeoJson(text: string, name = "GeoJSON"): GisLayer {
  const warnings: string[] = [];
  let doc: any;
  try { doc = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { throw new Error("Not valid JSON: " + (e instanceof Error ? e.message : String(e))); }
  const features: GisFeature[] = [];
  let unsupported = 0;
  const pt = (c: unknown): number[] | null => (Array.isArray(c) && c.length >= 2 && Number.isFinite(+c[0]) && Number.isFinite(+c[1]) ? [+c[0], +c[1]] : null);
  const line = (c: unknown): number[][] => (Array.isArray(c) ? (c.map(pt).filter(Boolean) as number[][]) : []);
  const add = (g: any, props: GisFeature["props"], depth = 0) => {
    if (!g || typeof g !== "object" || depth > 8) { unsupported++; return; }
    switch (g.type) {
      case "Point": { const p = pt(g.coordinates); if (p) features.push({ kind: "point", parts: [[p]], props }); break; }
      case "MultiPoint": { const l = line(g.coordinates); if (l.length) features.push({ kind: "point", parts: [l], props }); break; }
      case "LineString": { const l = line(g.coordinates); if (l.length > 1) features.push({ kind: "line", parts: [l], props }); break; }
      case "MultiLineString": { const p = (g.coordinates ?? []).map(line).filter((l: number[][]) => l.length > 1); if (p.length) features.push({ kind: "line", parts: p, props }); break; }
      case "Polygon": { const p = (g.coordinates ?? []).map(line).filter((l: number[][]) => l.length > 2); if (p.length) features.push({ kind: "polygon", parts: p, props }); break; }
      case "MultiPolygon": { const p = (g.coordinates ?? []).flatMap((poly: unknown[]) => poly.map(line)).filter((l: number[][]) => l.length > 2); if (p.length) features.push({ kind: "polygon", parts: p, props }); break; }
      case "GeometryCollection": for (const sub of g.geometries ?? []) add(sub, props, depth + 1); break;
      default: unsupported++;
    }
  };
  const clean = (p: any): GisFeature["props"] => {
    const o: GisFeature["props"] = {};
    if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) o[k] = v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? (v as any) : JSON.stringify(v);
    return o;
  };
  if (doc?.type === "FeatureCollection" && Array.isArray(doc.features)) for (const f of doc.features) add(f?.geometry, clean(f?.properties));
  else if (doc?.type === "Feature") add(doc.geometry, clean(doc.properties));
  else if (doc && typeof doc === "object" && typeof doc.type === "string") add(doc, {});
  else throw new Error("Not GeoJSON: expected a FeatureCollection, Feature or geometry.");
  if (unsupported) warnings.push(`${unsupported} feature(s) had missing or unsupported geometry and were skipped.`);
  if (doc?.crs) warnings.push("The file declares a CRS; GeoJSON should be WGS84 and the declaration is ignored.");
  return { name, features, warnings };
}

/* ───────────────────────────── DBF ───────────────────────────── */

export function parseDbf(buf: ArrayBuffer): Array<Record<string, string | number | boolean | null>> {
  const dv = new DataView(buf);
  if (buf.byteLength < 33) return [];
  const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
  const fields: Array<{ name: string; type: string; len: number }> = [];
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (let o = 32; o + 32 <= headLen && dv.getUint8(o) !== 0x0d; o += 32) {
    const nameBytes = new Uint8Array(buf, o, 11);
    const z = nameBytes.indexOf(0);
    fields.push({ name: dec.decode(nameBytes.subarray(0, z < 0 ? 11 : z)).trim(), type: String.fromCharCode(dv.getUint8(o + 11)), len: dv.getUint8(o + 16) });
  }
  const rows: Array<Record<string, string | number | boolean | null>> = [];
  for (let i = 0; i < n; i++) {
    const base = headLen + i * recLen;
    if (base + recLen > buf.byteLength) break;
    const row: Record<string, string | number | boolean | null> = {};
    let off = base + 1;
    for (const f of fields) {
      const s = dec.decode(new Uint8Array(buf, off, f.len)).trim();
      off += f.len;
      row[f.name] = f.type === "N" || f.type === "F" ? (s === "" || !Number.isFinite(+s) ? null : +s) : f.type === "L" ? (/^[TtYy]$/.test(s) ? true : /^[FfNn]$/.test(s) ? false : null) : s;
    }
    rows.push(row);
  }
  return rows;
}

/* ───────────────────────────── Shapefile ───────────────────────────── */

export function parseShapefile(shp: ArrayBuffer, dbf?: ArrayBuffer, name = "Shapefile"): GisLayer {
  const warnings: string[] = [];
  if (shp.byteLength < 100) throw new Error("Too small to be a .shp file.");
  const dv = new DataView(shp);
  if (dv.getInt32(0, false) !== 9994) throw new Error("Not an ESRI shapefile (bad file code).");
  const attrs = dbf ? parseDbf(dbf) : [];
  const features: GisFeature[] = [];
  let off = 100, rec = 0, unsupported = 0;
  const maxPoints = 5_000_000;
  let total = 0;
  while (off + 12 <= shp.byteLength) {
    const lenBytes = dv.getInt32(off + 4, false) * 2;
    const body = off + 8;
    if (lenBytes < 4 || body + lenBytes > shp.byteLength) { warnings.push("The file ends in a truncated record; the rest was ignored."); break; }
    const type = dv.getInt32(body, true);
    const props = attrs[rec] ?? {};
    rec++;
    off = body + lenBytes;
    if (type === 0) continue; // null shape

    const kindCode = type > 20 ? type - 20 : type > 10 ? type - 10 : type;
    try {
      if (kindCode === 1) {
        features.push({ kind: "point", parts: [[[dv.getFloat64(body + 4, true), dv.getFloat64(body + 12, true)]]], props });
        total++;
      } else if (kindCode === 8) {
        const np = dv.getInt32(body + 36, true);
        const pts: number[][] = [];
        for (let i = 0; i < np; i++) pts.push([dv.getFloat64(body + 40 + i * 16, true), dv.getFloat64(body + 48 + i * 16, true)]);
        total += np; features.push({ kind: "point", parts: [pts], props });
      } else if (kindCode === 3 || kindCode === 5) {
        const nParts = dv.getInt32(body + 36, true), np = dv.getInt32(body + 40, true);
        if (nParts < 0 || np < 0 || 44 + nParts * 4 + np * 16 > lenBytes) throw new Error("bad counts");
        total += np;
        if (total > maxPoints) { warnings.push(`Stopped after ${maxPoints.toLocaleString()} vertices.`); break; }
        const starts: number[] = [];
        for (let i = 0; i < nParts; i++) starts.push(dv.getInt32(body + 44 + i * 4, true));
        const ptsOff = body + 44 + nParts * 4;
        const parts: number[][][] = [];
        for (let p = 0; p < nParts; p++) {
          const a = starts[p], b = p + 1 < nParts ? starts[p + 1] : np;
          const pts: number[][] = [];
          for (let i = a; i < b; i++) pts.push([dv.getFloat64(ptsOff + i * 16, true), dv.getFloat64(ptsOff + i * 16 + 8, true)]);
          if (pts.length > (kindCode === 5 ? 2 : 1)) parts.push(pts);
        }
        if (parts.length) features.push({ kind: kindCode === 5 ? "polygon" : "line", parts, props });
      } else unsupported++;
    } catch { unsupported++; }
  }
  if (off < shp.byteLength && off + 12 > shp.byteLength && !warnings.some((w) => /truncated/.test(w))) warnings.push("The file ends in a truncated record; the rest was ignored.");
  if (unsupported) warnings.push(`${unsupported} record(s) had an unsupported shape type (e.g. MultiPatch) or were malformed and were skipped.`);
  if (!dbf) warnings.push("No .dbf file was provided with it, so features have no attributes.");
  else if (attrs.length !== rec) warnings.push(`The .dbf has ${attrs.length} rows but the .shp has ${rec} records; attributes may not line up.`);
  return { name, features, warnings };
}

/* ───────────────────────────── projection ───────────────────────────── */

const R = 6_378_137;

/** Convert a layer to local metres (x east, y north) centred on its bounding box. */
export function toLocal(layer: GisLayer, origin?: { x: number; y: number }): LocalLayer {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of layer.features) for (const p of f.parts) for (const [x, y] of p) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!Number.isFinite(minX)) return { name: layer.name, features: [], warnings: [...layer.warnings, "The file has no usable geometry."], crsNote: "", origin: { x: 0, y: 0 }, geographic: false, widthM: 0, heightM: 0 };
  const geographic = minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
  const o = origin ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const k = Math.cos((o.y * Math.PI) / 180);
  const conv = geographic
    ? ([x, y]: number[]): [number, number] => [((x - o.x) * Math.PI / 180) * R * k, ((y - o.y) * Math.PI / 180) * R]
    : ([x, y]: number[]): [number, number] => [x - o.x, y - o.y];
  const features = layer.features.map((f) => ({ kind: f.kind, parts: f.parts.map((p) => p.map(conv)), props: f.props }));
  const crsNote = geographic
    ? `Treated as WGS84 lon/lat and projected to local metres about (${o.x.toFixed(5)}, ${o.y.toFixed(5)}) with an equirectangular approximation.`
    : "Coordinates are outside lon/lat range, so they are assumed to be projected metres already; only re-centred. The .prj file is not read, so units and CRS are NOT verified.";
  const widthM = geographic ? ((maxX - minX) * Math.PI / 180) * R * k : maxX - minX;
  const heightM = geographic ? ((maxY - minY) * Math.PI / 180) * R : maxY - minY;
  return { name: layer.name, features, warnings: layer.warnings, crsNote, origin: o, geographic, widthM, heightM };
}
