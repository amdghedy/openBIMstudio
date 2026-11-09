/**
 * Architectural modeling depth — closes remaining gaps vs RVT-class walls:
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
import { expandStackedWall, validateStackedWall, type StackedWallDef } from "../wall-join/stacked-wall";

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
  registerStackedWallCommand();
  try {
    const a = auth();
    a?.getTypeDefaults?.("wall");
    a?.getTypeDefaults?.("curtain-wall");
  } catch {
    /* authoring may boot later */
  }
  (ctx.features as Any).architectureDepth = {
    wireJoinsToAuthoring,
    applyWallTypePreset,
    applyWallTypeToElement,
    applyWallTypeToElements,
    inferWallTypeId,
    listWallTypePresets,
    getWallTypePreset,
    presets: WALL_TYPE_PRESETS,
    placeStackedWall: placeStackedWallFromDef,
    version: 5,
  };
  console.log(
    "[architecture-depth] compound walls + openings, curtain systems, joins service, stacked walls wired",
  );
}

// ─── Stacked wall element (RVT "Stacked Wall") ───────────────────────────

/**
 * Validate + place a stacked wall as a contiguous member chain sharing one
 * plan location line. Members inherit their wall-type preset (layers/name)
 * when one matches, and explicit geometry (elev/height/thickness) always.
 * Returns the number of members placed; throws on invalid definitions.
 */
export async function placeStackedWallFromDef(def: StackedWallDef): Promise<number> {
  const v = validateStackedWall(def);
  if (!v.ok) {
    throw new Error("Invalid stacked wall: " + v.issues.map((i) => i.message).join("; "));
  }
  const members = expandStackedWall(def);
  // addLinearElement lives on the authoring MODULE, not in the ctx.features
  // api bag — lazy import keeps the dependency cycle-free (authoring does
  // not import architecture-depth).
  let place: Function | null = null;
  try {
    const mod: Any = await import("../../features/authoring");
    if (typeof (mod as Any).addLinearElement === "function") place = (mod as Any).addLinearElement;
  } catch { /* fall through to the bag */ }
  if (!place) {
    const a = auth();
    if (typeof (a as Any)?.addLinearElement === "function") place = (a as Any).addLinearElement.bind(a);
  }
  if (!place) {
    throw new Error("Authoring is not ready — open a model first");
  }
  const a = auth();
  let placed = 0;
  for (const m of members) {
    // Member wall type drives the next-wall defaults (layers/name) when the
    // bag exposes setTypeDefault; geometry (elev/height/thickness) is explicit.
    if (m.wallType && getWallTypePreset(m.wallType) && typeof (a as Any)?.setTypeDefault === "function") {
      applyWallTypePreset(m.wallType);
    }
    await place("wall", m.x1, m.z1, m.x2, m.z2, m.elev, { thickness: m.thickness, height: m.height });
    placed++;
  }
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: {
        message: `Stacked wall placed: ${placed} members, ${v.totalHeight.toFixed(2)} m total, ${v.lengthM.toFixed(2)} m run (vertical stack joins are detected automatically)`,
        kind: "success",
      },
    }));
  } catch { /* */ }
  return placed;
}

function registerStackedWallCommand(): void {
  void (async () => {
    try {
      const { registerCommand } = await import("../../features/command-palette");
      const { openFormModal } = await import("../../features/form-modal");
      const SAMPLE = JSON.stringify({
        start: [0, 0], end: [8, 0], baseElevation: 0, thickness: 0.3,
        members: [
          { wallType: "compound-exterior", height: 2.4 },
          { wallType: "basic-generic-200", height: 1.8, thickness: 0.2 },
        ],
      }, null, 1);
      registerCommand({
        id: "arch.stacked-wall",
        label: "Stacked Wall — Place Member Chain",
        category: "Architecture",
        run: async () => {
          const vals = await openFormModal({
            title: "Stacked Wall — Place Member Chain",
            subtitle: "One wall composed of vertical members with different types (brick base + panel above) — members share the plan line and stack contiguously",
            width: 560,
            fields: [
              { kind: "textarea", key: "json", label: "Stacked wall JSON", default: SAMPLE, hint: "start/end [x,z], baseElevation, thickness (shared default), members[{wallType (catalog id), height, thickness?}] bottom-up." },
            ],
            submitLabel: "Place",
          });
          if (!vals) return;
          let def: StackedWallDef;
          try { def = JSON.parse(String(vals.json)); } catch {
            try {
              window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Stacked wall JSON is invalid", kind: "error" } }));
            } catch { /* */ }
            return;
          }
          try {
            await placeStackedWallFromDef(def);
          } catch (err) {
            try {
              window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Stacked wall failed: ${(err as Error).message}`, kind: "error" } }));
            } catch { /* */ }
          }
        },
      });
    } catch {
      /* command palette may not be booted in headless tests */
    }
  })();
}

export { WALL_TYPE_PRESETS, getWallTypePreset, listWallTypePresets } from "./wall-types";
export type { WallTypePreset } from "./wall-types";
