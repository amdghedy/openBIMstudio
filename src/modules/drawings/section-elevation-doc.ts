/**
 * Section & elevation documentation truth — Revit parity for cut poché,
 * openings in section, and hosted openings projected in elevation.
 *
 * Before this module a section cut face was a flat gray rectangle and a
 * door in a cut wall was invisible (the wall read as a solid band), while
 * an elevation showed no doors or windows at all. In Revit:
 *   • every cut face is filled with the element type's cut pattern (poché),
 *   • a cut through an opening shows the void (door: open passage + lintel;
 *     window: sill below, head above, glazing line between),
 *   • openings behind the cut plane project as visible outlines,
 *   • an elevation shows every hosted opening on the wall face.
 *
 * Pure module: no DOM, no ctx, no three.js — compiled and unit-tested
 * directly by tests/section-elevation-doc.test.cjs. Geometry conventions
 * mirror plan-poche.ts: spans along the host element, y relative to the
 * wall base, SceneEntity output consumed by the Scene2D renderers.
 */

import type { SceneEntity, StrokeStyle } from "../views/scene";
import { pocheStyleFor, POCHE_PATTERN_LINE, type PocheStyle } from "./plan-poche";

/* ── Hosted openings ──────────────────────────────────────────────────── */

/** Minimal shape of a hosted door/window as stored on authored elements. */
export interface HostedOpeningInput {
  type: string;
  params: {
    width?: number;
    height?: number;
    sillHeight?: number;
    offsetAlongHost?: number;
    [k: string]: unknown;
  };
}

export interface HostedOpening {
  /** u-range along the host wall, metres from wall start (clamped to 0..L). */
  u0: number;
  u1: number;
  /** Elevation range relative to the wall base (clamped to 0..H). */
  y0: number;
  y1: number;
  kind: string;
}

/** Fallbacks mirror authoring DEFAULTS (door 0.9×2.1, window 1.2×1.4 @0.9). */
const KIND_DEFAULTS: Record<string, { width: number; height: number; sill: number }> = {
  door: { width: 0.9, height: 2.1, sill: 0 },
  window: { width: 1.2, height: 1.4, sill: 0.9 },
};

/**
 * Extract clean openings from the hosted elements of one wall.
 * Mirrors authoring.openingsForWall clamps: degenerate holes (<2 cm) and
 * near-full-face holes (≥90% of both wall dimensions) are dropped.
 */
export function hostedOpeningsForWall(
  hosts: HostedOpeningInput[],
  L: number,
  H: number,
): HostedOpening[] {
  if (!(L > 0) || !(H > 0)) return [];
  const out: HostedOpening[] = [];
  for (const h of hosts) {
    if (h.type !== "door" && h.type !== "window") continue;
    const d = KIND_DEFAULTS[h.type] ?? KIND_DEFAULTS.door;
    const w = Number(h.params?.width ?? d.width);
    const height = Number(h.params?.height ?? d.height);
    const sill = Number(
      h.params?.sillHeight ?? d.sill,
    );
    const off = Number(h.params?.offsetAlongHost ?? L / 2);
    if (!Number.isFinite(w) || !Number.isFinite(height) || !Number.isFinite(sill) || !Number.isFinite(off)) continue;

    const u0 = Math.max(0, off - w / 2);
    const u1 = Math.min(L, off + w / 2);
    const y0 = Math.max(0, sill);
    const y1 = Math.min(H, sill + height);
    const holeW = u1 - u0;
    const holeH = y1 - y0;
    if (holeW < 0.02 || holeH < 0.02) continue;
    if (holeW >= L * 0.9 && holeH >= H * 0.9) continue;
    out.push({ u0, u1, y0, y1, kind: h.type });
  }
  return out;
}

/** The opening (if any) whose u-range contains the cut position. */
export function openingAt(
  openings: HostedOpening[],
  u: number,
  tol = 0.02,
): HostedOpening | null {
  for (const o of openings) {
    if (u >= o.u0 - tol && u <= o.u1 + tol) return o;
  }
  return null;
}

/**
 * Y-slices of wall material cut at the plane, given the opening (or null).
 *   no opening → the full 0..H slice
 *   door       → [head..H]            (open passage below)
 *   window     → [0..sill] + [head..H]
 * Slivers below minPiece are dropped so no zero-height rectangles emit.
 */
export function solidYSlices(
  op: HostedOpening | null,
  H: number,
  minPiece = 0.02,
): Array<[number, number]> {
  if (!op) return [[0, H]];
  const out: Array<[number, number]> = [];
  if (op.kind === "window") {
    if (op.y0 > minPiece) out.push([0, op.y0]);
  }
  if (H - op.y1 > minPiece) out.push([op.y1, H]);
  return out;
}

/* ── Section cut pieces ───────────────────────────────────────────────── */

/** Glazing line stroke (window cut shows one thin pane line). */
export const GLASS_STROKE: StrokeStyle = { color: "#7f8ea3", widthPt: 0.18, dash: null };

function rectPoly(
  x0: number, y0: number, x1: number, y1: number,
  stroke: StrokeStyle, fill?: { color: string; opacity: number },
): SceneEntity {
  return {
    kind: "polyline", closed: true,
    points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    stroke,
    ...(fill ? { fill } : {}),
  };
}

/**
 * Build the cut-layer entities for one wall / point element cut face.
 *
 *  • one outlined rect per solid y-slice,
 *  • patterned poché → hatch entity (paper-true via hatchScale),
 *    solid poché → opaque fill on the outline rect,
 *  • an opening adds reveal (jamb) lines and, for windows, a glazing line.
 */
export function cutWallPieces(o: {
  x: number;
  halfT: number;
  /** Wall base / top in section coordinates (base is usually the floor). */
  y0: number;
  y1: number;
  op: HostedOpening | null;
  style: PocheStyle;
  hatchScale: number;
  cutStyle: StrokeStyle;
}): SceneEntity[] {
  const out: SceneEntity[] = [];
  const H = o.y1 - o.y0;
  const slices = solidYSlices(o.op, H);
  const useHatch = !!o.style.pattern;

  for (const [a, b] of slices) {
    const ya = o.y0 + a;
    const yb = o.y0 + b;
    if (useHatch) {
      out.push(rectPoly(o.x - o.halfT, ya, o.x + o.halfT, yb, o.cutStyle));
      out.push({
        kind: "hatch",
        polygon: [[o.x - o.halfT, ya], [o.x + o.halfT, ya], [o.x + o.halfT, yb], [o.x - o.halfT, yb]],
        pattern: o.style.pattern as string,
        color: POCHE_PATTERN_LINE,
        scale: o.hatchScale,
      });
    } else {
      out.push(rectPoly(o.x - o.halfT, ya, o.x + o.halfT, yb, o.cutStyle, {
        color: o.style.color, opacity: 1,
      }));
    }
  }

  if (o.op) {
    const ya = o.y0 + o.op.y0;
    const yb = o.y0 + o.op.y1;
    // Reveal (jamb) lines: the void's side faces seen edge-on.
    out.push({ kind: "line", x1: o.x - o.halfT, z1: ya, x2: o.x - o.halfT, z2: yb, stroke: o.cutStyle });
    out.push({ kind: "line", x1: o.x + o.halfT, z1: ya, x2: o.x + o.halfT, z2: yb, stroke: o.cutStyle });
    if (o.op.kind === "window") {
      out.push({ kind: "line", x1: o.x, z1: ya, x2: o.x, z2: yb, stroke: GLASS_STROKE });
    }
  }
  return out;
}

/* ── Section projection ───────────────────────────────────────────────── */

/** Top of one cut rect: x-range + top elevation (for silhouette tests). */
export interface CutTop { x0: number; x1: number; top: number }

/**
 * The projected (behind-the-cut) wall's top edge, emitted segment-wise:
 * the edge shows wherever no cut rect at least as tall covers it, and is
 * suppressed inside cut poché (a spurious horizontal line inside a taller
 * cut wall is worse than no line). A same-height cut wall in front of part
 * of the back wall therefore yields the two poking-out side segments.
 */
export function projectedTopEdge(
  x0: number, x1: number, yTop: number,
  cutTops: CutTop[],
  stroke: StrokeStyle,
  tol = 1e-6,
): SceneEntity[] {
  // Covered x-intervals: cut rects at least as tall as this wall's top.
  const covered: Array<[number, number]> = [];
  for (const c of cutTops) {
    if (c.top + tol < yTop) continue;
    const a = Math.max(x0, c.x0);
    const b = Math.min(x1, c.x1);
    if (a < b - 0.01) covered.push([a, b]);
  }
  if (!covered.length) {
    return [{ kind: "line", x1: x0, z1: yTop, x2: x1, z2: yTop, stroke }];
  }
  covered.sort((p, q) => p[0] - q[0]);
  const out: SceneEntity[] = [];
  let cursor = x0;
  for (const [a, b] of covered) {
    if (a > cursor + 0.01) {
      out.push({ kind: "line", x1: cursor, z1: yTop, x2: a, z2: yTop, stroke });
    }
    cursor = Math.max(cursor, b);
  }
  if (cursor < x1 - 0.01) {
    out.push({ kind: "line", x1: cursor, z1: yTop, x2: x1, z2: yTop, stroke });
  }
  return out;
}

/**
 * Hosted openings of a projected wall (behind the cut) as outline rects in
 * the project layer — doors/windows become visible in sections even when
 * their host wall is not cut.
 */
export function projectedOpeningShapes(
  openings: HostedOpening[],
  L: number,
  wallX0: number, wallX1: number, wallY0: number,
  stroke: StrokeStyle,
): SceneEntity[] {
  if (!(L > 0)) return [];
  const out: SceneEntity[] = [];
  for (const op of openings) {
    const t0 = op.u0 / L;
    const t1 = op.u1 / L;
    const x0 = wallX0 + (wallX1 - wallX0) * t0;
    const x1 = wallX0 + (wallX1 - wallX0) * t1;
    if (Math.abs(x1 - x0) < 0.02) continue;
    out.push(rectPoly(x0, wallY0 + op.y0, x1, wallY0 + op.y1, stroke));
    if (op.kind === "window") {
      out.push({ kind: "line", x1: x0, z1: wallY0 + op.y0, x2: x1, z2: wallY0 + op.y0, stroke });
    }
  }
  return out;
}

/* ── Elevation ────────────────────────────────────────────────────────── */

/**
 * Hosted openings on an elevation-projected wall: door rects and window
 * rects with a sill line, mapped through the wall's projected u-range.
 */
export function elevationOpeningShapes(o: {
  openings: HostedOpening[];
  L: number;
  /** Projected wall x-extent and base elevation. */
  wallX0: number;
  wallX1: number;
  wallY0: number;
  outline: StrokeStyle;
  sillStroke: StrokeStyle;
}): SceneEntity[] {
  if (!(o.L > 0)) return [];
  const out: SceneEntity[] = [];
  for (const op of o.openings) {
    const t0 = op.u0 / o.L;
    const t1 = op.u1 / o.L;
    const x0 = o.wallX0 + (o.wallX1 - o.wallX0) * t0;
    const x1 = o.wallX0 + (o.wallX1 - o.wallX0) * t1;
    if (Math.abs(x1 - x0) < 0.02) continue;
    const y0 = o.wallY0 + op.y0;
    const y1 = o.wallY0 + op.y1;
    out.push(rectPoly(x0, y0, x1, y1, o.outline));
    if (op.kind === "window") {
      out.push({ kind: "line", x1: x0, z1: y0, x2: x1, z2: y0, stroke: o.sillStroke });
    }
  }
  return out;
}

/** Convenience: the poché style for an authored element's stored names. */
export function styleForNames(
  type: string, name: string | undefined,
  wallType: string | undefined, material: string | undefined,
): PocheStyle {
  return pocheStyleFor(type, name ?? "", wallType ?? "", material ?? "");
}
