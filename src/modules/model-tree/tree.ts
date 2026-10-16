/**
 * Model tree data layer.
 *
 * Resolves the IFC spatial structure (Site → Building → Storey → elements)
 * from fragments, with graceful fallbacks. The refresh is debounced so the
 * SDK's internal data map is populated before we query it — the alternative
 * is a storm of "Fragments: Model not found" rejections during project load.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════
export type NodeKind = "model" | "spatial" | "category" | "element";

export interface TreeItem {
  id: string;
  kind: NodeKind;
  name: string;
  category: string;
  localId: number;
  modelId: string;
  children: TreeItem[];
  hasGeometry: boolean;
  elementCount: number;
  elevation?: number;
}

export interface ModelTree {
  modelId: string;
  modelName: string;
  root: TreeItem;
  byLocalId: Map<number, TreeItem>;
  categories: string[];
  totalElements: number;
}

let trees: ModelTree[] = [];
const listeners = new Set<() => void>();

export function onModelTreeChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* */
    }
  }
}

export function getTrees(): ModelTree[] {
  return trees;
}
export function getTree(modelId: string): ModelTree | undefined {
  return trees.find((t) => t.modelId === modelId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pretty category names
// ═══════════════════════════════════════════════════════════════════════════
const PRETTY_CAT: Record<string, string> = {
  IFCWALL: "Walls",
  IFCWALLSTANDARDCASE: "Walls",
  IFCWALLELEMENTEDCASE: "Walls",
  IFCDOOR: "Doors",
  IFCWINDOW: "Windows",
  IFCSLAB: "Slabs",
  IFCBEAM: "Beams",
  IFCCOLUMN: "Columns",
  IFCMEMBER: "Members",
  IFCPLATE: "Plates",
  IFCSTAIR: "Stairs",
  IFCSTAIRFLIGHT: "Stair flights",
  IFCRAILING: "Railings",
  IFCROOF: "Roofs",
  IFCFOOTING: "Footings",
  IFCPILE: "Piles",
  IFCFURNISHINGELEMENT: "Furniture",
  IFCFLOWTERMINAL: "Flow terminals",
  IFCFLOWSEGMENT: "Flow segments",
  IFCFLOWFITTING: "Flow fittings",
  IFCPIPESEGMENT: "Pipe segments",
  IFCPIPEFITTING: "Pipe fittings",
  IFCDUCTSEGMENT: "Duct segments",
  IFCDUCTFITTING: "Duct fittings",
  IFCSPACE: "Spaces",
  IFCCOVERING: "Coverings",
  IFCBUILDINGELEMENTPROXY: "Generic elements",
  IFCOPENINGELEMENT: "Openings",
};

function prettyCategory(cat: string): string {
  const upper = cat.toUpperCase();
  if (PRETTY_CAT[upper]) return PRETTY_CAT[upper];
  const trimmed = cat.replace(/^IFC/i, "").replace(/STANDARDCASE$/i, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Sort category keys alphabetically by their pretty name. */
function sortedCatList(iter: Iterable<string>): string[] {
  return Array.from(iter).sort((a, b) =>
    prettyCategory(a).localeCompare(prettyCategory(b)),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Element data
// ═══════════════════════════════════════════════════════════════════════════
async function readElementData(
  model: any,
  ids: number[],
  categoryMap: Map<number, string>,
): Promise<Map<number, { name: string; category: string }>> {
  const out = new Map<number, { name: string; category: string }>();
  if (!ids.length) return out;

  let raw: any[] | null = null;
  try {
    raw = await model.getItemsData(ids, {
      attributesDefault: false,
      attributes: ["Name", "ObjectType", "Tag", "PredefinedType"],
    });
  } catch {
    raw = null;
  }

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const d = (raw as any)?.[i] ?? {};
    const name =
      String(
        d?.Name?.value ?? d?.ObjectType?.value ?? d?.Tag?.value ?? "",
      ).trim() || `#${id}`;
    const cat = categoryMap.get(id) ?? "Other";
    out.set(id, { name, category: cat });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Spatial structure attempts
// ═══════════════════════════════════════════════════════════════════════════
function tryNativeSpatialStructure(model: any): any[] | null {
  try {
    const m = model as any;
    if (typeof m.getSpatialStructure === "function") {
      const r = m.getSpatialStructure();
      if (Array.isArray(r)) return r;
    }
    if (Array.isArray(m.spatialStructure)) return m.spatialStructure;
  } catch {
    /* */
  }
  return null;
}

function normalizeNativeNode(
  node: any,
  modelId: string,
  depth = 0,
): TreeItem | null {
  if (!node || typeof node !== "object") return null;

  const localId: number =
    typeof node.localId === "number"
      ? node.localId
      : typeof node.expressID === "number"
        ? node.expressID
        : typeof node.id === "number"
          ? node.id
          : 0;

  const category: string = String(
    node.category ??
      node.type ??
      node.ifcType ??
      node.objectType ??
      (depth === 0 ? "Model" : "Unknown"),
  );

  const name: string = String(
    node.name ?? node.Name ?? node.label ?? (category || `Node ${localId}`),
  );

  const childrenRaw: any[] = Array.isArray(node.children)
    ? node.children
    : Array.isArray(node.nodes)
      ? node.nodes
      : Array.isArray(node.items)
        ? node.items
        : [];

  const children: TreeItem[] = [];
  for (const c of childrenRaw) {
    const n = normalizeNativeNode(c, modelId, depth + 1);
    if (n) children.push(n);
  }

  const kind: NodeKind =
    depth === 0
      ? "model"
      : children.length
        ? "spatial"
        : localId
          ? "element"
          : "spatial";

  const elementCount = children.reduce(
    (s, c) => s + c.elementCount,
    kind === "element" ? 1 : 0,
  );

  return {
    id: `${modelId}:${localId || category}:${depth}:${name}`,
    kind,
    name,
    category,
    localId,
    modelId,
    children,
    hasGeometry: kind === "element" || elementCount > 0,
    elementCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public: build
// ═══════════════════════════════════════════════════════════════════════════
export async function buildAllTrees(): Promise<void> {
  trees = [];
  const entries = Array.from(ctx.fragments.list.entries());
  for (const [modelId, model] of entries) {
    try {
      const tree = await buildOneTree(modelId, model);
      if (tree) trees.push(tree);
    } catch (e) {
      console.warn("[model-tree] build failed for", modelId, e);
    }
  }
  notify();
}

async function buildOneTree(modelId: string, model: any): Promise<ModelTree | null> {
  let geomIds: number[] = [];
  try {
    geomIds = (await model.getItemsIdsWithGeometry()) ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Fragments\s*:?\s*Model not found/i.test(msg)) {
      console.warn(
        `[model-tree] pruning stale model "${modelId}" — worker no longer has it`,
      );
      try {
        (ctx.fragments.list as any).delete?.(modelId);
      } catch {
        /* */
      }
      return null;
    }
    console.warn("[model-tree] getItemsIdsWithGeometry failed", modelId, err);
    return null;
  }
  if (!geomIds.length) return null;

  const categoryMap = new Map<number, string>();
  try {
    const cats = await model.getItemsOfCategories([/.+/]);
    for (const [cat, list] of Object.entries(cats ?? {})) {
      for (const id of (list as number[]) || []) categoryMap.set(id, cat);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Fragments\s*:?\s*Model not found/i.test(msg)) {
      try {
        (ctx.fragments.list as any).delete?.(modelId);
      } catch {
        /* */
      }
      return null;
    }
    /* fall through — build with "Other" categories */
  }

  const modelName =
    (model as any).name || (model as any).modelName || modelId;

  const native = tryNativeSpatialStructure(model);
  if (native && native.length) {
    const rootChildren: TreeItem[] = [];
    for (const n of native) {
      const norm = normalizeNativeNode(n, modelId);
      if (norm) rootChildren.push(norm);
    }
    if (rootChildren.length) {
      let total = 0;
      const byLocalId = new Map<number, TreeItem>();
      const walk = (it: TreeItem) => {
        if (it.kind === "element" && geomIds.includes(it.localId)) {
          byLocalId.set(it.localId, it);
          total++;
        }
        for (const c of it.children) walk(c);
      };
      for (const c of rootChildren) walk(c);
      if (total > 0) {
        const root: TreeItem = {
          id: `${modelId}:root`,
          kind: "model",
          name: modelName,
          category: "Model",
          localId: 0,
          modelId,
          children: rootChildren,
          hasGeometry: true,
          elementCount: total,
        };
        const categories = Array.from(
          new Set(Array.from(byLocalId.values()).map((it) => it.category)),
        ).sort();
        return {
          modelId,
          modelName,
          root,
          byLocalId,
          categories,
          totalElements: total,
        };
      }
    }
  }

  const elemData = await readElementData(model, geomIds, categoryMap);

  const byCategory = new Map<string, TreeItem[]>();
  for (const id of geomIds) {
    const d = elemData.get(id);
    if (!d) continue;
    const item: TreeItem = {
      id: `${modelId}:${id}`,
      kind: "element",
      name: d.name,
      category: d.category,
      localId: id,
      modelId,
      children: [],
      hasGeometry: true,
      elementCount: 1,
    };
    const bucket = byCategory.get(d.category) ?? [];
    bucket.push(item);
    byCategory.set(d.category, bucket);
  }

  const rootChildren: TreeItem[] = [];
  const byLocalId = new Map<number, TreeItem>();
  const sortedCats = Array.from(byCategory.keys()).sort((a, b) =>
    prettyCategory(a).localeCompare(prettyCategory(b)),
  );

  for (const cat of sortedCats) {
    const items = byCategory.get(cat) ?? [];
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) byLocalId.set(it.localId, it);
    const catNode: TreeItem = {
      id: `${modelId}:cat:${cat}`,
      kind: "category",
      name: `${prettyCategory(cat)} (${items.length})`,
      category: cat,
      localId: 0,
      modelId,
      children: items,
      hasGeometry: true,
      elementCount: items.length,
    };
    rootChildren.push(catNode);
  }

  const root: TreeItem = {
    id: `${modelId}:root`,
    kind: "model",
    name: modelName,
    category: "Model",
    localId: 0,
    modelId,
    children: rootChildren,
    hasGeometry: true,
    elementCount: geomIds.length,
  };

  return {
    modelId,
    modelName,
    root,
    byLocalId,
    categories: sortedCatList(byCategory.keys()),
    totalElements: geomIds.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════
export interface TreeSearchHit {
  item: TreeItem;
  path: string[];
}

export function searchTree(
  tree: ModelTree,
  query: string,
  limit = 200,
): TreeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: TreeSearchHit[] = [];

  const visit = (it: TreeItem, path: string[]) => {
    if (hits.length >= limit) return;
    const name = it.name.toLowerCase();
    const cat = it.category.toLowerCase();
    if (name.includes(q) || cat.includes(q)) {
      hits.push({ item: it, path: [...path, it.name] });
      if (hits.length >= limit) return;
    }
    for (const c of it.children) visit(c, [...path, it.name]);
  };
  visit(tree.root, []);
  return hits;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers for panel
// ═══════════════════════════════════════════════════════════════════════════
export function collectLocalIds(item: TreeItem): number[] {
  if (item.kind === "element" && item.localId) return [item.localId];
  const out: number[] = [];
  const walk = (it: TreeItem) => {
    if (it.kind === "element" && it.localId) out.push(it.localId);
    for (const c of it.children) walk(c);
  };
  walk(item);
  return out;
}

export function prettyCategoryName(cat: string): string {
  return prettyCategory(cat);
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup — debounced rebuild
// ═══════════════════════════════════════════════════════════════════════════
export function setupModelTree() {
  // Same race as the clash panel: list.onItemSet fires before the SDK's
  // internal data map is populated. Debounce to avoid "Model not found".
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRebuild = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void buildAllTrees().catch(() => {
        /* swallowed */
      });
    }, 400);
  };

  ctx.fragments.list.onItemSet.add(scheduleRebuild);
  ctx.fragments.list.onItemDeleted.add(scheduleRebuild);

  ctx.features.modelTree = {
    getTrees,
    getTree,
    buildAllTrees,
    searchTree,
    collectLocalIds,
  };
}