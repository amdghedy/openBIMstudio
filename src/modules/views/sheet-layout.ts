/**
 * Sheet layout — transforms between scene (world metre) coordinates and
 * sheet millimeter coordinates.
 *
 * Default: content-tight fit (scene bounds fill the viewport with padding).
 * When viewport.fitMode === "scale", use the declared paper scale only
 * (legacy extent-based behaviour).
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
  fitMode: "content" | "scale";
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

function sceneExtents(scene: Scene2D): { cx: number; cz: number; w: number; h: number } | null {
  const b = scene?.bounds;
  if (!b) return null;
  const w = Number(b.maxX) - Number(b.minX);
  const h = Number(b.maxZ) - Number(b.minZ);
  if (!(w > 1e-9) || !(h > 1e-9) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return {
    cx: (Number(b.minX) + Number(b.maxX)) / 2,
    cz: (Number(b.minZ) + Number(b.maxZ)) / 2,
    w,
    h,
  };
}

export function computeViewportTransform(
  viewport: SheetViewport,
  sheet: SheetDef,
  view: ViewDef,
  scene: Scene2D,
): ViewportTransform {
  const widthMm = viewport.width;
  const heightMm = viewport.height;
  const declared = parseScale(viewport.scale, view.scale);
  const fitMode: "content" | "scale" =
    (viewport as any).fitMode === "scale" ? "scale" : "content";

  const ext = sceneExtents(scene);
  let scaleDenom = declared;
  let worldW = (widthMm * scaleDenom) / 1000;
  let worldH = (heightMm * scaleDenom) / 1000;
  let cx = 0;
  let cz = 0;

  if (ext) {
    cx = ext.cx;
    cz = ext.cz;
    if (fitMode === "content") {
      // 8% padding so edges are not clipped by the border/caption
      const pad = 1.08;
      const needW = ext.w * pad;
      const needH = ext.h * pad;
      const scaleFromW = (needW * 1000) / Math.max(widthMm, 1e-6);
      const scaleFromH = (needH * 1000) / Math.max(heightMm, 1e-6);
      scaleDenom = Math.max(scaleFromW, scaleFromH, 1);
      // Round to a readable scale (prefer whole numbers)
      if (scaleDenom >= 10) scaleDenom = Math.ceil(scaleDenom);
      else scaleDenom = Math.ceil(scaleDenom * 10) / 10;
      worldW = (widthMm * scaleDenom) / 1000;
      worldH = (heightMm * scaleDenom) / 1000;
    }
  }

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
    fitMode,
  };
}

export function formatScale(denom: number): string {
  return `1:${Math.round(denom)}`;
}

/**
 * Effective paper scale of a viewport against a concrete scene.
 *
 * Single source of truth for "which scale do annotations belong to" — the
 * live panel, the SVG composer and the PDF composer must all build their
 * annotation layer and render it at THIS value, so a 2.5 mm dimension text
 * measures 2.5 mm on paper in every output path.
 */
export function effectiveViewportScale(
  viewport: SheetViewport,
  sheet: SheetDef,
  view: ViewDef,
  scene: Scene2D,
): number {
  return computeViewportTransform(viewport, sheet, view, scene).scaleDenom;
}

/**
 * Scale-consistency invariant: on-paper millimeters of a world-meters size
 * under a viewport transform. An annotation entity built with
 * `paperToWorld(p, effectiveViewportScale(...))` must satisfy
 * `onPaperMm(world, tf) === p` — that equality is what keeps dimension text
 * and witness offsets at their declared print size at every viewport scale.
 */
export function onPaperMm(worldM: number, tf: ViewportTransform): number {
  const worldPerPaperMm = tf.viewBox.w / Math.max(tf.widthMm, 1e-9);
  return worldM / worldPerPaperMm;
}
