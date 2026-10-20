/**
 * Annotation layer.
 *
 * Given a view id, gathers the dimensions and tags that belong to that view,
 * resolves each against the current element model, and returns the combined
 * SceneEntity[] for the annotation layer of the view's Scene2D.
 *
 * This is the single integration point between the annotation model and the
 * rendering pipeline. Call it from the view generator, and dims/tags flow
 * through the same SVG renderer as wall lines.
 */

import { getElements } from "../../features/authoring";
import type { AuthoredElement } from "../projects/types";
import { getDimensions, getTags, getNotes, getCallouts } from "./annotations";
import { resolveDimension } from "./dimension-engine";
import { resolveTag } from "./tag-engine";
import type { SceneEntity } from "./scene";
import { paperToWorld } from "./scene";

export interface AnnotationStats {
  dimensions: number;
  dimensionsInvalid: number;
  tags: number;
  tagsInvalid: number;
  notes: number;
  callouts: number;
}

export interface AnnotationLayerResult {
  entities: SceneEntity[];
  stats: AnnotationStats;
}

export function buildAnnotationLayer(
  viewId: string,
  viewScale: number,
  elements: readonly AuthoredElement[] = getElements(),
): AnnotationLayerResult {
  const entities: SceneEntity[] = [];
  const stats: AnnotationStats = {
    dimensions: 0,
    dimensionsInvalid: 0,
    tags: 0,
    tagsInvalid: 0,
    notes: 0,
    callouts: 0,
  };

  for (const dim of getDimensions(viewId)) {
    const r = resolveDimension(dim, elements, viewScale);
    if (!r.valid) {
      stats.dimensionsInvalid += 1;
      continue;
    }
    stats.dimensions += 1;
    for (const e of r.entities) entities.push(e);
  }

  for (const tag of getTags(viewId)) {
    const r = resolveTag(tag, elements, viewScale);
    if (!r.valid) {
      stats.tagsInvalid += 1;
      continue;
    }
    stats.tags += 1;
    for (const e of r.entities) entities.push(e);
  }

  for (const note of getNotes(viewId)) {
    stats.notes += 1;
    // Include leader + arrowhead data in the text entity.
    // The SVG renderer checks for these optional fields and renders
    // the leader line + arrowhead when present.
    entities.push({
      kind: "text",
      x: note.x,
      z: note.z,
      text: note.text,
      anchor: note.anchor,
      sizePt: note.sizePt,
      rotation: note.rotation,
      color: note.color,
      leader: note.leader,
      leaderTarget: note.leaderTarget,
      arrowhead: note.arrowhead,
    });
  }

  // Section callouts: render as a cut line + direction arrows + label.
  for (const callout of getCallouts(viewId)) {
    stats.callouts += 1;
    const [sx, sz] = callout.start;
    const [ex, ez] = callout.end;
    const dx = ex - sx, dz = ez - sz;
    const L = Math.hypot(dx, dz) || 1;
    // Perpendicular direction (the direction the section looks toward).
    const sign = callout.direction === "left" ? 1 : -1;
    const px = -dz / L * sign;
    const pz = dx / L * sign;

    // Cut line.
    entities.push({
      kind: "line",
      x1: sx, z1: sz, x2: ex, z2: ez,
      stroke: { color: callout.color, widthPt: 0.35, dash: null },
    });

    // Direction arrows at both ends.
    const arrowSize = paperToWorld(2.0, viewScale);
    for (const [cx, cz] of [[sx, sz], [ex, ez]] as [number, number][]) {
      const ax = cx + px * arrowSize;
      const az = cz + pz * arrowSize;
      entities.push({
        kind: "line",
        x1: cx, z1: cz, x2: ax, z2: az,
        stroke: { color: callout.color, widthPt: 0.3, dash: null },
      });
    }

    // Label text at the midpoint.
    const mx = (sx + ex) / 2 + px * paperToWorld(3, viewScale);
    const mz = (sz + ez) / 2 + pz * paperToWorld(3, viewScale);
    entities.push({
      kind: "text",
      x: mx, z: mz,
      text: `Section ${callout.label}`,
      anchor: "middle",
      sizePt: 3,
      rotation: 0,
      color: callout.color,
    });
  }

  return { entities, stats };
}