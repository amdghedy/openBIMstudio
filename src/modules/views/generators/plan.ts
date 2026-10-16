/**
 * Plan view generator — wraps the existing plan-generator.ts and adapts
 * its PlanView output to the general Scene2D format.
 */

import { generatePlanView } from "../../drawings/plan-generator";
import type { PlanView } from "../../drawings/plan-types";
import type { ViewDef } from "../types";
import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { emptyScene } from "../scene";

function stroke(color: string, widthPt: number, dash: number[] | null = null): StrokeStyle {
  return { color, widthPt, dash };
}

const STYLE = {
  cut:      stroke("#111827", 0.35, null),
  overhead: stroke("#6b7280", 0.18, [1.2, 0.8]),
  below:    stroke("#9ca3af", 0.15, [0.6, 0.8]),
  grid:     stroke("#b91c1c", 0.20, [3, 0.6, 0.6, 0.6]),
};

export async function generatePlanScene(def: ViewDef): Promise<Scene2D> {
  if (!def.plan) return emptyScene();

  const planView: PlanView = await generatePlanView({
    levelName: def.name,
    levelElevation: def.plan.levelElevation,
    cutHeight: def.plan.cutHeight,
    cutDepth: def.plan.bottomDepth,
    viewRangeTop: def.plan.topHeight,
    viewRangeBottom: def.plan.bottomDepth,
    viewDepth: def.plan.viewDepth,
    includeOverhead: true,
    includeBelow: true,
    maxSegments: 250_000,
  });

  const scene = emptyScene();
  scene.bounds = {
    minX: planView.bounds.minX,
    minZ: planView.bounds.minZ,
    maxX: planView.bounds.maxX,
    maxZ: planView.bounds.maxZ,
  };

  for (const seg of planView.segments) {
    const style = (STYLE as any)[seg.kind] ?? STYLE.cut;
    const entity: SceneEntity = {
      kind: "line", x1: seg.x1, z1: seg.z1, x2: seg.x2, z2: seg.z2, stroke: style,
    };
    if (seg.kind === "grid") scene.layers.grid.push(entity);
    else if (seg.kind === "overhead") scene.layers.overhead.push(entity);
    else if (seg.kind === "below") scene.layers.below.push(entity);
    else scene.layers.cut.push(entity);
  }

  for (const arc of planView.arcs) {
    scene.layers.cut.push({
      kind: "arc", cx: arc.cx, cz: arc.cz, r: arc.r, a0: arc.start, a1: arc.end, stroke: STYLE.cut,
    });
  }

  for (const t of planView.texts) {
    scene.layers.symbols.push({
      kind: "text",
      x: t.x, z: t.z,
      text: t.text,
      anchor: t.anchor ?? "middle",
      sizePt: (t.size ?? 0.4) * 10,
      rotation: t.rotation ?? 0,
      color: t.kind === "grid" ? "#a04a4a" : "#1a1a1a",
    });
  }

  scene.generatedAt = Date.now();
  return scene;
}