/**
 * Wall cut poché for floor plans — Revit parity for "walls read as cut solids".
 *
 * In Revit, every wall cut by the plan plane is filled with its type's cut
 * pattern (solid gray by default): the poché. Without it a floor plan is a
 * wireframe sketch, not BIM documentation. This module provides the pure math
 * and the material→pattern mapping used by the plan generator (and the
 * Scene2D sheets path) to emit per-span cut-fill polygons.
 *
 * Pure module: no DOM, no ctx, no three.js — compiled and unit-tested
 * directly by tests/plan-poche.test.cjs.
 *
 * Coordinates are world XZ metres (plan screen flips z at render time).
 * Spans are measured along the wall length, exactly like the generator's
 * `emitSides` — fill spans and outline segments therefore always align.
 */

export interface PochePoint {
  x: number;
  z: number;
}

/** Mitered end faces of a linear element (from linear-join mitreEndFaces). */
export interface PocheFaces {
  startLeft: PochePoint;
  startRight: PochePoint;
  endLeft: PochePoint;
  endRight: PochePoint;
}

export interface PocheSpan {
  start: number;
  end: number;
}

export interface PocheStyle {
  /** Hatch pattern id from HATCH_PATTERNS, or null for a solid fill. */
  pattern: string | null;
  /** Background tint / solid poché color. */
  color: string;
}

/**
 * Default wall poché: Revit's generic wall cut — a light, cool gray that
 * reads as a solid cut face without shouting over annotation.
 */
export const DEFAULT_POCHE_COLOR = "#c9cfd6";

/** Cut-pattern line color on tinted patterns (Revit cut lines are near-black). */
export const POCHE_PATTERN_LINE = "#374151";

/** Tints paired with each material pattern (kept light so lines read). */
const PATTERN_TINT: Record<string, string> = {
  brick: "#e7ded6",
  concrete: "#d8d8d8",
  wood: "#e8dcc8",
  steel: "#d3d8de",
  glass: "#dceaf2",
  insulation: "#eee6d8",
  earth: "#e3ddd2",
};

/**
 * Type-based fallbacks when no material name signal exists — mirrors the
 * app's own defaultPatternForElementType convention (columns/footings are
 * concrete, structural framing steel, generic walls solid gray poché).
 */
const TYPE_DEFAULT_PATTERN: Record<string, string> = {
  column: "concrete",
  footing: "concrete",
  beam: "steel",
};

/** Merge touching / overlapping openings so spans subtract cleanly. */
export function mergeOpenings(openings: PocheSpan[]): PocheSpan[] {
  const sorted = [...openings].sort((a, b) => a.start - b.start);
  const out: PocheSpan[] = [];
  for (const o of sorted) {
    const last = out[out.length - 1];
    if (last && o.start <= last.end + 1e-9) {
      last.end = Math.max(last.end, o.end);
    } else {
      out.push({ start: o.start, end: o.end });
    }
  }
  return out;
}

/**
 * Solid spans of a wall: full length minus merged openings, clamped to
 * [0, length]. Spans shorter than `minSpan` are dropped (they would render
 * as slivers). Mirrors the generator's opening merge tolerance so fills and
 * outline segments split at the same stations.
 */
export function solidSpans(
  length: number,
  openings: PocheSpan[],
  minSpan = 0.02,
): PocheSpan[] {
  const spans: PocheSpan[] = [];
  let cursor = 0;
  for (const o of mergeOpenings(openings)) {
    const s = Math.min(Math.max(o.start, 0), length);
    const e = Math.min(Math.max(o.end, 0), length);
    if (s - cursor >= minSpan) spans.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (length - cursor >= minSpan) spans.push({ start: cursor, end: length });
  return spans;
}

/**
 * Cut-face quad for one solid span, lerped between the mitered end faces —
 * exactly the interpolation `emitSides` uses for the outline, so the fill
 * sits flush under its outline segments even at joined (mitred) corners.
 */
export function spanQuad(
  faces: PocheFaces,
  length: number,
  span: PocheSpan,
): Array<[number, number]> {
  const t0 = length > 0 ? span.start / length : 0;
  const t1 = length > 0 ? span.end / length : 0;
  const lerp = (a: PochePoint, b: PochePoint, t: number): PochePoint => ({
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
  });
  const l1 = lerp(faces.startLeft, faces.endLeft, t0);
  const l2 = lerp(faces.startLeft, faces.endLeft, t1);
  const r2 = lerp(faces.startRight, faces.endRight, t1);
  const r1 = lerp(faces.startRight, faces.endRight, t0);
  return [
    [l1.x, l1.z],
    [l2.x, l2.z],
    [r2.x, r2.z],
    [r1.x, r1.z],
  ];
}

/** Cut-face quad for point elements cut by the plan plane (columns, footings). */
export function rectQuad(
  x: number,
  z: number,
  width: number,
  depth: number,
): Array<[number, number]> {
  const hw = width / 2;
  const hd = depth / 2;
  return [
    [x - hw, z - hd],
    [x + hw, z - hd],
    [x + hw, z + hd],
    [x - hw, z + hd],
  ];
}

/**
 * Material/type-name → cut pattern mapping (Revit-like).
 *
 * Walls in this project do not always carry a formal compound structure, so
 * the pattern is derived from any naming signal available (element type,
 * wall type, material name). Unknown names fall back to the classic solid
 * gray poché — which is what Revit shows for a Generic wall anyway.
 *
 * Pattern ids must exist in modules/views/hatch-patterns.ts HATCH_PATTERNS:
 * concrete, brick, earth, steel, wood, insulation, sand, glass, poche.
 */
export function pocheStyleFor(...names: Array<string | undefined | null>): PocheStyle {
  const clean = names.filter((n) => typeof n === "string" && n.length > 0) as string[];
  const hay = clean.join(" ").toLowerCase();
  if (/mason|brick|block\b|clay|tile/.test(hay)) {
    return { pattern: "brick", color: PATTERN_TINT.brick };
  }
  if (/concrete|cement|\brc\b|reinforc|precast/.test(hay)) {
    return { pattern: "concrete", color: PATTERN_TINT.concrete };
  }
  if (/wood|timber|stud\b|frame\b|clt|glulam|plywood/.test(hay)) {
    return { pattern: "wood", color: PATTERN_TINT.wood };
  }
  if (/steel|metal|alum|cast.?iron/.test(hay)) {
    return { pattern: "steel", color: PATTERN_TINT.steel };
  }
  if (/glass|curtain.?wall/.test(hay)) {
    return { pattern: "glass", color: PATTERN_TINT.glass };
  }
  if (/insulat/.test(hay)) {
    return { pattern: "insulation", color: PATTERN_TINT.insulation };
  }
  if (/earth|soil|gravel|sand/.test(hay)) {
    return { pattern: "earth", color: PATTERN_TINT.earth };
  }
  // Type fallback (first argument is expected to be the element type)
  const typeDefault = clean.length ? TYPE_DEFAULT_PATTERN[clean[0]] : undefined;
  if (typeDefault) {
    return { pattern: typeDefault, color: PATTERN_TINT[typeDefault] };
  }
  return { pattern: null, color: DEFAULT_POCHE_COLOR };
}
