/**
 * Scene2D â€” renderer-agnostic description of a 2D view.
 *
 * Every view generator produces a Scene2D. Every renderer consumes one.
 * Units are world metres. Stroke widths are paper points â€” converted to
 * world units by paperToWorld() at render time.
 */

export interface StrokeStyle {
  color: string;
  widthPt: number;
  dash: number[] | null;
}

export interface FillStyle {
  color: string;
  opacity: number;
}

export type SceneEntity =
  | { kind: "line"; x1: number; z1: number; x2: number; z2: number; stroke: StrokeStyle }
  | { kind: "polyline"; points: Array<[number, number]>; closed: boolean; stroke: StrokeStyle; fill?: FillStyle }
  | { kind: "arc"; cx: number; cz: number; r: number; a0: number; a1: number; stroke: StrokeStyle }
  | { kind: "circle"; cx: number; cz: number; r: number; stroke: StrokeStyle; fill?: FillStyle }
  | { kind: "text"; x: number; z: number; text: string; anchor: "start" | "middle" | "end"; sizePt: number; rotation: number; color: string }
  | { kind: "symbol"; x: number; z: number; name: string; size: number; rotation: number }
  | { kind: "hatch"; polygon: Array<[number, number]>; pattern: string; color: string; scale: number };

export interface SceneLayer {
  cut: SceneEntity[];
  project: SceneEntity[];
  overhead: SceneEntity[];
  below: SceneEntity[];
  grid: SceneEntity[];
  annotation: SceneEntity[];
  symbols: SceneEntity[];
}

export interface Scene2D {
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  layers: SceneLayer;
  generatedAt: number;
}

export function emptyScene(): Scene2D {
  return {
    bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
    layers: { cut: [], project: [], overhead: [], below: [], grid: [], annotation: [], symbols: [] },
    generatedAt: Date.now(),
  };
}

/**
 * Convert paper millimetres to world metres at a given view scale.
 *   paperToWorld(0.18, 100) === 0.018   // 0.18 mm at 1:100 = 18 mm world
 */
export function paperToWorld(paperMm: number, viewScale: number): number {
  return (paperMm / 1000) * viewScale;
}

export function worldToPaper(worldM: number, viewScale: number): number {
  return (worldM / viewScale) * 1000;
}