/**
 * MEP category coloring — pairs fittings with the segments they belong to.
 *
 * Two paths:
 *   1. Linked IFC models — matched by IFC category prefix.
 *   2. Authored elements — matched by their authored type, with fittings
 *      inheriting their parent's group.
 *
 * Called from the ribbon's MEP colors button. State is not persisted; the
 * color scheme resets on reload, which matches the "visual inspection" use.
 */
import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import { ctx } from "../core/context";

const STYLE_PREFIX = "mep-color-";

interface MepGroup {
  id: string;
  label: string;
  prefixes: string[];
  color: number;
}

const GROUPS: MepGroup[] = [
  {
    id: "supply-air",
    label: "Ductwork",
    prefixes: ["IFCDUCTSEGMENT", "IFCDUCTFITTING", "IFCDUCTSILENCER", "IFCAIRTERMINAL", "IFCAIRTERMINALBOX"],
    color: 0x38bdf8,
  },
  {
    id: "water",
    label: "Piping",
    prefixes: ["IFCPIPESEGMENT", "IFCPIPEFITTING", "IFCPIPESILENCER", "IFCVALVE", "IFCPUMP", "IFCTANK"],
    color: 0xef4444,
  },
  {
    id: "cable",
    label: "Cable tray & conduit",
    prefixes: ["IFCCABLECARRIERSEGMENT", "IFCCABLECARRIERFITTING", "IFCCONDUITSEGMENT", "IFCCONDUITFITTING", "IFCCABLESEGMENT"],
    color: 0xf59e0b,
  },
  {
    id: "fire",
    label: "Fire protection",
    prefixes: ["IFCFIRESUPPRESSIONTERMINAL", "IFCSPRINKLER"],
    color: 0xf43f5e,
  },
  {
    id: "equipment",
    label: "Equipment",
    prefixes: ["IFCFLOWMOVINGDEVICE", "IFCFLOWSTORAGEDEVICE", "IFCENERGYCONVERSIONDEVICE", "IFCUNITARYEQUIPMENT", "IFCFLOWTREATMENTDEVICE"],
    color: 0xa855f7,
  },
];

function matches(cat: string, prefixes: string[]): boolean {
  const c = cat.toUpperCase();
  for (const p of prefixes) if (c.startsWith(p.toUpperCase())) return true;
  return false;
}

/** Authored element type → MEP group id. Fittings inherit their parent. */
const AUTHORED_TYPE_GROUP: Record<string, string> = {
  duct: "supply-air",
  pipe: "water",
  "cable-tray": "cable",
  conduit: "cable",
  equipment: "equipment",
};

let applied = false;

/** Apply one color per MEP group. */
export async function applyMepColors(): Promise<void> {
  if (!ctx.highlighter) {
    console.warn("[mep] highlighter not available");
    return;
  }

  await clearMepColors();

  let totalApplied = 0;

  // ── 1. Linked IFC models — matched by IFC category prefix ──
  for (const g of GROUPS) {
    ctx.highlighter.styles.set(`${STYLE_PREFIX}${g.id}`, {
      color: new THREE.Color(g.color),
      opacity: 1,
      transparent: false,
      renderedFaces: 3,
    } as any);

    const map: Record<string, Set<number>> = {};

    for (const [modelId, model] of ctx.fragments.list) {
      let cats: Record<string, number[]>;
      try {
        cats = await (model as any).getItemsOfCategories([/.+/]);
      } catch (err) {
        console.warn(`[mep] categories failed for ${modelId}`, err);
        continue;
      }
      const ids: number[] = [];
      for (const [cat, list] of Object.entries(cats ?? {})) {
        if (!matches(cat, g.prefixes)) continue;
        for (const id of (list as number[]) ?? []) ids.push(id);
      }
      if (ids.length) map[modelId] = new Set(ids);
    }

    const count = Object.values(map).reduce((a, s) => a + s.size, 0);
    if (!count) continue;

    try {
      await ctx.highlighter.highlightByID(
        `${STYLE_PREFIX}${g.id}`,
        map as unknown as OBC.ModelIdMap,
        true,
      );
      totalApplied += count;
    } catch (err) {
      console.warn(`[mep] highlight failed for ${g.id}`, err);
    }
  }

  // ── 2. Authored elements — matched by authored type ──
  try {
    const mod = await import("./authoring");
    const authored = mod.getElements();

    for (const g of GROUPS) {
      const matchingIds: string[] = [];
      for (const el of authored) {
        const effective = el.type === "fitting"
          ? ((el.params.parentType as string | undefined) ?? "")
          : el.type;
        if (AUTHORED_TYPE_GROUP[effective] === g.id) {
          matchingIds.push(el.id);
        }
      }
      if (!matchingIds.length) continue;
      const color = "#" + new THREE.Color(g.color).getHexString();
      mod.transformElements(matchingIds, (el) => {
        el.color = color;
      });
      totalApplied += matchingIds.length;
    }
  } catch (err) {
    console.warn("[mep] authored coloring failed", err);
  }

  applied = true;
  console.log(`[mep] colored ${totalApplied} element(s) across ${GROUPS.length} group(s)`);
}

/** Remove every MEP style and clear its highlights. */
export async function clearMepColors(): Promise<void> {
  if (!ctx.highlighter) return;
  for (const g of GROUPS) {
    const name = `${STYLE_PREFIX}${g.id}`;
    try {
      await (ctx.highlighter as any).clear(name);
    } catch {
      /* */
    }
    try {
      ctx.highlighter.styles.delete(name);
    } catch {
      /* */
    }
  }
  applied = false;
}

export function isMepColoringActive(): boolean {
  return applied;
}

export async function toggleMepColors(): Promise<void> {
  if (applied) await clearMepColors();
  else await applyMepColors();
}

export function setupMepColoring(): void {
  ctx.fragments.list.onItemSet.add(() => {
    if (!applied) return;
    setTimeout(() => {
      void applyMepColors();
    }, 500);
  });

  (ctx.features as any).mepColoring = {
    apply: applyMepColors,
    clear: clearMepColors,
    toggle: toggleMepColors,
    isActive: isMepColoringActive,
  };
}