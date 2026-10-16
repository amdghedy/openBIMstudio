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
import { getDimensions, getTags, getNotes } from "./annotations";
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
    entities.push({
      kind: "text",
      x: note.x,
      z: note.z,
      text: note.text,
      anchor: note.anchor,
      sizePt: note.sizePt,
      rotation: note.rotation,
      color: note.color,
    });
  }

  return { entities, stats };
}