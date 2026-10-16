/**
 * Dimension engine.
 *
 * A dimension in the model is a config object. This module turns it into a
 * concrete Scene2D: witness lines, dimension line, tick marks, and text.
 *
 * Every dimension references elements through the Reference system, so when
 * a wall moves the dimension re-resolves automatically. See references.ts.
 */

import type { AuthoredElement } from "../projects/types";
import { resolveReference } from "./references";
import type { Dimension, DimensionStyle } from "./annotations";
import { DEFAULT_DIM_STYLES } from "./annotations";
import type { SceneEntity } from "./scene";
import { paperToWorld } from "./scene";

export interface ResolvedDimension {
  entities: SceneEntity[];
  text: string;
  value: number;
  valid: boolean;
}

export function getDimensionStyle(dim: Dimension): DimensionStyle {
  return DEFAULT_DIM_STYLES.find((s) => s.id === dim.styleId) ?? DEFAULT_DIM_STYLES[0];
}

export function formatDimensionValue(meters: number, style: DimensionStyle): string {
  const factor = style.unit === "m" ? 1 : style.unit === "cm" ? 100 : 1000;
  const value = meters * factor;
  return value.toFixed(style.precision);
}

export function resolveDimension(
  dim: Dimension,
  elements: readonly AuthoredElement[],
  viewScale: number,
): ResolvedDimension {
  const style = getDimensionStyle(dim);
  const p1 = resolveReference(dim.ref1, elements);

  if (!p1) {
    return { entities: [], text: "?", value: 0, valid: false };
  }

  // Single-point tools
  if (dim.kind === "spot-elevation" || dim.kind === "spot-coordinate") {
    return resolveSpot(dim, p1, style, viewScale);
  }

  const p2 = dim.ref2 ? resolveReference(dim.ref2, elements) : null;
  if (!p2) {
    return { entities: [], text: "?", value: 0, valid: false };
  }

  if (dim.kind === "angular") {
    return resolveAngular(dim, p1, p2, style, viewScale);
  }
  if (dim.kind === "radial" || dim.kind === "diameter") {
    return resolveRadial(dim, p1, p2, style, viewScale);
  }
  // aligned | linear | arc share the straight-line renderer
  return resolveLinear(dim, p1, p2, style, viewScale);
}

function resolveSpot(
  dim: Dimension,
  p: [number, number, number],
  style: DimensionStyle,
  viewScale: number,
): ResolvedDimension {
  const size = paperToWorld(style.textSizePt, viewScale);
  const leaderLen = paperToWorld(12, viewScale);
  const tickR = paperToWorld(1.2, viewScale);
  const entities: SceneEntity[] = [];

  entities.push({
    kind: "circle", cx: p[0], cz: p[2], r: tickR,
    stroke: { color: style.color, widthPt: 0.18, dash: null },
  });
  entities.push({
    kind: "line",
    x1: p[0], z1: p[2],
    x2: p[0], z2: p[2] + leaderLen,
    stroke: { color: style.color, widthPt: 0.18, dash: null },
  });

  const text = dim.override
    ?? (dim.kind === "spot-elevation"
      ? `EL ${formatDimensionValue(p[1], style)}`
      : `X ${formatDimensionValue(p[0], style)}  Z ${formatDimensionValue(p[2], style)}`);

  entities.push({
    kind: "text",
    x: p[0],
    z: p[2] + leaderLen + size,
    text,
    anchor: "middle",
    sizePt: style.textSizePt,
    rotation: 0,
    color: style.color,
  });

  return { entities, text, value: dim.kind === "spot-elevation" ? p[1] : 0, valid: true };
}

function resolveAngular(
  dim: Dimension,
  p1: [number, number, number],
  p2: [number, number, number],
  style: DimensionStyle,
  viewScale: number,
): ResolvedDimension {
  const vertex = dim.vertexRef
    ? resolveReference(dim.vertexRef, [])
    : null;
  const vx = vertex ? vertex[0] : (p1[0] + p2[0]) / 2;
  const vz = vertex ? vertex[2] : (p1[2] + p2[2]) / 2;

  const a1 = Math.atan2(p1[2] - vz, p1[0] - vx);
  const a2 = Math.atan2(p2[2] - vz, p2[0] - vx);
  let deg = Math.abs((a2 - a1) * 180 / Math.PI);
  if (deg > 180) deg = 360 - deg;

  const r = paperToWorld(14, viewScale);
  const arcPath: SceneEntity = {
    kind: "arc",
    cx: vx, cz: vz, r,
    a0: a1, a1: a2,
    stroke: { color: style.color, widthPt: 0.2, dash: null },
  };
  const text = dim.override ?? `${deg.toFixed(1)}\u00B0`;
  const mid = (a1 + a2) / 2;
  const tx = vx + Math.cos(mid) * (r + paperToWorld(3, viewScale));
  const tz = vz + Math.sin(mid) * (r + paperToWorld(3, viewScale));
  const textEntity: SceneEntity = {
    kind: "text",
    x: tx, z: tz,
    text,
    anchor: "middle",
    sizePt: style.textSizePt,
    rotation: 0,
    color: style.color,
  };

  return { entities: [arcPath, textEntity], text, value: deg, valid: true };
}

function resolveRadial(
  dim: Dimension,
  p1: [number, number, number],
  p2: [number, number, number],
  style: DimensionStyle,
  viewScale: number,
): ResolvedDimension {
  const dx = p2[0] - p1[0];
  const dz = p2[2] - p1[2];
  const r = Math.hypot(dx, dz);

  const entities: SceneEntity[] = [{
    kind: "line",
    x1: p1[0], z1: p1[2],
    x2: p2[0], z2: p2[2],
    stroke: { color: style.color, widthPt: 0.2, dash: null },
  }];

  const text = dim.override ?? (dim.kind === "radial"
    ? `R ${formatDimensionValue(r, style)}`
    : `\u00D8 ${formatDimensionValue(r * 2, style)}`);

  const mx = (p1[0] + p2[0]) / 2;
  const mz = (p1[2] + p2[2]) / 2;
  entities.push({
    kind: "text",
    x: mx, z: mz + paperToWorld(3, viewScale),
    text,
    anchor: "middle",
    sizePt: style.textSizePt,
    rotation: 0,
    color: style.color,
  });

  return { entities, text, value: r, valid: true };
}

function resolveLinear(
  dim: Dimension,
  p1: [number, number, number],
  p2: [number, number, number],
  style: DimensionStyle,
  viewScale: number,
): ResolvedDimension {
  // In 2D views the cut plane is Xâ€“Z. For plan, use X and Z directly. For
  // section, the generators map (along, Y) â†’ (x, z). The dimension engine is
  // view-agnostic â€” it works on the view's 2D coordinates, so the caller is
  // expected to have already swapped the reference to view coordinates when
  // it created the dimension.

  // Force horizontal or vertical for "linear"
  let x2 = p2[0];
  let z2 = p2[2];
  if (dim.kind === "linear") {
    if (Math.abs(x2 - p1[0]) >= Math.abs(z2 - p1[2])) z2 = p1[2];
    else x2 = p1[0];
  }

  const dx = x2 - p1[0];
  const dz = z2 - p1[2];
  const L = Math.hypot(dx, dz);
  if (L < 1e-9) {
    return { entities: [], text: "?", value: 0, valid: false };
  }

  const ux = dx / L;
  const uz = dz / L;
  const nx = -uz;
  const nz = ux;
  const off = paperToWorld(dim.offsetMm, viewScale);

  const a0x = p1[0] + nx * off;
  const a0z = p1[2] + nz * off;
  const a1x = x2 + nx * off;
  const a1z = z2 + nz * off;

  const stroke = { color: style.color, widthPt: 0.2, dash: null };
  const entities: SceneEntity[] = [];

  // Witness lines from each referenced point to the dim line
  entities.push({
    kind: "line",
    x1: p1[0], z1: p1[2],
    x2: a0x, z2: a0z,
    stroke,
  });
  entities.push({
    kind: "line",
    x1: x2, z1: z2,
    x2: a1x, z2: a1z,
    stroke,
  });

  // Dimension line
  entities.push({
    kind: "line",
    x1: a0x, z1: a0z,
    x2: a1x, z2: a1z,
    stroke,
  });

  // Tick marks at each end
  const tickLen = paperToWorld(2.5, viewScale);
  for (const [px, pz] of [[a0x, a0z], [a1x, a1z]] as Array<[number, number]>) {
    const t1x = px - ux * tickLen * 0.3 - nx * tickLen;
    const t1z = pz - uz * tickLen * 0.3 - nz * tickLen;
    const t2x = px + ux * tickLen * 0.3 + nx * tickLen;
    const t2z = pz + uz * tickLen * 0.3 + nz * tickLen;
    entities.push({
      kind: "line",
      x1: t1x, z1: t1z,
      x2: t2x, z2: t2z,
      stroke: { color: style.color, widthPt: 0.25, dash: null },
    });
  }

  const text = dim.override ?? formatDimensionValue(L, style);
  const mx = (a0x + a1x) / 2 + nx * paperToWorld(2, viewScale);
  const mz = (a0z + a1z) / 2 + nz * paperToWorld(2, viewScale);
  entities.push({
    kind: "text",
    x: mx, z: mz,
    text,
    anchor: "middle",
    sizePt: style.textSizePt,
    rotation: 0,
    color: style.color,
  });

  return { entities, text, value: L, valid: true };
}