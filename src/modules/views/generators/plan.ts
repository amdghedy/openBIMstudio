/**
 * Plan view generator — wraps the existing plan-generator.ts and adapts
 * its PlanView output to the general Scene2D format.
 */

import { generatePlanView } from "../../drawings/plan-generator";
import type { PlanView } from "../../drawings/plan-types";
import { insulationBattingPoints } from "../annotate-distinctions";
import { POCHE_PATTERN_LINE } from "../../drawings/plan-poche";
import type { ViewDef } from "../types";
import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { emptyScene } from "../scene";
import { viewTemplatesStore } from "../../view-templates/view-templates-store";
import { resolveElementVisibility } from "../../view-templates/vg-apply";
import { phasesStore } from "../../phases/phases";
import { designOptionsStore } from "../../design-options/design-options";

function stroke(color: string, widthPt: number, dash: number[] | null = null): StrokeStyle {
  return { color, widthPt, dash };
}

const STYLE = {
  cut:      stroke("#111827", 0.35, null),
  overhead: stroke("#6b7280", 0.18, [1.2, 0.8]),
  below:    stroke("#9ca3af", 0.15, [0.6, 0.8]),
  grid:     stroke("#b91c1c", 0.20, [3, 0.6, 0.6, 0.6]),
};

/** Revit-style halftone: light grey, thin — the element reads as background. */
const HALFTONE_STYLE = stroke("#9ca3af", 0.15, null);

export async function generatePlanScene(def: ViewDef): Promise<Scene2D> {
  if (!def.plan) return emptyScene();

  // Per-view Visibility/Graphics: the view's effective VG (applied template
  // + local overrides) decides which elements draw and which draw halftone.
  // With no template and no local overrides this resolves to the default VG
  // (everything visible, nothing halftone), so existing views render
  // exactly as before. Phase / design-option predicates come from the real
  // stores, so the plan honours the same combined filter as the 3D bridge.
  const vg = viewTemplatesStore.getEffectiveVg(def.id, def.templateId ?? null);
  const resolved = new Map<string, { visible: boolean; halftone: boolean }>();
  const resolve = (el: { id: string; type?: string; category?: string; phaseCreated?: string | null; phaseDemolished?: string | null; designOptionId?: string | null; properties?: Record<string, unknown> }) => {
    let r = resolved.get(el.id);
    if (!r) {
      r = resolveElementVisibility(el, vg, {
        phaseVisible: (a) => phasesStore.isVisible(a),
        designOptionVisible: (id) => designOptionsStore.isVisible(id),
      });
      resolved.set(el.id, r);
    }
    return r;
  };

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
    visibility: {
      isVisible: (el) => resolve(el).visible,
      halftone: (el) => resolve(el).halftone,
    },
  });

  const scene = emptyScene();
  scene.bounds = {
    minX: planView.bounds.minX,
    minZ: planView.bounds.minZ,
    maxX: planView.bounds.maxX,
    maxZ: planView.bounds.maxZ,
  };

  // Wall poché cut-fills: patterned fills become hatch entities (paper-true
  // via the view scale), solid fills become filled polylines — both in the
  // cut layer so sheets and PDF exports inherit the Revit-style poché.
  for (const f of planView.fills ?? []) {
    if (!f.points || f.points.length < 3) continue;
    if (f.pattern && f.pattern !== "poche") {
      scene.layers.cut.push({
        kind: "hatch",
        polygon: f.points,
        pattern: f.pattern,
        color: f.halftone ? "#9ca3af" : POCHE_PATTERN_LINE,
        scale: Math.max(1, def.scale),
      });
    } else {
      scene.layers.cut.push({
        kind: "polyline",
        points: f.points,
        closed: true,
        stroke: f.halftone
          ? { color: "#9ca3af", widthPt: 0.12, dash: null }
          : { color: POCHE_PATTERN_LINE, widthPt: 0.12, dash: null },
        fill: { color: f.color, opacity: f.halftone ? 0.35 : 1 },
      });
    }
  }

  for (const seg of planView.segments) {
    const style = seg.halftone ? HALFTONE_STYLE : ((STYLE as any)[seg.kind] ?? STYLE.cut);
    // G7: insulation runs export as batting polylines, not plain lines.
    if (seg.lineStyle === "insulation") {
      const pts = insulationBattingPoints(seg.x1, seg.z1, seg.x2, seg.z2);
      const entity: SceneEntity = {
        kind: "polyline", points: pts.map((q) => [q.x, q.z] as [number, number]),
        closed: false, stroke: style,
      };
      scene.layers.cut.push(entity);
      continue;
    }
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
      kind: "arc", cx: arc.cx, cz: arc.cz, r: arc.r, a0: arc.start, a1: arc.end, stroke: arc.halftone ? HALFTONE_STYLE : STYLE.cut,
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