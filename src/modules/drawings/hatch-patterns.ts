/**
 * Hatch pattern library — real DXF-style pattern-line definitions for the
 * authored hatches of the 2D Drawing Editor.
 *
 * Every pattern is one or more line families in **pattern space**, exactly the
 * shape the DXF HATCH entity writes (group 53 angle in degrees, 43/44 base
 * point, 45/46 offset to the next parallel line, 49 dash/gap lengths). At
 * draw time the hatch's own angle (group 52) and scale (group 41) transform
 * the families into drawing space — the same semantics native CAD uses, so
 * files we write render identically in AutoCAD/brava-style readers and here.
 *
 * Spacings follow the ANSI inch grid expressed in millimetres
 * (0.125" = 3.175 mm). Definitions reproduce the standard ANSI/ISO hatch
 * *look*; predefined names are resolved by native CAD from its own acad.pat
 * when group 76 = 1, so these definitions only drive our own renderer and
 * are kept honest in docs/HATCHING.md.
 *
 * Pure module — no DOM, testable in Node.
 */

import type { DxfPoint } from "./dxf-types";

/** One pattern line family, in pattern space. Angle in radians. */
export interface HatchFamilyDef {
  angle: number;
  base: [number, number];
  offset: [number, number];
  dashes: number[];
}

const DEG = Math.PI / 180;

/** angle in degrees, base, offset (perpendicular spacing + along shift), dashes (+dash, −gap). */
type RawFamily = [number, [number, number], [number, number], number[]];

/**
 * The library. Spacings in pattern units (millimetres at scale 1); ANSI
 * names use the classic inch-grid spacings converted to mm.
 */
const LIBRARY: Record<string, RawFamily[]> = {
  // Iron, brick, stone masonry — the classic 45° single line, 0.125" grid.
  ANSI31: [[45, [0, 0], [0, 3.175], []]],
  // Steel — parallel 45° pairs crossed by a 135° line.
  ANSI32: [
    [45, [0, 0], [0, 9.525], []],
    [45, [4.7625, 0], [0, 9.525], []],
    [135, [0, 0], [0, 9.525], []],
  ],
  // Bronze, brass, copper — 45° dash-dot.
  ANSI33: [[45, [0, 0], [0, 6.35], [3.175, -1.5875, 0.79375, -1.5875]]],
  // Plastic, rubber — 45° tight parallel pairs.
  ANSI34: [
    [45, [0, 0], [0, 3.175], []],
    [45, [1.5875, 0], [0, 3.175], []],
  ],
  // Insulation — 45° long-dash two-dot motif.
  ANSI35: [[45, [0, 0], [0, 12.7], [4.7625, -1.5875, 0.79375, -1.5875, 0.79375, -1.5875]]],
  // Fire brick, refractory — dense dashed 45°.
  ANSI36: [[45, [0, 0], [0, 3.175], [2.38125, -0.79375]]],
  // Marble, stone, glass — 45°/135° cross-hatch, 0.1875" grid.
  ANSI37: [
    [45, [0, 0], [0, 4.7625], []],
    [135, [0, 0], [0, 4.7625], []],
  ],
  // Zinc, magnesium, green brass — dashed cross-hatch.
  ANSI38: [
    [45, [0, 0], [0, 9.525], [3.175, -1.5875]],
    [135, [0, 0], [0, 9.525], [3.175, -1.5875]],
  ],
  // Square grid (0°/90°).
  NET: [
    [0, [0, 0], [0, 6.35], []],
    [90, [0, 0], [0, 6.35], []],
  ],
  // Sparse diagonal cross-hatch — screens, mesh.
  CROSS: [
    [45, [0, 0], [0, 12.7], []],
    [135, [0, 0], [0, 12.7], []],
  ],
  // Dot grid — sand, aggregate (zero-length dashes render as points).
  DOTS: [
    [0, [0, 0], [0, 3.175], [0.001, -3.175]],
    [90, [1.5875, 0], [0, 3.175], [0.001, -3.175]],
  ],
  // Earth / soil — heavy dashed 45° over a sparse 135° dotted family.
  EARTH: [
    [45, [0, 0], [0, 6.35], [3.81, -1.27]],
    [135, [0, 0], [0, 12.7], [0.001, -4.233]],
  ],
};

export const HATCH_PATTERN_NAMES: readonly string[] = ["SOLID", ...Object.keys(LIBRARY)];

export const DEFAULT_HATCH_PATTERN = "ANSI31";

/** True when `name` is a known pattern (SOLID included). */
export function isKnownHatchPattern(name: string): boolean {
  return HATCH_PATTERN_NAMES.includes(name.trim().toUpperCase());
}

/**
 * Pattern definition in pattern space, or null for SOLID (solid fills carry
 * no line families) and unknown names.
 */
export function patternDefinition(name: string): HatchFamilyDef[] | null {
  const raw = LIBRARY[name.trim().toUpperCase()];
  if (!raw) return null;
  return raw.map(([angleDeg, base, offset, dashes]) => ({
    angle: angleDeg * DEG,
    base: [base[0], base[1]] as [number, number],
    offset: [offset[0], offset[1]] as [number, number],
    dashes: [...dashes],
  }));
}

/**
 * DXF semantics: the hatch's own angle (degrees, CCW) rotates every family
 * about the origin and the scale multiplies all pattern coordinates
 * (bases, offsets and dash lengths) — drawing space = pattern space after
 * this transform.
 */
export function transformToDrawingSpace(
  fams: HatchFamilyDef[],
  angleDeg: number,
  scale: number,
): HatchFamilyDef[] {
  const a = (Number.isFinite(angleDeg) ? angleDeg : 0) * DEG;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const cos = Math.cos(a), sin = Math.sin(a);
  return fams.map((f) => ({
    angle: f.angle + a,
    base: [(f.base[0] * cos - f.base[1] * sin) * s, (f.base[0] * sin + f.base[1] * cos) * s] as [number, number],
    offset: [(f.offset[0] * cos - f.offset[1] * sin) * s, (f.offset[0] * sin + f.offset[1] * cos) * s] as [number, number],
    dashes: f.dashes.map((d) => d * s),
  }));
}

/** Convenience: library definition of `name` transformed by angle + scale. */
export function drawingFamilies(name: string, angleDeg = 0, scale = 1): HatchFamilyDef[] | null {
  const def = patternDefinition(name);
  return def ? transformToDrawingSpace(def, angleDeg, scale) : null;
}

/** Even-odd point-in-polygon over one loop (boundary counted as inside). */
export function pointInPolygon(pt: DxfPoint, loop: DxfPoint[]): boolean {
  if (loop.length < 3) return false;
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i].x, yi = loop[i].y, xj = loop[j].x, yj = loop[j].y;
    if (yi === yj) {
      if (Math.abs(pt.y - yi) < 1e-12 && pt.x >= Math.min(xi, xj) - 1e-12 && pt.x <= Math.max(xi, xj) + 1e-12) return true; // on edge
      continue;
    }
    if (yi > pt.y !== yj > pt.y) {
      const xCross = ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (Math.abs(pt.x - xCross) < 1e-12) return true; // on edge
      if (pt.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Signed area (CCW positive). */
export function polygonArea(loop: DxfPoint[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    a += (loop[j].x * loop[i].y - loop[i].x * loop[j].y);
  }
  return a / 2;
}
