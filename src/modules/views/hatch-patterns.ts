/**
 * Hatch pattern library for 2D views (plans, sections, elevations).
 *
 * Provides named patterns matching common AEC / CAD conventions:
 *   - "concrete"    : diagonal cross-hatch (45/-45)
 *   - "brick"       : staggered horizontal lines (running bond)
 *   - "earth"       : dotted ground pattern
 *   - "steel"       : dense diagonal lines
 *   - "wood"        : wavy grain (approximated with sine curves)
 *   - "insulation"  : batt insulation (V-shape repeated)
 *   - "sand"        : dotted fill (loose material)
 *   - "glass"       : light diagonal lines (single direction)
 *   - "poche"       : solid fill (no pattern, just color)
 *
 * Patterns are defined in pattern-space coordinates (1 unit = 1 mm at
 * scale 1:1). The renderer scales them by the `scale` parameter on each
 * hatch entity to match the drawing scale.
 *
 * Pure module: no DOM, no three.js. The same pattern definitions feed
 * both the SVG renderer (via SVG <pattern> defs) and the PDF renderer
 * (via raw pdf-lib path operators).
 */

/** A single hatch pattern: a list of line segments in pattern space. */
export interface HatchPatternDef {
  /** Pattern id, lowercase kebab-case. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Pattern space tile size [width, height] in mm at scale 1:1. */
  tile: [number, number];
  /** Line segments, each as [x0, y0, x1, y1] in tile-local coords. */
  segments: Array<[number, number, number, number]>;
  /** Optional dots, each as [x, y, radius] in tile-local coords. */
  dots?: Array<[number, number, number]>;
  /** Default stroke width in pt at scale 1:1. */
  strokeWidth: number;
}

/**
 * Library of named hatch patterns. Keys are the `pattern` field on
 * `SceneEntity` hatch entities.
 *
 * Coordinates are in mm in pattern-space. The pattern tiles to fill
 * any polygon area.
 */
export const HATCH_PATTERNS: Record<string, HatchPatternDef> = {
  concrete: {
    id: "concrete",
    name: "Concrete",
    tile: [8, 8],
    strokeWidth: 0.18,
    segments: [
      [0, 0, 8, 8],    // 45-degree diagonal
      [0, 8, 8, 0],    // -45-degree diagonal
    ],
  },
  brick: {
    id: "brick",
    name: "Brick (running bond)",
    tile: [20, 12],
    strokeWidth: 0.18,
    segments: [
      // Top row brick face
      [0, 6, 20, 6],
      // Vertical mortar joints - staggered every row
      [0, 0, 0, 6],
      [10, 6, 10, 12],
      [20, 0, 20, 6],
    ],
  },
  earth: {
    id: "earth",
    name: "Earth / soil",
    tile: [10, 10],
    strokeWidth: 0.18,
    segments: [
      // Short diagonal strokes representing soil
      [1, 1, 4, 4],
      [5, 5, 8, 8],
      [2, 7, 4, 9],
      [6, 2, 8, 4],
    ],
    dots: [
      [3, 3, 0.3],
      [7, 7, 0.3],
      [5, 1, 0.3],
    ],
  },
  steel: {
    id: "steel",
    name: "Steel",
    tile: [4, 4],
    strokeWidth: 0.2,
    segments: [
      // Dense diagonal lines
      [0, 0, 4, 4],
      [0, 4, 4, 0],
    ],
  },
  wood: {
    id: "wood",
    name: "Wood (section)",
    tile: [10, 4],
    strokeWidth: 0.15,
    segments: [
      // Horizontal grain lines
      [0, 1, 10, 1],
      [0, 3, 10, 3],
      // Annual ring marks
      [2, 0, 2, 4],
      [7, 0, 7, 4],
    ],
  },
  insulation: {
    id: "insulation",
    name: "Batt insulation",
    tile: [10, 6],
    strokeWidth: 0.2,
    segments: [
      // V-shape pattern (batt insulation)
      [0, 0, 5, 6],
      [5, 6, 10, 0],
      [10, 0, 15, 6],
      [15, 6, 20, 0],
    ],
  },
  sand: {
    id: "sand",
    name: "Sand / aggregate",
    tile: [6, 6],
    strokeWidth: 0.15,
    segments: [],
    dots: [
      [1, 1, 0.4],
      [4, 2, 0.4],
      [2, 4, 0.4],
      [5, 5, 0.4],
    ],
  },
  glass: {
    id: "glass",
    name: "Glass",
    tile: [6, 6],
    strokeWidth: 0.15,
    segments: [
      // Light diagonal lines
      [0, 0, 6, 6],
    ],
  },
  poche: {
    id: "poche",
    name: "Solid poche",
    tile: [1, 1],
    strokeWidth: 0,
    // No segments - solid fill via fill color, no hatching lines.
    segments: [],
  },
};

/** Get a pattern definition by id. Returns null for unknown patterns. */
export function getPattern(id: string): HatchPatternDef | null {
  return HATCH_PATTERNS[id] ?? null;
}

/** List all available pattern ids. */
export function listPatterns(): string[] {
  return Object.keys(HATCH_PATTERNS);
}

/**
 * Generate line segments to tile a pattern inside a polygon bounding box.
 *
 * @param patternId - the pattern id (e.g. "concrete", "brick")
 * @param polygon - the polygon to fill (array of [x, z] points in world coords)
 * @param scale - scale factor (1 = paper 1:1, 100 = paper 1:100)
 * @returns - array of line segments in world coords, ready to render
 */
export function generateHatchLines(
  patternId: string,
  polygon: Array<[number, number]>,
  scale: number,
): Array<{ x0: number; y0: number; x1: number; y1: number; width: number }> {
  const pattern = getPattern(patternId);
  if (!pattern || pattern.segments.length === 0) return [];

  // Compute polygon bounding box
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // Tile the pattern across the bounding box.
  // At scale 1:1, pattern tile is in mm; world coords are in metres.
  // Convert: 1 mm = 0.001 m, so multiply tile size by 0.001 * scale to
  // get world units per tile.
  const tileW = pattern.tile[0] * 0.001 * scale;
  const tileH = pattern.tile[1] * 0.001 * scale;
  if (tileW <= 0 || tileH <= 0) return [];

  const out: Array<{ x0: number; y0: number; x1: number; y1: number; width: number }> = [];

  // Tile in X and Z directions across the bounding box.
  for (let tileX = Math.floor(minX / tileW); tileX <= Math.ceil(maxX / tileW); tileX++) {
    for (let tileZ = Math.floor(minZ / tileH); tileZ <= Math.ceil(maxZ / tileH); tileZ++) {
      const originX = tileX * tileW;
      const originZ = tileZ * tileH;
      for (const seg of pattern.segments) {
        const x0 = originX + (seg[0] / pattern.tile[0]) * tileW;
        const y0 = originZ + (seg[1] / pattern.tile[1]) * tileH;
        const x1 = originX + (seg[2] / pattern.tile[0]) * tileW;
        const y1 = originZ + (seg[3] / pattern.tile[1]) * tileH;
        out.push({ x0, y0, x1, y1, width: pattern.strokeWidth });
      }
    }
  }

  return out;
}

/**
 * Generate dot positions to tile a pattern's dots inside a polygon bbox.
 *
 * @returns - array of { x, y, radius } in world coords
 */
export function generateHatchDots(
  patternId: string,
  polygon: Array<[number, number]>,
  scale: number,
): Array<{ x: number; y: number; radius: number }> {
  const pattern = getPattern(patternId);
  if (!pattern || !pattern.dots || pattern.dots.length === 0) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const tileW = pattern.tile[0] * 0.001 * scale;
  const tileH = pattern.tile[1] * 0.001 * scale;
  if (tileW <= 0 || tileH <= 0) return [];

  const out: Array<{ x: number; y: number; radius: number }> = [];

  for (let tileX = Math.floor(minX / tileW); tileX <= Math.ceil(maxX / tileW); tileX++) {
    for (let tileZ = Math.floor(minZ / tileH); tileZ <= Math.ceil(maxZ / tileH); tileZ++) {
      const originX = tileX * tileW;
      const originZ = tileZ * tileH;
      for (const dot of pattern.dots) {
        const x = originX + (dot[0] / pattern.tile[0]) * tileW;
        const y = originZ + (dot[1] / pattern.tile[1]) * tileH;
        const radius = dot[2] * 0.001 * scale; // dots are in mm too
        out.push({ x, y, radius });
      }
    }
  }

  return out;
}

/** Default pattern assignment per element type, used by the plan generator. */
export function defaultPatternForElementType(elementType: string): string {
  switch (elementType) {
    case "wall":     return "poche";       // solid fill by default
    case "column":   return "concrete";
    case "footing":  return "concrete";
    case "beam":     return "steel";
    case "slab":     return "concrete";
    case "roof":     return "poche";
    case "ceiling":  return "poche";
    case "stairs":   return "concrete";
    case "ramp":     return "concrete";
    case "duct":     return "steel";
    case "pipe":     return "steel";
    case "curtain-wall": return "glass";
    default:        return "poche";
  }
}
