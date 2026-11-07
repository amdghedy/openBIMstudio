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
import { getElementTriangles, getNoTriangleReason, type Tri } from "../modules/clash/geometry";
import { AUTHORED_MODEL_ID, collectAuthoredSources } from "./clash-authored";
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

import type { IdSet } from "../modules/clash/selection-plan";
export type { IdSet };

export interface ClashInput {
  modelId: string;
  model: any;
  /** Elements to read from this model (union of A and B when sides are used). */
  allowedIds?: IdSet;
  /** Which elements belong to selection A / B. Used when `ClashRunOptions.useSides` is set. */
  sideA?: IdSet;
  sideB?: IdSet;
}

/** Native (authored) elements to include, by authoring element id. */
export interface AuthoredInput {
  allowed: Set<string> | "ALL";
  sideA?: Set<string> | "ALL" | null;
  sideB?: Set<string> | "ALL" | null;
}

/** What the last run actually looked at, so a "no clashes" result can be trusted (or not). */
export interface CollectionModelReport {
  modelId: string;
  elements: number;
  tested: number;
  withTriangles: number;
  /** Tested by bounding box only (no usable triangles). */
  boxOnly: number;
  boxOnlyTooComplex: number;
  skippedNoBox: number;
  skippedHuge: number;
  skippedEmpty: number;
}
export interface CollectionReport {
  models: CollectionModelReport[];
  totalTested: number;
  totalBoxOnly: number;
  totalSkipped: number;
}
let lastReport: CollectionReport | null = null;
/** Coverage of the most recent run (null before the first run). */
export function getLastCollectionReport(): CollectionReport | null { return lastReport; }

export function sideFlag(a: IdSet | undefined, b: IdSet | undefined, id: number): number {
  const inA = a === "ALL" || (a instanceof Set && a.has(id));
  const inB = b === "ALL" || (b instanceof Set && b.has(id));
  return (inA ? 1 : 0) | (inB ? 2 : 0);
}

export interface ClashRunOptions {
  rules?: Partial<ClashRules>;
  method?: ClashMethod;
  onProgress?: (p: ClashProgress) => void;
  signal?: { cancelled: boolean };
  allowSelfPairs?: boolean;
  verbose?: boolean;
  collectGeometry?: boolean;
  /** Test only selection-A-versus-selection-B pairs (inside one model, across models, linked models, authored). */
  useSides?: boolean;
  /** Include native authored elements. */
  authored?: AuthoredInput | null;
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
  /** Per-item side flags (1 = A, 2 = B, 3 = both); present when `useSides` was requested. */
  sides?: number[];
  report: CollectionReport;
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
  const sides: number[] = [];
  const modelReports: CollectionModelReport[] = [];
  let hasAllTriangles = true;
  const finish = (): CollectedItems => {
    const report: CollectionReport = {
      models: modelReports,
      totalTested: modelReports.reduce((n, m) => n + m.tested, 0),
      totalBoxOnly: modelReports.reduce((n, m) => n + m.boxOnly, 0),
      totalSkipped: modelReports.reduce((n, m) => n + m.skippedNoBox + m.skippedHuge + m.skippedEmpty, 0),
    };
    lastReport = report;
    return { items: allItems, groups, hasAllTriangles, report, ...(opts.useSides ? { sides } : {}) };
  };

  for (let gi = 0; gi < inputs.length; gi++) {
    const input = inputs[gi];
    const { modelId, model, allowedIds } = input;
    const group: number[] = [];
    const rep: CollectionModelReport = {
      modelId, elements: 0, tested: 0, withTriangles: 0, boxOnly: 0, boxOnlyTooComplex: 0,
      skippedNoBox: 0, skippedHuge: 0, skippedEmpty: 0,
    };
    modelReports.push(rep);

    let ids: number[] = [];
    try {
      ids = (await model.getItemsIdsWithGeometry()) as number[];
    } catch (err) {
      console.error(`[clash] model "${modelId}": getItemsIdsWithGeometry failed`, err);
      groups.push(group);
      continue;
    }
    if (!ids?.length) { groups.push(group); continue; }
    rep.elements = ids.length;

    if (allowedIds && allowedIds !== "ALL") {
      ids = ids.filter((id) => (allowedIds as Set<number>).has(id));
      if (!ids.length) { groups.push(group); continue; }
    }

    const worldBoxes = await getElementWorldBoxes(model, ids, modelId);
    rep.skippedNoBox = ids.length - worldBoxes.length;
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
        return finish();
      }

      const size = new THREE.Vector3();
      wb.box.getSize(size);
      if (size.x * size.y * size.z > 1e9) { rep.skippedHuge++; continue; }
      if (size.x < 1e-6 && size.y < 1e-6 && size.z < 1e-6) { rep.skippedEmpty++; continue; }

      const meta = metaMap.get(wb.id) ?? { name: `#${wb.id}`, category: "Unknown" };

      let tris: Tri[] | null = null;
      if (wantGeometry) {
        try {
          const extracted = getElementTriangles(model.object, wb.id);
          if (extracted && extracted.length) tris = extracted;
        } catch { /* */ }
      }
      if (wantGeometry && (!tris || !tris.length)) {
        hasAllTriangles = false;
        rep.boxOnly++;
        if (getNoTriangleReason(model.object, wb.id) === "too-many") rep.boxOnlyTooComplex++;
      } else if (wantGeometry) rep.withTriangles++;
      rep.tested++;

      const idx = allItems.length;
      if (opts.useSides) sides[idx] = sideFlag(input.sideA, input.sideB, wb.id);
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

  // Native authored elements (they live outside the IFC models).
  if (opts.authored) {
    const au = opts.authored;
    const rep: CollectionModelReport = {
      modelId: AUTHORED_MODEL_ID, elements: 0, tested: 0, withTriangles: 0, boxOnly: 0, boxOnlyTooComplex: 0,
      skippedNoBox: 0, skippedHuge: 0, skippedEmpty: 0,
    };
    modelReports.push(rep);
    const group: number[] = [];
    const has = (set: Set<string> | "ALL" | null | undefined, id: string) => set === "ALL" || (set instanceof Set && set.has(id));
    for (const src of collectAuthoredSources()) {
      rep.elements++;
      if (!has(au.allowed, src.elementId)) continue;
      const idx = allItems.length;
      group.push(idx);
      if (opts.useSides) sides[idx] = (has(au.sideA, src.elementId) ? 1 : 0) | (has(au.sideB, src.elementId) ? 2 : 0);
      rep.tested++; rep.withTriangles++;
      allItems.push({
        modelId: AUTHORED_MODEL_ID, localId: src.localId, name: src.name, category: src.category,
        box: src.box, tris: wantGeometry ? src.tris : null,
      });
    }
    groups.push(group);
  }

  return finish();
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

  const { items, groups, sides } = await collectItems(inputs, opts);

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
    ...(sides ? { sides } : {}),
    onProgress: onProg,
    shouldCancel: () => opts.signal?.cancelled === true,
    yield: () => new Promise<void>((r) => setTimeout(r, 0)),
  });
}
