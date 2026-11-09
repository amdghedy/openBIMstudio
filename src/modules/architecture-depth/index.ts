/**
 * Architectural modeling depth — closes remaining gaps vs Revit-class walls:
 *  - compound layer defaults + openings through every layer
 *  - curtain-wall systems from authored paths
 *  - joins service bound to live authored walls
 *  - host delete cascade already transitive (hosts/cascade)
 *
 * Pure bootstrap: no DOM beyond optional service wiring.
 */
import { getJoinsCleanupService } from "../joins-cleanup";
import { ctx } from "../../core/context";
import { WALL_TYPE_PRESETS, getWallTypePreset, listWallTypePresets, type WallTypePreset } from "./wall-types";

type Any = Record<string, any>;

function auth(): Any | null {
  try {
    return (ctx.features as Any)?.authoring ?? null;
  } catch {
    return null;
  }
}

/** Bind joins & cleanup service to authored walls / floors so autoJoin is real. */
export function wireJoinsToAuthoring(): void {
  const svc = getJoinsCleanupService();
  svc.setHandlers(
    () => {
      const a = auth();
      const els = typeof a?.getElements === "function" ? a.getElements() ?? [] : [];
      return els
        .filter((e: Any) => e && (e.type === "wall" || e.type === "curtain-wall" || e.type === "slab" || e.type === "floor"))
        .map((e: Any) => ({
          id: String(e.id),
          category: String(e.type),
          geometry: e.params,
        }));
    },
    async (aId, bId, type) => {
      const a = auth();
      if (!a) return false;
      try {
        if (typeof a.setElementProperty === "function") {
          a.setElementProperty(aId, "joinStatus", type === "none" ? "disallow" : "allow");
          a.setElementProperty(bId, "joinStatus", type === "none" ? "disallow" : "allow");
        }
        if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
        else if (typeof a.rebuild === "function") a.rebuild();
        return true;
      } catch (err) {
        console.warn("[architecture-depth] join failed", err);
        return false;
      }
    },
    async (_hostId) => {
      const a = auth();
      if (!a) return false;
      try {
        if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
        else if (typeof a.rebuild === "function") a.rebuild();
        try {
          const sync = await import("../../features/hosted-place-sync");
          (sync as Any).syncHostedPlacement?.();
        } catch {
          /* */
        }
        return true;
      } catch {
        return false;
      }
    },
  );
}


/** Apply a catalog wall type to authoring type defaults (next walls / curtain walls). */
export function applyWallTypePreset(presetId: string): WallTypePreset | null {
  const preset = getWallTypePreset(presetId);
  if (!preset) return null;
  const a = auth();
  if (!a?.setTypeDefault) return preset;
  const tool = preset.kind === "curtain" ? "curtain-wall" : "wall";
  try {
    a.setTypeDefault(tool, "params", "thickness", preset.thickness);
    a.setTypeDefault(tool, "params", "height", preset.height);
    a.setTypeDefault(tool, "root", "name", preset.name);
    if (preset.layers) a.setTypeDefault(tool, "properties", "layers", preset.layers);
    else if (preset.kind === "basic") a.setTypeDefault(tool, "properties", "layers", "");
    if (preset.kind === "curtain") {
      a.setTypeDefault(tool, "properties", "panelType", preset.panelType || "glazed");
      a.setTypeDefault(tool, "properties", "mullionProfile", preset.mullionProfile || "rect");
      a.setTypeDefault(tool, "properties", "system", "mullion-panel");
    }
    try {
      window.dispatchEvent(
        new CustomEvent("obs-toast", {
          detail: { message: `Wall type: ${preset.name}`, kind: "info" },
        }),
      );
    } catch {
      /* */
    }
  } catch (err) {
    console.warn("[architecture-depth] applyWallTypePreset failed", err);
  }
  return preset;
}

export function setupArchitectureDepth(): void {
  wireJoinsToAuthoring();
  try {
    const a = auth();
    a?.getTypeDefaults?.("wall");
    a?.getTypeDefaults?.("curtain-wall");
  } catch {
    /* authoring may boot later */
  }
  try {
    (window as any).__obsArchitectureDepth = {
      wireJoinsToAuthoring,
      applyWallTypePreset,
      listWallTypePresets,
      getWallTypePreset,
      presets: WALL_TYPE_PRESETS,
      version: 2,
    };
  } catch {
    /* */
  }
  console.log(
    "[architecture-depth] compound walls + openings, curtain systems, joins service wired",
  );
}

export { WALL_TYPE_PRESETS, getWallTypePreset, listWallTypePresets } from "./wall-types";
export type { WallTypePreset } from "./wall-types";
