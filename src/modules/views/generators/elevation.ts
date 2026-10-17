/**
 * Elevation view generator.
 *
 * Projects authored elements onto a horizontal viewing axis. Produces a
 * silhouette line drawing: each linear element becomes a rectangle outline,
 * each point element becomes a small box.
 */

import { getElements } from "../../../features/authoring";
import type { AuthoredElement } from "../../projects/types";
import type { ViewDef } from "../types";
import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { emptyScene } from "../scene";

const OUTLINE: StrokeStyle = { color: "#111827", widthPt: 0.25, dash: null };

function axisForDir(dir: string): [number, number] {
  switch (dir) {
    case "north": return [1, 0];
    case "south": return [-1, 0];
    case "east":  return [0, 1];
    case "west":  return [0, -1];
    default:      return [1, 0];
  }
}

export async function generateElevationScene(def: ViewDef): Promise<Scene2D> {
  const scene = emptyScene();
  if (!def.elevation) return scene;

  const axis = axisForDir(def.elevation.direction);
  const elements = getElements();
  const xs: number[] = [];
  const zs: number[] = [];

  for (const el of elements) {
    const shapes = projectElement(el, axis);
    if (!shapes) continue;
    for (const s of shapes) {
      scene.layers.project.push(s);
      if (s.kind === "line") { xs.push(s.x1, s.x2); zs.push(s.z1, s.z2); }
      else if (s.kind === "polyline") { for (const [x, z] of s.points) { xs.push(x); zs.push(z); } }
    }
  }

  if (xs.length) {
    scene.bounds = {
      minX: Math.min(...xs), minZ: Math.min(...zs),
      maxX: Math.max(...xs), maxZ: Math.max(...zs),
    };
  }
  scene.generatedAt = Date.now();
  return scene;
}

function projectElement(el: AuthoredElement, axis: [number, number]): SceneEntity[] | null {
  const p = el.params;
  const out: SceneEntity[] = [];

  if (p.start && p.end) {
    const uA = p.start[0] * axis[0] + p.start[1] * axis[1];
    const uB = p.end[0] * axis[0] + p.end[1] * axis[1];
    const y0 = p.elevation;
    const y1 = p.elevation + p.height;
    out.push({
      kind: "polyline", closed: true,
      points: [[uA, y0], [uB, y0], [uB, y1], [uA, y1]],
      stroke: OUTLINE,
    });
  } else if (p.point) {
    const uC = p.point[0] * axis[0] + p.point[1] * axis[1];
    const w = (p.thickness ?? 0.3) / 2;
    const y0 = p.elevation;
    const y1 = p.elevation + p.height;
    out.push({
      kind: "polyline", closed: true,
      points: [[uC - w, y0], [uC + w, y0], [uC + w, y1], [uC - w, y1]],
      stroke: OUTLINE,
    });
  } else if (p.polygon && p.polygon.length >= 3) {
    const us = p.polygon.map(([x, z]) => x * axis[0] + z * axis[1]);
    const u0 = Math.min(...us);
    const u1 = Math.max(...us);
    const y0 = p.elevation;
    const y1 = p.elevation + p.height;
    out.push({
      kind: "polyline", closed: true,
      points: [[u0, y0], [u1, y0], [u1, y1], [u0, y1]],
      stroke: OUTLINE,
    });
  }

  return out.length ? out : null;
}