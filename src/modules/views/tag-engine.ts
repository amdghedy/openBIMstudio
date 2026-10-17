/**
 * Tag engine.
 *
 * A tag is a reference + a field selector. This module reads the field from
 * the referenced element and produces a Scene2D bubble + optional leader.
 */

import type { AuthoredElement } from "../projects/types";
import { resolveReference } from "./references";
import type { Tag } from "./annotations";
import type { SceneEntity } from "./scene";
import { paperToWorld } from "./scene";

export interface ResolvedTag {
  entities: SceneEntity[];
  text: string;
  valid: boolean;
}

const TAG_COLOR = "#0f766e";

export function tagText(
  tag: Tag,
  el: AuthoredElement | null,
): string {
  if (tag.override) return tag.override;
  if (!el) return "\u2014";

  switch (tag.kind) {
    case "category": return el.name;
    case "material": return String(el.properties?.material ?? "\u2014");
    case "room": {
      const n = el.properties?.roomNumber;
      const nm = el.properties?.roomName;
      if (n && nm) return `${n} \u00B7 ${nm}`;
      if (n) return String(n);
      if (nm) return String(nm);
      return "\u2014";
    }
    case "custom": {
      const k = tag.field;
      if (!k) return "\u2014";
      return String(el.properties?.[k] ?? el.params[k as keyof typeof el.params] ?? "\u2014");
    }
  }
}

export function resolveTag(
  tag: Tag,
  elements: readonly AuthoredElement[],
  viewScale: number,
): ResolvedTag {
  const el = elements.find((e) => e.id === tag.ref.elementId) ?? null;
  const text = tagText(tag, el);

  const anchor = resolveReference(tag.ref, elements);
  if (!anchor) {
    return { entities: [], text, valid: false };
  }

  const [ax, , az] = anchor;
  const offX = paperToWorld(tag.offsetMm[0], viewScale);
  const offZ = paperToWorld(tag.offsetMm[1], viewScale);
  const tx = ax + offX;
  const tz = az + offZ;

  const entities: SceneEntity[] = [];

  if (tag.leader && tag.leaderShape !== "none") {
    entities.push({
      kind: "line",
      x1: ax, z1: az,
      x2: tx, z2: tz,
      stroke: { color: TAG_COLOR, widthPt: 0.18, dash: null },
    });
  }

  // Bubble rectangle sized by text length
  const size = paperToWorld(3.0, viewScale);
  const charW = size * 0.55;
  const w = Math.max(size, text.length * charW) + paperToWorld(2, viewScale);
  const h = size * 1.4;

  entities.push({
    kind: "polyline",
    closed: true,
    points: [
      [tx - w / 2, tz - h / 2],
      [tx + w / 2, tz - h / 2],
      [tx + w / 2, tz + h / 2],
      [tx - w / 2, tz + h / 2],
    ],
    stroke: { color: TAG_COLOR, widthPt: 0.15, dash: null },
    fill: { color: "#ecfdf5", opacity: 0.85 },
  });

  entities.push({
    kind: "text",
    x: tx, z: tz,
    text,
    anchor: "middle",
    sizePt: 3.0,
    rotation: tag.rotation,
    color: TAG_COLOR,
  });

  return { entities, text, valid: true };
}