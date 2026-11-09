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
    a.setTypeDefault(tool, "properties", "wallTypeId", preset.id);
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


/**
 * Change the type of an already placed wall / curtain-wall element.
 * Updates thickness, layers (compound), curtain system props, and name.
 */
function mutateElementWallType(el: Any, preset: WallTypePreset): boolean {
  const isCurtain = preset.kind === "curtain";
  if (el.type !== "wall" && el.type !== "curtain-wall") return false;

  if (isCurtain) el.type = "curtain-wall";
  else el.type = "wall";

  el.params = { ...(el.params || {}) };
  el.params.thickness = preset.thickness;
  if (preset.height && !el.params.height) el.params.height = preset.height;

  el.properties = { ...(el.properties || {}) };
  el.properties.wallTypeId = preset.id;
  el.name = preset.name;
  if (preset.layers) el.properties.layers = preset.layers;
  else delete el.properties.layers;

  if (isCurtain) {
    el.properties.system = "mullion-panel";
    el.properties.panelType = preset.panelType || "glazed";
    el.properties.mullionProfile = preset.mullionProfile || "rect";
  } else {
    delete el.properties.system;
    delete el.properties.panelType;
    delete el.properties.mullionProfile;
  }
  return true;
}

function rebuildAuthoring(a: Any): void {
  try {
    if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
    else if (typeof a.rebuild === "function") a.rebuild();
    if (typeof a.markAuthoringDirty === "function") a.markAuthoringDirty();
  } catch (err) {
    console.warn("[architecture-depth] rebuild after type change failed", err);
  }
}

export function applyWallTypeToElement(elementId: string, presetId: string): boolean {
  const preset = getWallTypePreset(presetId);
  if (!preset) return false;
  const a = auth();
  if (!a?.getElements) return false;
  const els = a.getElements() as Any[];
  const el = els.find((e) => e && String(e.id) === String(elementId));
  if (!el) return false;
  if (!mutateElementWallType(el, preset)) return false;
  rebuildAuthoring(a);
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: `Type → ${preset.name}`, kind: "success" },
      }),
    );
  } catch {
    /* */
  }
  return true;
}

/** Apply one catalog type to many walls / curtain walls (single rebuild). */
export function applyWallTypeToElements(elementIds: string[], presetId: string): number {
  const preset = getWallTypePreset(presetId);
  if (!preset || !elementIds.length) return 0;
  const a = auth();
  if (!a?.getElements) return 0;
  const els = a.getElements() as Any[];
  const idSet = new Set(elementIds.map(String));
  let n = 0;
  for (const el of els) {
    if (!el || !idSet.has(String(el.id))) continue;
    if (mutateElementWallType(el, preset)) n++;
  }
  if (n > 0) {
    rebuildAuthoring(a);
    try {
      window.dispatchEvent(
        new CustomEvent("obs-toast", {
          detail: { message: `Type → ${preset.name} (${n} wall${n === 1 ? "" : "s"})`, kind: "success" },
        }),
      );
    } catch {
      /* */
    }
  }
  return n;
}

/** Infer which catalog preset best matches a placed element. */
export function inferWallTypeId(el: Any): string | null {
  if (!el) return null;
  const stored = el.properties?.wallTypeId;
  if (stored && getWallTypePreset(String(stored))) return String(stored);
  const layers = String(el.properties?.layers || "");
  const kind = el.type === "curtain-wall" ? "curtain" : layers ? "compound" : "basic";
  if (kind === "curtain") {
    const pt = String(el.properties?.panelType || "glazed");
    return pt === "solid" ? "curtain-solid" : "curtain-system";
  }
  for (const p of WALL_TYPE_PRESETS) {
    if (p.kind === "curtain") continue;
    if (p.layers && p.layers === layers) return p.id;
  }
  if (!layers) return "basic-generic-200";
  return "compound-exterior";
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
      applyWallTypeToElement,
      applyWallTypeToElements,
      inferWallTypeId,
      listWallTypePresets,
      getWallTypePreset,
      presets: WALL_TYPE_PRESETS,
      version: 4,
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
