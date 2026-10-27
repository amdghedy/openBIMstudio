/**
 * Robust per-element geometry extraction for Native Twin conversion.
 *
 * Fragments 3.x stores geometry in tile samples; getItemsGeometry is the
 * supported API. Viewport meshes often only carry userData.itemIds (not
 * classic idRanges), so traverse-based extractors frequently return null
 * even when the element is visible.
 */
import * as THREE from "three";
import type { Tri } from "../clash/geometry";

export type ExtractFailureReason =
  | "model_not_found"
  | "no_geometry_mapping"
  | "geometry_api_empty"
  | "geometry_invalid"
  | "unsupported_representation"
  | "unknown";

export interface ExtractResult {
  ok: boolean;
  tris: Tri[];
  box: THREE.Box3;
  path: string;
  reason?: ExtractFailureReason;
  detail?: string;
  meshCount?: number;
  vertexCount?: number;
  triangleCount?: number;
}

function finiteMatrixFromUnknown(input: unknown): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!input) return m.identity();
  if (input instanceof THREE.Matrix4) return m.copy(input);
  const any = input as any;
  if (any.isMatrix4 && any.elements) return m.fromArray(Array.from(any.elements));
  if (Array.isArray(any.elements) || ArrayBuffer.isView(any.elements)) {
    return m.fromArray(Array.from(any.elements as ArrayLike<number>));
  }
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    const arr = Array.from(input as ArrayLike<number>);
    if (arr.length >= 16) return m.fromArray(arr.slice(0, 16));
  }
  return m.identity();
}

function positionsUsable(positions: ArrayLike<number> | undefined | null): boolean {
  if (!positions || typeof positions.length !== "number" || positions.length < 9) return false;
  // Sample a few values — full scan happens when building triangles.
  for (let i = 0; i < Math.min(positions.length, 12); i++) {
    if (!Number.isFinite(Number(positions[i]))) return false;
  }
  return true;
}

function meshDataListFromApiResult(groups: unknown, localId: number): any[] {
  if (!groups) return [];
  // Promise already awaited by caller. Expected: MeshData[][] aligned with input ids.
  if (Array.isArray(groups)) {
    // MeshData[][] 
    if (groups.length && Array.isArray(groups[0])) {
      const flat: any[] = [];
      for (const g of groups) {
        if (Array.isArray(g)) flat.push(...g);
      }
      return flat.filter(Boolean);
    }
    // Already MeshData[]
    if (groups.length && (groups[0]?.positions || groups[0]?.transform)) {
      return groups as any[];
    }
  }
  // Rare: map keyed by localId / index
  if (typeof groups === "object") {
    const obj = groups as Record<string, any>;
    if (Array.isArray(obj[String(localId)])) return obj[String(localId)];
    if (Array.isArray(obj[localId as any])) return obj[localId as any];
    const values = Object.values(obj);
    if (values.length && Array.isArray(values[0])) {
      return (values as any[]).flat().filter(Boolean);
    }
  }
  return [];
}

function trianglesFromMeshData(
  meshes: any[],
  modelObject: any | null,
  preferModelWorld: boolean,
): { tris: Tri[]; box: THREE.Box3 } | null {
  const tris: Tri[] = [];
  const worldBox = new THREE.Box3();
  const v = new THREE.Vector3();
  const baseWorld = new THREE.Matrix4();
  try {
    modelObject?.updateMatrixWorld?.(true);
    if (modelObject?.matrixWorld) baseWorld.copy(modelObject.matrixWorld);
  } catch {
    baseWorld.identity();
  }

  for (const mesh of meshes) {
    const positions: ArrayLike<number> | undefined = mesh?.positions;
    if (!positionsUsable(positions)) continue;
    const indices: ArrayLike<number> | null = mesh.indices ?? null;
    const t = finiteMatrixFromUnknown(mesh.transform);
    const worldT = preferModelWorld ? baseWorld.clone().multiply(t) : t;
    const vertexCount = Math.floor(positions!.length / 3);

    const addTri = (i0: number, i1: number, i2: number) => {
      if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) return;
      const tri = new Float32Array(9);
      const ids = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        const vi = ids[k];
        const x = Number(positions![vi * 3]);
        const y = Number(positions![vi * 3 + 1]);
        const z = Number(positions![vi * 3 + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        v.set(x, y, z).applyMatrix4(worldT);
        if (![v.x, v.y, v.z].every(Number.isFinite)) return;
        tri[k * 3] = v.x;
        tri[k * 3 + 1] = v.y;
        tri[k * 3 + 2] = v.z;
        worldBox.expandByPoint(v);
      }
      tris.push(tri);
    };

    if (indices && indices.length >= 3) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        addTri(Number(indices[i]), Number(indices[i + 1]), Number(indices[i + 2]));
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) addTri(i, i + 1, i + 2);
    }
  }

  if (!tris.length || worldBox.isEmpty()) return null;
  return { tris, box: worldBox };
}

async function extractViaGetItemsGeometry(
  model: any,
  localId: number,
): Promise<{ meshes: any[]; path: string } | null> {
  if (typeof model?.getItemsGeometry !== "function") return null;

  const attempts: Array<{ lod?: number; label: string }> = [
    { label: "getItemsGeometry(default)" },
    { lod: 0, label: "getItemsGeometry(lod=0)" },
    { lod: 1, label: "getItemsGeometry(lod=1)" },
  ];

  for (const attempt of attempts) {
    try {
      const raw =
        attempt.lod === undefined
          ? await model.getItemsGeometry([localId])
          : await model.getItemsGeometry([localId], attempt.lod);
      const meshes = meshDataListFromApiResult(raw, localId).filter((m) =>
        positionsUsable(m?.positions),
      );
      if (meshes.length) return { meshes, path: attempt.label };
    } catch (err) {
      console.warn(`[native-twin] ${attempt.label} failed`, err);
    }
  }
  return null;
}

/**
 * Single-item tiles: if a live tile's itemIds contains only this localId (or
 * includes it and the tile is a mesh with positions), use that BufferGeometry.
 * Multi-item tiles are skipped — cannot split shared buffers safely.
 */
function extractViaSingleItemTiles(
  model: any,
  localId: number,
): { tris: Tri[]; box: THREE.Box3; path: string } | null {
  const root = model?.object;
  if (!root?.traverse) return null;

  try {
    root.updateMatrixWorld?.(true);
  } catch { /* */ }

  const tris: Tri[] = [];
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let usedMeshes = 0;

  root.traverse((obj: any) => {
    if (!obj?.isMesh || !obj.geometry?.attributes?.position) return;
    const itemIds = obj.userData?.itemIds;
    if (!itemIds) return;

    let includes = false;
    let count = 0;
    if (itemIds instanceof Uint32Array || Array.isArray(itemIds)) {
      count = itemIds.length;
      for (let i = 0; i < itemIds.length; i++) {
        if (Number(itemIds[i]) === localId) includes = true;
      }
    } else if (itemIds instanceof Set) {
      count = itemIds.size;
      includes = itemIds.has(localId);
    } else if (typeof itemIds === "object") {
      const vals = Object.values(itemIds).map(Number);
      count = vals.length;
      includes = vals.includes(localId);
    }
    // Only use exclusive single-item tiles, or tiles that only reference this id.
    if (!includes || count !== 1) return;

    const posAttr = obj.geometry.attributes.position as THREE.BufferAttribute;
    const idx = obj.geometry.index as THREE.BufferAttribute | null;
    obj.updateMatrixWorld?.(true);
    const mw = obj.matrixWorld as THREE.Matrix4;
    const vc = posAttr.count;

    const add = (i0: number, i1: number, i2: number) => {
      if (i0 >= vc || i1 >= vc || i2 >= vc) return;
      const tri = new Float32Array(9);
      for (let k = 0; k < 3; k++) {
        const vi = [i0, i1, i2][k];
        v.fromBufferAttribute(posAttr, vi).applyMatrix4(mw);
        if (![v.x, v.y, v.z].every(Number.isFinite)) return;
        tri[k * 3] = v.x;
        tri[k * 3 + 1] = v.y;
        tri[k * 3 + 2] = v.z;
        box.expandByPoint(v);
      }
      tris.push(tri);
    };

    if (idx && idx.count >= 3) {
      for (let i = 0; i + 2 < idx.count; i += 3) {
        add(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i + 2 < vc; i += 3) add(i, i + 1, i + 2);
    }
    usedMeshes++;
  });

  if (!tris.length || box.isEmpty()) return null;
  return { tris, box, path: `single-item-tiles(${usedMeshes})` };
}

async function decideApplyModelWorld(
  model: any,
  localId: number,
  meshes: any[],
): Promise<boolean> {
  // Compare local vs model-world bbox to authoritative getBoxes when available.
  try {
    if (typeof model.getBoxes !== "function") return true;
    const boxes = await model.getBoxes([localId]);
    const ref: THREE.Box3 | null =
      Array.isArray(boxes) && boxes[0]?.isBox3
        ? boxes[0]
        : boxes?.[localId]?.isBox3
          ? boxes[localId]
          : null;
    if (!ref || ref.isEmpty()) return true;

    const without = trianglesFromMeshData(meshes, model.object, false);
    const withWorld = trianglesFromMeshData(meshes, model.object, true);
    if (!without || !withWorld) return true;

    const score = (b: THREE.Box3) => {
      const c1 = b.getCenter(new THREE.Vector3());
      const c2 = ref.getCenter(new THREE.Vector3());
      return c1.distanceTo(c2) + Math.abs(b.getSize(new THREE.Vector3()).length() - ref.getSize(new THREE.Vector3()).length());
    };
    return score(withWorld.box) <= score(without.box);
  } catch {
    return true;
  }
}

/**
 * Extract world-space triangles for one Fragments localId.
 */
export async function extractElementGeometry(
  model: any,
  localId: number,
  modelId = "?",
): Promise<ExtractResult> {
  const empty = (reason: ExtractFailureReason, detail: string, path = "none"): ExtractResult => ({
    ok: false,
    tris: [],
    box: new THREE.Box3(),
    path,
    reason,
    detail,
  });

  if (!model) {
    return empty("model_not_found", `Model object missing for ${modelId}`);
  }

  // Optional: confirm API considers this id geometric.
  let hasGeomFlag: boolean | null = null;
  try {
    if (typeof model.getItemsIdsWithGeometry === "function") {
      const ids: number[] = await model.getItemsIdsWithGeometry();
      hasGeomFlag = Array.isArray(ids) && ids.includes(localId);
      if (hasGeomFlag === false) {
        console.info(
          `[native-twin] localId ${localId} not in getItemsIdsWithGeometry (${ids?.length ?? 0} geometric items)`,
        );
      }
    }
  } catch (err) {
    console.warn("[native-twin] getItemsIdsWithGeometry failed", err);
  }

  // Path A — official Fragments API
  const api = await extractViaGetItemsGeometry(model, localId);
  if (api?.meshes?.length) {
    const preferWorld = await decideApplyModelWorld(model, localId, api.meshes);
    const built = trianglesFromMeshData(api.meshes, model.object, preferWorld);
    if (built?.tris.length) {
      let vertexCount = 0;
      for (const m of api.meshes) vertexCount += Math.floor((m.positions?.length ?? 0) / 3);
      console.info(
        `[native-twin] extracted ${modelId}/${localId} via ${api.path}: ${built.tris.length} tris, ${api.meshes.length} mesh(es)`,
      );
      return {
        ok: true,
        tris: built.tris,
        box: built.box,
        path: api.path,
        meshCount: api.meshes.length,
        vertexCount,
        triangleCount: built.tris.length,
      };
    }
    console.warn(
      `[native-twin] ${modelId}/${localId}: API returned ${api.meshes.length} mesh(es) but triangle build failed`,
    );
  }

  // Path B — exclusive single-item viewport tiles (real mesh, not a box)
  const tileHit = extractViaSingleItemTiles(model, localId);
  if (tileHit?.tris.length) {
    console.info(
      `[native-twin] extracted ${modelId}/${localId} via ${tileHit.path}: ${tileHit.tris.length} tris`,
    );
    return {
      ok: true,
      tris: tileHit.tris,
      box: tileHit.box,
      path: tileHit.path,
      triangleCount: tileHit.tris.length,
    };
  }

  // Path C — clash geometry helpers (idRanges / legacy viewport encodings)
  try {
    const { getElementTrianglesExact, getElementTriangles } = await import("../clash/geometry");
    let tris = getElementTrianglesExact(model.object, localId);
    let path = "getElementTrianglesExact";
    if (!tris?.length) {
      tris = getElementTriangles(model.object, localId);
      path = "getElementTriangles";
    }
    if (tris?.length) {
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          v.set(t[k * 3], t[k * 3 + 1], t[k * 3 + 2]);
          if ([v.x, v.y, v.z].every(Number.isFinite)) box.expandByPoint(v);
        }
      }
      if (!box.isEmpty()) {
        console.info(
          `[native-twin] extracted ${modelId}/${localId} via ${path}: ${tris.length} tris`,
        );
        return {
          ok: true,
          tris,
          box,
          path,
          triangleCount: tris.length,
        };
      }
    }
  } catch (err) {
    console.warn("[native-twin] clash geometry fallback failed", err);
  }

  const reason: ExtractFailureReason =
    hasGeomFlag === false ? "no_geometry_mapping" : "geometry_api_empty";
  const detail =
    hasGeomFlag === false
      ? `Element ${localId} is not listed in getItemsIdsWithGeometry for model ${modelId}; no exclusive tile mesh and no idRanges mapping were found.`
      : `All geometry retrieval paths returned empty for ${modelId} / ${localId}. Checked getItemsGeometry, single-item tiles, and viewport idRanges.`;

  console.warn(`[native-twin] ${detail}`);
  return empty(reason, detail, "exhausted");
}

export function failureUserMessage(modelId: string, localId: number, result: ExtractResult): string {
  switch (result.reason) {
    case "model_not_found":
      return `Native Twin: source model "${modelId}" is not loaded.`;
    case "no_geometry_mapping":
      return `Native Twin: element ${localId} in ${modelId} has no geometry mapping in the loaded Fragments model (no approximate object was created).`;
    case "geometry_invalid":
      return `Native Twin: geometry for ${modelId} / ${localId} failed validation (non-finite or empty).`;
    case "unsupported_representation":
      return `Native Twin: representation for ${modelId} / ${localId} is not supported.`;
    case "geometry_api_empty":
    default:
      return `Native Twin: could not retrieve usable geometry for ${modelId} / ${localId}. ${result.detail ?? ""}`.trim();
  }
}
