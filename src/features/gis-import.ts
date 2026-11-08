/**
 * Site context overlay: GeoJSON / Shapefile → flat 3D line and point layers on the ground plane.
 * Reading and projection live in src/modules/gis/gis-core.ts (pure, tested); this file only builds three.js objects.
 * World axes: x = east, y = up, z = north. See docs/COMPATIBILITY.md for the CRS limits.
 */
import * as THREE from "three";
import { parseGeoJson, parseShapefile, toLocal, type GisLayer, type LocalLayer } from "../modules/gis/gis-core";

export const GIS_EXTENSIONS = ["geojson", "shp"] as const;
const LIFT = 0.02; // metres above the ground plane so lines don't z-fight with a floor

export function isGisName(name: string): boolean {
  return /\.(geojson|shp)$/i.test(name);
}

export function readGisLayer(buf: ArrayBuffer, name: string, dbf?: ArrayBuffer): GisLayer {
  if (/\.shp$/i.test(name)) return parseShapefile(buf, dbf, name);
  return parseGeoJson(new TextDecoder().decode(buf), name);
}

export function buildGisObject(layer: LocalLayer): THREE.Group {
  const g = new THREE.Group();
  const lines: number[] = [], pts: number[] = [], polys: number[] = [];
  for (const f of layer.features) {
    for (const part of f.parts) {
      if (f.kind === "point") { for (const [x, z] of part) pts.push(x, LIFT, z); continue; }
      const out = f.kind === "polygon" ? polys : lines;
      for (let i = 0; i + 1 < part.length; i++) out.push(part[i][0], LIFT, part[i][1], part[i + 1][0], LIFT, part[i + 1][1]);
      if (f.kind === "polygon") { const a = part[part.length - 1], b = part[0]; if (a[0] !== b[0] || a[1] !== b[1]) polys.push(a[0], LIFT, a[1], b[0], LIFT, b[1]); }
    }
  }
  const seg = (arr: number[], color: number, name: string) => {
    if (!arr.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
    m.name = name; g.add(m);
  };
  seg(polys, 0x2e7d32, "GIS polygons (outlines)");
  seg(lines, 0x1565c0, "GIS lines");
  if (pts.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xc62828, size: 6, sizeAttenuation: false }));
    p.name = "GIS points"; g.add(p);
  }
  g.userData.gis = { name: layer.name, features: layer.features.length, origin: layer.origin, geographic: layer.geographic };
  return g;
}

export interface GisOpenResult { object: THREE.Object3D | null; message: string }

/** Parse, project and build. `message` is the honest summary to show the user. */
export function openGis(buf: ArrayBuffer, name: string, dbf?: ArrayBuffer): GisOpenResult {
  const layer = toLocal(readGisLayer(buf, name, dbf));
  if (!layer.features.length) return { object: null, message: `"${name}" has no usable geometry. ${layer.warnings.join(" ")}`.trim() };
  const kinds = { point: 0, line: 0, polygon: 0 };
  for (const f of layer.features) kinds[f.kind]++;
  const extent = `${Math.round(layer.widthM).toLocaleString()} × ${Math.round(layer.heightM).toLocaleString()} m`;
  const lines = [
    `Loaded ${layer.features.length} features from ${name}: ${kinds.polygon} polygons, ${kinds.line} lines, ${kinds.point} point sets; extent ${extent}.`,
    layer.crsNote,
    "Drawn as flat outlines on the ground plane and centred at the model origin. This is context only: not georeferenced to your model, not part of clash tests.",
    ...layer.warnings,
  ];
  return { object: buildGisObject(layer), message: lines.join("\n") };
}
