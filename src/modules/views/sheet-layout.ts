/**
 * Sheet layout â€” transforms between scene (world metre) coordinates and
 * sheet millimeter coordinates.
 *
 * A viewport on a sheet has an x/y/width/height in mm. The view inside it
 * is rendered at the viewport's paper scale. The world viewBox width is:
 *
 *   world_width_m = paper_width_mm * scaleDenom / 1000
 */

import type { SheetDef, SheetViewport } from "../projects/types";
import type { ViewDef } from "./types";
import type { Scene2D } from "./scene";

export interface ViewportTransform {
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  scaleDenom: number;
  viewBox: { x: number; y: number; w: number; h: number };
}

export function parseScale(s: string | number | undefined, fallback = 100): number {
  if (typeof s === "number" && Number.isFinite(s) && s > 0) return s;
  if (typeof s === "string") {
    const m = s.match(/1\s*:\s*(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
    const n = parseFloat(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export function computeViewportTransform(
  viewport: SheetViewport,
  sheet: SheetDef,
  view: ViewDef,
  scene: Scene2D,
): ViewportTransform {
  const scaleDenom = parseScale(viewport.scale, view.scale);
  const widthMm = viewport.width;
  const heightMm = viewport.height;
  const worldW = (widthMm * scaleDenom) / 1000;
  const worldH = (heightMm * scaleDenom) / 1000;

  const cx = (scene.bounds.minX + scene.bounds.maxX) / 2;
  const cz = (scene.bounds.minZ + scene.bounds.maxZ) / 2;
  const vbX = cx - worldW / 2;
  const vbY = -cz - worldH / 2;

  void sheet;
  return {
    x: viewport.x,
    y: viewport.y,
    widthMm,
    heightMm,
    scaleDenom,
    viewBox: { x: vbX, y: vbY, w: worldW, h: worldH },
  };
}

export function formatScale(denom: number): string {
  return `1:${Math.round(denom)}`;
}