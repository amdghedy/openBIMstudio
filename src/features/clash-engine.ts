/**
 * Clash engine (main-thread orchestrator).
 *
 * Responsibility split:
 *   • This file  — reads Fragments geometry for the requested model ids,
 *                  prefetches metadata, and delegates pair math to clash-core.
 *   • clash-core — pure math: broadphase (spatial hash) + narrowphase.
 *   • clash.worker — runs clash-core off the main thread.
 */
import * as THREE from "three";
import {
  runClashCore,
  DEFAULT_CLASH_RULES,
  CLASH_METHODS,
  type ClashCoreItem,
  type ClashMethod,
  type ClashRules,
  type ElementClash,
  type ClashProgress,
} from "../modules/clash/clash-core";
import { getElementTriangles, type Tri } from "../modules/clash/geometry";
import { getElementWorldBoxes } from "../modules/geometry/world-box";

export {
  DEFAULT_CLASH_RULES,
  CLASH_METHODS,
};
export type {
  ClashKind,
  ClashMethod,
  ClashMethodInfo,
  ClashPrecision,
  ClashRules,
  ElementClash,
  ClashItemRef,
  ClashProgress,
} from "../modules/clash/clash-core";

export interface ClashInput {
  modelId: string;
  model: any;
  allowedIds?: Set<number> | "ALL" | null;
}

export interface ClashRunOptions {
  rules?: Partial<ClashRules>;
  method?: ClashMethod;
  onProgress?: (p: ClashProgress) => void;
  signal?: { cancelled: boolean };
  allowSelfPairs?: boolean;
  verbose?: boolean;
  collectGeometry?: boolean;
}

async function prefetchMeta(
  model: any,
  ids: number[],
): Promise<Map<number, { name: string; category: string }>> {
  const out = new Map<number, { name: string; category: string }>();
  if (!ids.length) return out;

  try {
    const data = await model.getItemsData(ids, {
      attributesDefault: false,
      attributes: ["Name", "ObjectType", "Tag"],
    });
    for (let i = 0; i < ids.length; i++) {
      const d = (data as any)?.[i];
      const name = String(
        d?.Name?.value ?? d?.ObjectType?.value ?? d?.Tag?.value ?? `#${ids[i]}`,
      );
      out.set(ids[i], { name, category: "Unknown" });
    }
  } catch (err) {
    console.warn("[clash] getItemsData failed — using placeholder names", err);
    for (const id of ids) out.set(id, { name: `#${id}`, category: "Unknown" });
  }

  try {
    const cats = (await model.getItemsOfCategories([/.+/])) as Record<string, number[]>;
    for (const [cat, list] of Object.entries(cats)) {
      for (const id of list || []) {
        const e = out.get(id);
        if (e) e.category = cat;
      }
    }
  } catch { /* */ }
  return out;
}

export interface CollectedItems {
  items: ClashCoreItem[];
  groups: number[][];
  hasAllTriangles: boolean;
}

export async function collectItems(
  inputs: ClashInput[],
  opts: ClashRunOptions = {},
): Promise<CollectedItems> {
  const method: ClashMethod = opts.method ?? "hard-triangle";
  const needsTriangles =
    method === "hard-triangle" ||
    method === "convex-gjk" ||
    method === "clearance";
  const wantGeometry = needsTriangles && (opts.collectGeometry ?? true);

  const allItems: ClashCoreItem[] = [];
  const groups: number[][] = [];
  let hasAllTriangles = true;

  for (let gi = 0; gi < inputs.length; gi++) {
    const input = inputs[gi];
    const { modelId, model, allowedIds } = input;
    const group: number[] = [];

    let ids: number[] = [];
    try {
      ids = (await model.getItemsIdsWithGeometry()) as number[];
    } catch (err) {
      console.error(`[clash] model "${modelId}": getItemsIdsWithGeometry failed`, err);
      groups.push(group);
      continue;
    }
    if (!ids?.length) { groups.push(group); continue; }

    if (allowedIds && allowedIds !== "ALL") {
      ids = ids.filter((id) => (allowedIds as Set<number>).has(id));
      if (!ids.length) { groups.push(group); continue; }
    }

    const worldBoxes = await getElementWorldBoxes(model, ids, modelId);
    if (!worldBoxes.length) {
      console.warn(
        `[clash] model "${modelId}": 0 boxes for ${ids.length} id(s)`,
      );
      groups.push(group);
      continue;
    }

    const metaMap = await prefetchMeta(model, ids);

    for (const wb of worldBoxes) {
      if (opts.signal?.cancelled) {
        groups.push(group);
        return { items: allItems, groups, hasAllTriangles };
      }

      const size = new THREE.Vector3();
      wb.box.getSize(size);
      if (size.x * size.y * size.z > 1e9) continue;
      if (size.x < 1e-6 && size.y < 1e-6 && size.z < 1e-6) continue;

      const meta = metaMap.get(wb.id) ?? { name: `#${wb.id}`, category: "Unknown" };

      let tris: Tri[] | null = null;
      if (wantGeometry) {
        try {
          const extracted = getElementTriangles(model.object, wb.id);
          if (extracted && extracted.length) tris = extracted;
        } catch { /* */ }
      }
      if (wantGeometry && (!tris || !tris.length)) hasAllTriangles = false;

      const idx = allItems.length;
      group.push(idx);
      allItems.push({
        modelId,
        localId: wb.id,
        name: meta.name,
        category: meta.category,
        box: wb.box.clone(),
        tris,
      });
    }

    groups.push(group);
    console.log(`[clash] model "${modelId}": ${group.length} item(s) collected`);
  }

  return { items: allItems, groups, hasAllTriangles };
}

export async function runClashEngine(
  inputs: ClashInput[],
  opts: ClashRunOptions = {},
): Promise<ElementClash[]> {
  const rules: ClashRules = { ...DEFAULT_CLASH_RULES, ...(opts.rules ?? {}) };
  const method: ClashMethod = opts.method ?? "hard-triangle";
  const allowSelfPairs = opts.allowSelfPairs ?? true;
  const onProg = opts.onProgress ?? (() => {});

  console.log(`[clash] method="${method}" · allowSelfPairs=${allowSelfPairs} · main-thread`);

  const { items, groups } = await collectItems(inputs, opts);

  if (!items.length) {
    console.error("[clash] ABORT: no items collected");
    onProg({ phase: "done", current: 0, total: 0, found: 0 });
    return [];
  }

  return runClashCore(items, {
    rules,
    method,
    groups,
    selfPairs: allowSelfPairs,
    onProgress: onProg,
    shouldCancel: () => opts.signal?.cancelled === true,
    yield: () => new Promise<void>((r) => setTimeout(r, 0)),
  });
}
