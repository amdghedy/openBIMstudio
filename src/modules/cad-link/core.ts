/**
 * CAD link core - pure placement and geometry (no DOM, no THREE).
 *
 * World convention used across the app (plan view, snapping, shared
 * coordinates): X = east, Y = up, Z = north.  A CAD point (x, y, z) is
 * placed at world (X, Y, Z) = ( x', elevation + z*s, y' ) where (x', y') is
 * the scaled, rotated and translated drawing point.
 *
 * Positioning mirrors Revit's "Link CAD Formats" options:
 *   origin  - Auto - Origin to Origin (drawing 0,0 on the project origin)
 *   center  - Auto - Center to Center (drawing centre on the model centre)
 *   shared  - Auto - By Shared Coordinates (drawing is in survey coordinates)
 *   manual  - Manual offset from the project origin
 */
import type { DxfDocument, DxfEntity, DxfUnits } from "../drawings/dxf-types";
import { arcPoints, robustExtents, UNIT_TO_METRES } from "../drawings/dxf-geometry";
import { aciToRgb } from "../drawings/aci";

export type CadUnits = "auto" | DxfUnits;
export type Positioning = "origin" | "center" | "shared" | "manual";
export type ColorMode = "preserve" | "bw" | "invert";
export type LayerImport = "all" | "visible";
export type Theme = "light" | "dark";

export interface LinkOptions {
  units: CadUnits;
  positioning: Positioning;
  /** Manual offset in metres (world X, world Z). */
  manual: { x: number; z: number };
  /** Rotation in degrees, counter-clockwise seen from above (north up). */
  rotationDeg: number;
  /** Placement level elevation in metres. */
  elevation: number;
  /**
   * true (default): the drawing is laid flat on the placement level, exactly like a CAD plan view.
   * false: keep each point's own drawing Z (3D drawings).
   */
  flatten?: boolean;
  colors: ColorMode;
  layers: LayerImport;
  /** Plan views that show the link: every plan, or only the placement level. */
  planScope: "all" | "level";
}

export const DEFAULT_LINK_OPTIONS: LinkOptions = {
  units: "auto",
  positioning: "origin",
  manual: { x: 0, z: 0 },
  rotationDeg: 0,
  elevation: 0,
  flatten: true,
  colors: "preserve",
  layers: "all",
  planScope: "all",
};

/** Environment the placement depends on (kept out of the options so it is explicit). */
export interface PlacementEnv {
  /** Centre of the existing model in world X/Z (for "center"). */
  modelCenter: { x: number; z: number };
  /** Survey (shared) coordinates -> project coordinates, metres: (E, N) -> (X, Z). */
  surveyToProject?: (e: number, n: number) => [number, number];
}

export interface Placement {
  /** Metres per drawing unit actually used. */
  scale: number;
  unitsUsed: DxfUnits;
  /** True when the units were not declared by the file and had to be guessed. */
  unitsGuessed: boolean;
  rotationDeg: number;
  tx: number;
  tz: number;
  elevation: number;
  /** Ignore drawing Z (lay the drawing flat on the placement level). */
  flatten: boolean;
  /** Set for "shared": positions come from the survey transform instead. */
  survey?: PlacementEnv["surveyToProject"];
}

/** Guess units for a drawing that does not declare them (from its size). */
export function guessUnits(doc: DxfDocument): DxfUnits {
  const ex = robustExtents(doc.entities);
  if (!ex) return "m";
  const span = Math.max(ex.max.x - ex.min.x, ex.max.y - ex.min.y);
  if (span > 20000) return "mm";
  if (span > 2000) return "cm";
  return "m";
}

function rot(x: number, y: number, deg: number): [number, number] {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

export function computePlacement(doc: DxfDocument, opts: LinkOptions, env: PlacementEnv): Placement {
  let unitsUsed: DxfUnits;
  let unitsGuessed = false;
  if (opts.units === "auto") {
    if (doc.units && doc.units !== "unitless") unitsUsed = doc.units;
    else { unitsUsed = guessUnits(doc); unitsGuessed = true; }
  } else unitsUsed = opts.units === "unitless" ? "m" : opts.units;

  const scale = UNIT_TO_METRES[unitsUsed];
  const pl: Placement = {
    scale, unitsUsed, unitsGuessed,
    rotationDeg: opts.rotationDeg || 0,
    tx: 0, tz: 0,
    elevation: opts.elevation || 0,
    flatten: opts.flatten !== false,
  };

  if (opts.positioning === "shared" && env.surveyToProject) {
    pl.survey = env.surveyToProject;
    pl.rotationDeg = 0; // the survey transform already carries true-north rotation
    return pl;
  }
  if (opts.positioning === "manual") {
    pl.tx = opts.manual.x;
    pl.tz = opts.manual.z;
    return pl;
  }
  if (opts.positioning === "center") {
    const ex = robustExtents(doc.entities);
    if (ex) {
      const cx = ((ex.min.x + ex.max.x) / 2) * scale;
      const cy = ((ex.min.y + ex.max.y) / 2) * scale;
      const [rx, rz] = rot(cx, cy, pl.rotationDeg);
      pl.tx = env.modelCenter.x - rx;
      pl.tz = env.modelCenter.z - rz;
    }
  }
  return pl; // "origin" (and "center" with no extents)
}

/** Drawing point (units) -> world [X, Y, Z] (metres). */
export function mapPoint(pl: Placement, x: number, y: number, z = 0): [number, number, number] {
  const sx = x * pl.scale, sy = y * pl.scale;
  if (pl.flatten) z = 0;
  if (pl.survey) {
    const [wx, wz] = pl.survey(sx, sy);
    return [wx, pl.elevation + z * pl.scale, wz];
  }
  const [rx, rz] = rot(sx, sy, pl.rotationDeg);
  return [rx + pl.tx, pl.elevation + z * pl.scale, rz + pl.tz];
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export interface LayerGeometry {
  layer: string;
  /** 0xRRGGBB after colour-mode and theme handling. */
  rgb: number;
  /** x1,y1,z1,x2,y2,z2 per segment, world metres. */
  segs: number[];
}

export interface LinkText {
  layer: string;
  rgb: number;
  x: number; y: number; z: number;
  /** Text height in metres. */
  height: number;
  value: string;
  /** Degrees, world frame (counter-clockwise, north up). */
  rotation: number;
}

export interface LinkGeometry {
  groups: LayerGeometry[];
  texts: LinkText[];
  /** World bounds in X/Z, or null when empty. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  segmentCount: number;
}

export function layerNames(doc: DxfDocument): string[] {
  return doc.layers.map((l) => l.name);
}

/** True when the source marks the layer as hidden (frozen or off). */
export function layerHiddenInSource(doc: DxfDocument, name: string): boolean {
  const l = doc.layers.find((x) => x.name === name);
  return !!l && (!!l.frozen || !!l.off);
}

function resolveRgb(e: DxfEntity, doc: DxfDocument, mode: ColorMode, theme: Theme): number {
  const fg = theme === "light" ? 0x111827 : 0xe5e7eb;
  if (mode === "bw") return fg;
  let rgb: number;
  if (e.rgb != null) rgb = e.rgb;
  else if (e.color != null) rgb = aciToRgb(e.color, fg);
  else {
    const l = doc.layers.find((x) => x.name === e.layer);
    rgb = aciToRgb(l?.color ?? 7, fg);
  }
  return mode === "invert" ? (rgb ^ 0xffffff) & 0xffffff : rgb;
}

export function buildGeometry(
  doc: DxfDocument, pl: Placement, opts: LinkOptions, theme: Theme,
): LinkGeometry {
  const groups = new Map<string, LayerGeometry>();
  const texts: LinkText[] = [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  let segmentCount = 0;

  const hiddenSrc = new Set(doc.layers.filter((l) => l.frozen || l.off).map((l) => l.name));

  const grow = (x: number, z: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };

  for (const e of doc.entities) {
    if (opts.layers === "visible" && hiddenSrc.has(e.layer)) continue;
    const rgb = resolveRgb(e, doc, opts.colors, theme);
    const key = `${e.layer}|${rgb}`;
    let g = groups.get(key);
    if (!g) { g = { layer: e.layer, rgb, segs: [] }; groups.set(key, g); }

    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      const a = mapPoint(pl, ax, ay, az), b = mapPoint(pl, bx, by, bz);
      g!.segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      grow(a[0], a[2]); grow(b[0], b[2]);
      segmentCount++;
    };
    const chain = (pts: Array<{ x: number; y: number; z?: number }>, closed: boolean) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        seg(pts[i].x, pts[i].y, pts[i].z ?? 0, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z ?? 0);
      }
      if (closed && pts.length > 2) {
        const a = pts[pts.length - 1], b = pts[0];
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-12) seg(a.x, a.y, a.z ?? 0, b.x, b.y, b.z ?? 0);
      }
    };

    switch (e.type) {
      case "LINE":
        seg(e.start.x, e.start.y, e.start.z ?? 0, e.end.x, e.end.y, e.end.z ?? 0);
        break;
      case "LWPOLYLINE":
        if (e.hatch) break; // hatch boundaries are fills, not linework: keeps the linked underlay clean
        chain(e.points, !!e.closed);
        break;
      case "CIRCLE":
        chain(arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2, e.center.z ?? 0), false);
        break;
      case "ARC": {
        const a0 = (e.startAngle * Math.PI) / 180;
        const a1 = (e.endAngle * Math.PI) / 180;
        chain(arcPoints(e.center.x, e.center.y, e.radius, a0, a1, e.center.z ?? 0), false);
        break;
      }
      case "POINT": {
        const r = 0.05 / pl.scale; // 5 cm cross
        const p = e.position;
        seg(p.x - r, p.y, p.z ?? 0, p.x + r, p.y, p.z ?? 0);
        seg(p.x, p.y - r, p.z ?? 0, p.x, p.y + r, p.z ?? 0);
        break;
      }
      case "TEXT": {
        if (!e.value) break;
        const p = mapPoint(pl, e.position.x, e.position.y, e.position.z ?? 0);
        texts.push({
          layer: e.layer, rgb, x: p[0], y: p[1], z: p[2],
          height: Math.max(e.height * pl.scale, 0.01), value: e.value,
          rotation: (e.rotation ?? 0) + (pl.survey ? 0 : pl.rotationDeg),
        });
        grow(p[0], p[2]);
        break;
      }
    }
  }

  return {
    groups: [...groups.values()].filter((g) => g.segs.length),
    texts,
    bounds: Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null,
    segmentCount,
  };
}

/** Flat x1,z1,x2,z2 world segments (plan frame) from visible layers, for snapping. */
export function snapSegments(geo: LinkGeometry, isVisible: (layer: string) => boolean): number[] {
  const out: number[] = [];
  for (const g of geo.groups) {
    if (!isVisible(g.layer)) continue;
    for (let i = 0; i < g.segs.length; i += 6) {
      out.push(g.segs[i], g.segs[i + 2], g.segs[i + 3], g.segs[i + 5]);
    }
  }
  return out;
}

export interface WallSeg { x1: number; z1: number; x2: number; z2: number; }

/**
 * World-plan segments of the chosen layers for "Walls from CAD": drops
 * segments shorter than minLen (metres) and exact duplicates (either direction).
 */
export function collectLayerSegments(geo: LinkGeometry, layers: Set<string>, minLen = 0.05): WallSeg[] {
  const out: WallSeg[] = [];
  const seen = new Set<string>();
  const k = (v: number) => Math.round(v * 1000);
  for (const g of geo.groups) {
    if (!layers.has(g.layer)) continue;
    for (let i = 0; i < g.segs.length; i += 6) {
      const x1 = g.segs[i], z1 = g.segs[i + 2], x2 = g.segs[i + 3], z2 = g.segs[i + 5];
      if (Math.hypot(x2 - x1, z2 - z1) < minLen) continue;
      const a = `${k(x1)},${k(z1)}`, b = `${k(x2)},${k(z2)}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x1, z1, x2, z2 });
    }
  }
  return out;
}
