/**
 * FRAG element editing — move / rotate / scale individual model elements.
 *
 * Selection source, in order of preference:
 *   1. selection manager snapshot (if populated)
 *   2. adoptFromHighlighter() from the OBC highlighter, then snapshot
 *   3. raycast pick under the last cursor position
 *
 * This makes "Edit Selected" work whether the user clicked in the viewport,
 * picked from the model tree, or the OBC highlighter was driven by other code.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { getElementTriangles, getElementTrianglesExact, type Tri } from "../modules/clash/geometry";
import {
  extractElementGeometry,
  failureUserMessage,
} from "../modules/native-twin/geometry-extract";
import { gizmo } from "./gizmo";
import { makeDockable, type DockHandle } from "./dockable";
import { history } from "./history";
import { updateClipping } from "./camera-tools";
import { markDirty } from "../modules/projects/projects";
import { getItemMeta } from "./item-meta";
import { addNativeGeometryElement, updateNativeGeometryElement, removeElementById, getElementById, getAuthoredGroup } from "./authoring";
import { downloadNativeTwinIfc } from "../modules/export/native-twin-ifc";

/** modelId::localId keys for sources that must stay hidden while a twin exists. */
const hiddenTwinSources = new Set<string>();
function twinSourceKey(modelId: string, localId: number): string {
  return `${modelId}::${localId}`;
}


export interface FragEdit {
  id: string;
  modelId: string;
  localId: number;
  name: string;
  category: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  createdAt: number;
  updatedAt: number;
  sourceType?: "IFC" | "FRAG" | "openBIM";
  sourceFormat?: string;
  nativeId?: string;
  nativeElementId?: string;
  nativeEntity?: string;
  sourceGlobalId?: string;
  sourceEntity?: string;
  sourceModelName?: string;
  sourceTag?: string;
  predefinedType?: string;
  description?: string;
  dimensions?: {
    width: number; height: number; depth: number;
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
  objectPlacement?: number[];
  sourceData?: Record<string, unknown>;
  /** Unflattened getItemsData record for lossless archive. */
  sourceRaw?: unknown;
  propertySets?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  geometry?: { positions: number[] };
}

interface EditRuntime {
  edit: FragEdit;
  clone: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshLambertMaterial;
  originalBox: THREE.Box3;
}

const runtime = new Map<string, EditRuntime>();
const editGroup = new THREE.Group();
editGroup.name = "obs-frag-edits";
let initialized = false;
let selectedEditId: string | null = null;

const uid = () =>
  (crypto as any).randomUUID?.() ?? `fe-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function jsonSafe(value: any, depth = 0): any {
  if (depth > 12) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function") continue;
      try { out[k] = jsonSafe(v, depth + 1); } catch { out[k] = String(v); }
    }
    return out;
  }
  return String(value);
}

function scalarFrom(data: any, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data?.[key];
    const value = v?.value ?? v;
    if (value != null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) return String(value);
  }
  return undefined;
}

function flattenSourceData(data: any): {
  sourceData: Record<string, unknown>;
  propertySets?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  globalId?: string;
  entity?: string;
  tag?: string;
  predefinedType?: string;
  description?: string;
} {
  const sourceData = jsonSafe(data) as Record<string, unknown>;
  return {
    sourceData,
    propertySets: (sourceData as any).psets && typeof (sourceData as any).psets === "object" ? (sourceData as any).psets : undefined,
    quantities: (sourceData as any).qtos && typeof (sourceData as any).qtos === "object" ? (sourceData as any).qtos : undefined,
    globalId: scalarFrom(data, "GlobalId", "globalId"),
    entity: scalarFrom(data, "Entity", "Type", "ObjectType"),
    tag: scalarFrom(data, "Tag"),
    predefinedType: scalarFrom(data, "PredefinedType"),
    description: scalarFrom(data, "Description"),
  };
}

function trianglePositionsLocal(tris: Tri[], center: THREE.Vector3): number[] {
  const out = new Array<number>(tris.length * 9);
  let n = 0;
  for (const t of tris) {
    for (let k = 0; k < 9; k += 3) {
      out[n++] = t[k] - center.x;
      out[n++] = t[k + 1] - center.y;
      out[n++] = t[k + 2] - center.z;
    }
  }
  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
   Geometry extraction
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Extract the authoritative per-item geometry from the Fragments runtime.
 *
 * The previous implementation tried to reverse-engineer the rendered tile
 * meshes (idRanges / userData). That is not reliable for many valid FRAG
 * models, especially complex slabs, beams and assemblies whose render tiles
 * do not expose a simple localId -> vertex range on the Three.js mesh.
 *
 * Fragments 3.x exposes getItemsGeometry(), which is the supported API for
 * retrieving the source geometry for one or more local IDs. We use it first
 * and only fall back to the old mesh traversal when the source API returns
 * no usable geometry.
 */
async function getItemMeshData(
  model: any,
  localId: number,
): Promise<any[] | null> {
  try {
    const getter = model?.getItemsGeometry;
    if (typeof getter === "function") {
      const groups = await getter.call(model, [localId]);
      const meshes = Array.isArray(groups) ? groups[0] : null;
      if (Array.isArray(meshes) && meshes.length) {
        const usable = meshes.filter((m: any) => {
          const positions = m?.positions;
          return positions && typeof positions.length === "number" && positions.length >= 9;
        });
        if (usable.length) return usable;
      }
    }
  } catch (error) {
    console.warn("[frag-edit] Fragments getItemsGeometry failed", error);
  }
  return null;
}

async function meshDataToWorldTriangles(
  meshes: any[],
  model: any,
  localId: number,
): Promise<{ tris: Tri[]; box: THREE.Box3 } | null> {
  if (!meshes.length) return null;

  const rawBox = new THREE.Box3();
  const baseWorld = new THREE.Matrix4();
  try {
    model?.object?.updateMatrixWorld?.(true);
    baseWorld.copy(model?.object?.matrixWorld ?? new THREE.Matrix4());
  } catch {
    baseWorld.identity();
  }

  // First extract in model space using each MeshData.transform. This is the
  // coordinate system exposed by the Fragments geometry API.
  const localPoints: THREE.Vector3[] = [];
  const localMatrices: THREE.Matrix4[] = [];
  for (const mesh of meshes) {
    const positions: ArrayLike<number> = mesh.positions;
    if (!positions || positions.length < 9) continue;
    const t = mesh.transform instanceof THREE.Matrix4
      ? mesh.transform.clone()
      : new THREE.Matrix4().fromArray(Array.from(mesh.transform ?? new THREE.Matrix4().toArray()));
    localMatrices.push(t);
    const limit = positions.length - (positions.length % 3);
    for (let i = 0; i < limit; i += 3) {
      const v = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(t);
      localPoints.push(v);
      rawBox.expandByPoint(v);
    }
  }
  if (rawBox.isEmpty()) return null;

  // Some exporters/runtime configurations already include the model transform
  // in MeshData.transform. Compare against the authoritative Fragments item
  // box and only apply model.matrixWorld when it improves the match. This
  // prevents double-transforming linked architectural/structural models.
  let applyBaseWorld = false;
  try {
    if (typeof model?.getBoxes === "function") {
      const boxes = await model.getBoxes([localId]);
      // getBoxes may not key by the localId when MeshData omitted it; in that
      // case we skip this heuristic and keep the documented MeshData transform.
      const b = Array.isArray(boxes) && boxes[0] ? boxes[0] : null;
      if (b && !b.isEmpty()) {
        const transformed = rawBox.clone().applyMatrix4(baseWorld);
        const dRaw = transformed.getCenter(new THREE.Vector3()).distanceTo(b.getCenter(new THREE.Vector3()));
        const dLocal = rawBox.getCenter(new THREE.Vector3()).distanceTo(b.getCenter(new THREE.Vector3()));
        const sRaw = transformed.getSize(new THREE.Vector3());
        const sLocal = rawBox.getSize(new THREE.Vector3());
        const sBox = b.getSize(new THREE.Vector3());
        const sizeError = (a: THREE.Vector3, c: THREE.Vector3) =>
          Math.abs(a.x-c.x) + Math.abs(a.y-c.y) + Math.abs(a.z-c.z);
        applyBaseWorld = dRaw + sizeError(sRaw, sBox) * 10 < dLocal + sizeError(sLocal, sBox) * 10;
      }
    }
  } catch {
    // Keep MeshData's own transforms when box comparison isn't available.
  }

  const tris: Tri[] = [];
  const worldBox = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const positions: ArrayLike<number> = mesh.positions;
    if (!positions || positions.length < 9) continue;
    const indices: ArrayLike<number> | null = mesh.indices ?? null;
    const t = mesh.transform instanceof THREE.Matrix4
      ? mesh.transform.clone()
      : new THREE.Matrix4().fromArray(Array.from(mesh.transform ?? new THREE.Matrix4().toArray()));
    const worldT = applyBaseWorld ? baseWorld.clone().multiply(t) : t;
    const vertexCount = Math.floor(positions.length / 3);
    const addTri = (i0: number, i1: number, i2: number) => {
      if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) return;
      const tri = new Float32Array(9);
      const ids = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        const vi = ids[k];
        v.set(positions[vi*3] ?? 0, positions[vi*3+1] ?? 0, positions[vi*3+2] ?? 0).applyMatrix4(worldT);
        tri[k*3] = v.x;
        tri[k*3+1] = v.y;
        tri[k*3+2] = v.z;
        worldBox.expandByPoint(v);
      }
      tris.push(tri);
    };

    if (indices && indices.length >= 3) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        addTri(Number(indices[i]), Number(indices[i+1]), Number(indices[i+2]));
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) addTri(i, i + 1, i + 2);
    }
  }

  return tris.length && !worldBox.isEmpty() ? { tris, box: worldBox } : null;
}
function buildCenteredGeometry(tris: Tri[]): {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  box: THREE.Box3;
} | null {
  if (!tris.length) return null;

  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const x = t[k * 3], y = t[k * 3 + 1], z = t[k * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        console.warn("[frag-edit] skipping non-finite triangle vertex");
        continue;
      }
      v.set(x, y, z);
      box.expandByPoint(v);
    }
  }
  if (box.isEmpty()) return null;

  const center = box.getCenter(new THREE.Vector3());
  if (![center.x, center.y, center.z].every(Number.isFinite)) return null;

  const positions = new Float32Array(tris.length * 9);
  let write = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const x = t[k * 3], y = t[k * 3 + 1], z = t[k * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { ok = false; break; }
    }
    if (!ok) continue;
    for (let k = 0; k < 3; k++) {
      positions[write * 9 + k * 3]     = t[k * 3]     - center.x;
      positions[write * 9 + k * 3 + 1] = t[k * 3 + 1] - center.y;
      positions[write * 9 + k * 3 + 2] = t[k * 3 + 2] - center.z;
    }
    write++;
  }
  if (write === 0) return null;
  const trimmed = positions.subarray(0, write * 9);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(trimmed, 3));
  try { geo.computeVertexNormals(); } catch { /* normals optional */ }
  try { geo.computeBoundingSphere(); } catch { /* */ }
  return { geometry: geo, center, box };
}

/* ═════════════════════════════════════════════════════════════════════════
   Clone lifecycle
   ═════════════════════════════════════════════════════════════════════════ */
function makeCloneMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color: new THREE.Color("#93c5fd"),
    emissive: new THREE.Color("#0b2b4a"),
    emissiveIntensity: 0.35,
  });
}

function applyTransformToClone(rt: EditRuntime): void {
  const e = rt.edit;
  rt.clone.userData.nativeTwin = true;
  rt.clone.userData.nativeId = e.nativeId ?? e.id;
  rt.clone.userData.sourceType = e.sourceType;
  rt.clone.userData.sourceModelId = e.modelId;
  rt.clone.userData.sourceLocalId = e.localId;
  rt.clone.userData.sourceGlobalId = e.sourceGlobalId;
  rt.clone.userData.sourceEntity = e.sourceEntity ?? e.nativeEntity;
  rt.clone.userData.sourcePropertySets = e.propertySets;
  rt.clone.userData.sourceQuantities = e.quantities;
  rt.clone.userData.nativeOverrides = e.overrides;
  rt.clone.position.set(e.position[0], e.position[1], e.position[2]);
  rt.clone.quaternion.set(e.quaternion[0], e.quaternion[1], e.quaternion[2], e.quaternion[3]);
  rt.clone.scale.set(e.scale[0], e.scale[1], e.scale[2]);
  rt.clone.updateMatrixWorld(true);
  if (e.nativeElementId) {
    updateNativeGeometryElement(e.nativeElementId, {
      position: [...e.position],
      quaternion: [...e.quaternion],
      scale: [...e.scale],
    }, false);
  }
}

async function hideOriginal(modelId: string, localId: number): Promise<void> {
  try {
    hiddenTwinSources.add(twinSourceKey(modelId, localId));
    const hider: any = ctx.hider;
    const map = { [modelId]: new Set([localId]) };
    if (typeof hider.hide === "function") await hider.hide(map);
    else if (typeof hider.set === "function") await hider.set(false, map);
  } catch (e) {
    console.warn("[frag-edit] hide original failed", e);
  }
}

async function unhideOriginal(modelId: string, localId: number): Promise<void> {
  try {
    hiddenTwinSources.delete(twinSourceKey(modelId, localId));
    const hider: any = ctx.hider;
    const map = { [modelId]: new Set([localId]) };
    if (typeof hider.set === "function") await hider.set(true, map);
    else if (typeof hider.show === "function") await hider.show();
  } catch (e) {
    console.warn("[frag-edit] unhide original failed", e);
  }
}

/** Show all scene elements, then re-hide native-twin sources. */
export async function showAllPreservingTwins(): Promise<void> {
  try {
    const hider: any = ctx.hider;
    if (typeof hider.show === "function") await hider.show();
    else if (typeof hider.set === "function") await hider.set(true);
  } catch (e) {
    console.warn("[frag-edit] showAll failed", e);
  }
  // Re-hide every source that still has a living twin.
  const byModel = new Map<string, Set<number>>();
  for (const key of hiddenTwinSources) {
    const [modelId, idStr] = key.split("::");
    const localId = Number(idStr);
    if (!modelId || !Number.isFinite(localId)) continue;
    let set = byModel.get(modelId);
    if (!set) { set = new Set(); byModel.set(modelId, set); }
    set.add(localId);
  }
  if (!byModel.size) return;
  try {
    const hider: any = ctx.hider;
    const map: Record<string, Set<number>> = {};
    for (const [m, s] of byModel) map[m] = s;
    if (typeof hider.hide === "function") await hider.hide(map);
    else if (typeof hider.set === "function") await hider.set(false, map);
  } catch (e) {
    console.warn("[frag-edit] re-hide twin sources failed", e);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
export function getEdits(): FragEdit[] {
  return [...runtime.values()].map((r) => r.edit);
}
export function getEditCount(): number { return runtime.size; }
export function getSelectedEditId(): string | null { return selectedEditId; }
export function isFragEditReady(): boolean { return initialized; }

function ensureNativeElementForEdit(e: FragEdit): void {
  if (e.nativeElementId && getElementById(e.nativeElementId)) return;
  if (!e.geometry?.positions?.length) return;
  const d = e.dimensions;
  try {
    const native = addNativeGeometryElement({
      name: e.name,
      entity: e.nativeEntity || e.sourceEntity || "IfcBuildingElementProxy",
      globalId: e.sourceGlobalId,
      sourceGlobalId: e.sourceGlobalId,
      predefinedType: e.predefinedType,
      tag: e.sourceTag,
      description: e.description,
      sourceModelId: e.modelId,
      sourceLocalId: e.localId,
      sourceModelName: e.sourceModelName,
      propertySets: e.propertySets,
      quantities: e.quantities,
      positions: e.geometry.positions,
      position: [...e.position],
      quaternion: [...e.quaternion],
      scale: [...e.scale],
      dimensions: d ? { width: d.width, height: d.height, depth: d.depth } : undefined,
      sourceRawItem: e.sourceRaw ?? e.sourceData,
      geometryProvenance: {
        triangleCount: Math.floor((e.geometry?.positions?.length ?? 0) / 9),
        vertexCount: Math.floor((e.geometry?.positions?.length ?? 0) / 3),
        bounds: d ? {
          min: d.min as [number, number, number],
          max: d.max as [number, number, number],
          center: d.center as [number, number, number],
        } : undefined,
        modelMatrixWorld: e.objectPlacement,
      },
    });
    e.nativeElementId = native.id;
  } catch (error) {
    console.warn("[frag-edit] could not restore native project object", error);
  }
}

export async function beginEdit(modelId: string, localId: number): Promise<FragEdit | null> {
  for (const rt of runtime.values()) {
    if (rt.edit.modelId === modelId && rt.edit.localId === localId) return rt.edit;
  }

  const model: any = ctx.fragments.list.get(modelId);
  if (!model) { console.warn("[frag-edit] model not found:", modelId); return null; }

  let tris: Tri[] | null = null;
  let exactGeometry = false;
  let extractedBox: THREE.Box3 | null = null;

  // Multi-path extraction: Fragments getItemsGeometry → single-item tiles →
  // viewport idRanges. Never invents approximate boxes.
  const extraction = await extractElementGeometry(model, localId, modelId);
  if (extraction.ok && extraction.tris.length) {
    tris = extraction.tris;
    extractedBox = extraction.box;
    exactGeometry = true;
  }

  if (!tris || !tris.length) {
    console.warn(
      "[frag-edit] no editable geometry for element:",
      modelId,
      localId,
      extraction.reason,
      extraction.detail,
    );
    try {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: {
          message: failureUserMessage(modelId, localId, extraction),
          kind: "error",
        },
      }));
    } catch { /* */ }
    return null;
  }

  const built = buildCenteredGeometry(tris);
  if (!built) {
    try {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: {
          message: `Native Twin: geometry for ${modelId} / ${localId} failed validation after extraction.`,
          kind: "error",
        },
      }));
    } catch { /* */ }
    return null;
  }

  let name = `#${localId}`, category = "Unknown";
  try {
    const meta = await getItemMeta(model, localId);
    name = meta.name;
    category = meta.category;
  } catch { /* */ }

  let raw: any = undefined;
  try {
    const data = await (model as any).getItemsData([localId], {
      attributesDefault: true,
      psetsDefault: true,
      qtosDefault: true,
    });
    raw = data?.[0];
  } catch (e) {
    console.warn("[frag-edit] rich BIM data read failed; continuing with basic metadata", e);
  }

  const source = flattenSourceData(raw ?? {});
  const dimensionBox = extractedBox ?? built.box;
  const size = dimensionBox.getSize(new THREE.Vector3());
  // The clone geometry is centered from `built`; keep the same origin so the
  // reconstructed object does not acquire an unintended offset.
  const center = built.center.clone();
  let sourceModelName = String((model as any).name ?? modelId);
  try {
    const project = (ctx.features as any).projects?.getCurrentProject?.();
    const meta = project?.models?.find?.((m: any) => m.id === modelId);
    if (meta?.name) sourceModelName = String(meta.name);
  } catch { /* project metadata is optional */ }
  const sourceFormat = /\.(ifc|ifczip)$/i.test(sourceModelName) ? "IFC" : /\.frag$/i.test(sourceModelName) ? "FRAG" : "openBIM";
  const objectPlacement = Array.isArray((model as any)?.object?.matrixWorld?.elements)
    ? [...(model as any).object.matrixWorld.elements] : undefined;

  const material = makeCloneMaterial();
  const clone = new THREE.Mesh(built.geometry, material);
  clone.userData.fragEdit = true;
  clone.position.copy(built.center);
  clone.renderOrder = 1;

  const edit: FragEdit = {
    id: uid(),
    modelId,
    localId,
    name,
    category,
    position: [center.x, center.y, center.z],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceType: sourceFormat === "IFC" ? "IFC" : sourceFormat === "FRAG" ? "FRAG" : "openBIM",
    sourceFormat,
    nativeId: uid(),
    nativeEntity: source.entity ?? "IfcBuildingElementProxy",
    sourceGlobalId: source.globalId,
    sourceEntity: source.entity,
    sourceModelName,
    sourceTag: source.tag,
    predefinedType: source.predefinedType,
    description: source.description,
    objectPlacement,
    dimensions: {
      width: size.x, height: size.y, depth: size.z,
      min: [dimensionBox.min.x, dimensionBox.min.y, dimensionBox.min.z],
      max: [dimensionBox.max.x, dimensionBox.max.y, dimensionBox.max.z],
      center: [center.x, center.y, center.z],
    },
    sourceData: source.sourceData,
    sourceRaw: raw,
    propertySets: source.propertySets,
    quantities: source.quantities,
    overrides: {},
    geometry: { positions: trianglePositionsLocal(tris, center) },
  };

  const rt: EditRuntime = {
    edit, clone,
    geometry: built.geometry,
    material,
    originalBox: built.box.clone(),
  };

  // Promote the reconstructed geometry into the real authored project model.
  // The runtime mesh remains only as the exact edit/cache representation.
  // Commit in controlled stages so a failure cannot black out the viewport.
  // 1) Register native authored element (incremental mesh — no full scene wipe).
  // 2) Attach gizmo clone (kept invisible when authored mesh is present).
  // 3) Only then hide the source IFC/FRAG item.
  try {
    const native = addNativeGeometryElement({
      name,
      entity: edit.nativeEntity || edit.sourceEntity || "IfcBuildingElementProxy",
      globalId: edit.sourceGlobalId,
      sourceGlobalId: edit.sourceGlobalId,
      predefinedType: edit.predefinedType,
      tag: edit.sourceTag,
      description: edit.description,
      sourceModelId: edit.modelId,
      sourceLocalId: edit.localId,
      sourceModelName,
      propertySets: edit.propertySets,
      quantities: edit.quantities,
      positions: edit.geometry?.positions ?? [],
      position: [...edit.position],
      quaternion: [...edit.quaternion],
      scale: [...edit.scale],
      dimensions: { width: size.x, height: size.y, depth: size.z },
      sourceRawItem: edit.sourceRaw ?? edit.sourceData ?? raw,
      geometryProvenance: {
        extractionPath: extraction.path,
        triangleCount: extraction.triangleCount ?? tris.length,
        meshCount: extraction.meshCount,
        vertexCount: extraction.vertexCount,
        bounds: {
          min: [dimensionBox.min.x, dimensionBox.min.y, dimensionBox.min.z],
          max: [dimensionBox.max.x, dimensionBox.max.y, dimensionBox.max.z],
          center: [center.x, center.y, center.z],
        },
        modelMatrixWorld: objectPlacement,
      },
    });
    edit.nativeElementId = native.id;
  } catch (error) {
    console.error("[frag-edit] native authored object creation failed", error);
    try { built.geometry.dispose(); material.dispose(); } catch { /* */ }
    try {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: {
          message: `Native Twin failed for ${modelId} / ${localId}: geometry could not be registered.`,
          kind: "error",
        },
      }));
    } catch { /* */ }
    return null;
  }

  runtime.set(edit.id, rt);
  editGroup.add(clone);
  // Prefer the authored mesh as the visible representation. If it was not
  // attached, keep the clone visible so hiding the source never blanks the element.
  let authoredVisible = false;
  try {
    getAuthoredGroup().traverse((obj: any) => {
      if (obj?.userData?.elementId === edit.nativeElementId) authoredVisible = true;
    });
  } catch { /* */ }
  clone.visible = !authoredVisible;

  try {
    await hideOriginal(modelId, localId);
  } catch (e) {
    console.warn("[frag-edit] hide original failed — twin remains visible", e);
  }

  // Prefer a soft fragments refresh. Force-update has been observed to leave
  // the viewport blank when called mid-selection on large linked models.
  try {
    const core = (ctx.fragments as any)?.core;
    if (core && typeof core.update === "function") {
      await Promise.resolve(core.update(false));
    }
  } catch { /* visual refresh optional */ }

  try {
    const sel = (ctx.features as any).selection;
    sel?.clear?.();
    await sel?.applyToHighlighter?.();
  } catch { /* selection bridge is optional */ }
  refreshGizmoTargets();
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: `Editable Native Twin created: ${name}`, kind: "success" },
    }));
  } catch { /* */ }
  selectEdit(edit.id);
  renderPanel();

  history.push({
    label: `Edit element · ${name}`,
    apply: () => {
      if (!runtime.has(edit.id)) {
        ensureNativeElementForEdit(edit);
        runtime.set(edit.id, rt);
        editGroup.add(clone);
        clone.visible = false;
        applyTransformToClone(rt);
        void hideOriginal(modelId, localId);
        refreshGizmoTargets();
        renderPanel();
      }
    },
    revert: () => {
      if (runtime.has(edit.id)) {
        runtime.delete(edit.id);
        editGroup.remove(clone);
        if (edit.nativeElementId) removeElementById(edit.nativeElementId);
        void unhideOriginal(modelId, localId);
        refreshGizmoTargets();
        renderPanel();
      }
    },
  });

  markDirty();
  return edit;
}

/* ── The robust selection reader ───────────────────────────────────── */
function readSelectionFromManager(): Record<string, Set<number>> | null {
  try {
    const sel: any = (ctx.features as any).selection;
    const snap = sel?.snapshot?.();
    if (snap && Object.keys(snap).length) return snap;
  } catch { /* */ }
  return null;
}

function adoptSelectionFromHighlighter(): Record<string, Set<number>> | null {
  try {
    const sel: any = (ctx.features as any).selection;
    if (sel && typeof sel.adoptFromHighlighter === "function") {
      sel.adoptFromHighlighter();
      const snap = sel?.snapshot?.();
      if (snap && Object.keys(snap).length) return snap;
    }
  } catch { /* */ }
  return null;
}

async function pickFromViewport(): Promise<Record<string, Set<number>> | null> {
  try {
    const mod: any = await import("./selection");
    if (typeof mod.pickUnderCursor === "function") {
      const hit = await mod.pickUnderCursor();
      if (hit) return { [hit.modelId]: new Set([hit.localId]) };
    }
  } catch { /* */ }
  return null;
}

export async function beginEditFromSelection(): Promise<number> {
  // 1. Manager snapshot
  let snap = readSelectionFromManager();
  // 2. Adopt from OBC highlighter
  if (!snap) snap = adoptSelectionFromHighlighter();
  // 3. Raycast pick under last cursor
  if (!snap) snap = await pickFromViewport();

  if (!snap || !Object.keys(snap).length) return 0;

  let created = 0;
  for (const [modelId, ids] of Object.entries(snap)) {
    for (const id of ids) {
      const e = await beginEdit(modelId, id);
      if (e) created++;
    }
  }
  return created;
}

export async function removeEdit(id: string): Promise<void> {
  const rt = runtime.get(id);
  if (!rt) return;
  runtime.delete(id);
  editGroup.remove(rt.clone);
  try { rt.geometry.dispose(); rt.material.dispose(); } catch { /* */ }
  if (rt.edit.nativeElementId) removeElementById(rt.edit.nativeElementId);
  await unhideOriginal(rt.edit.modelId, rt.edit.localId);
  if (selectedEditId === id) selectedEditId = null;
  refreshGizmoTargets();
  renderPanel();
  markDirty();
}

export async function clearAllEdits(): Promise<void> {
  const ids = [...runtime.keys()];
  for (const id of ids) await removeEdit(id);
}

export function focusEdit(id: string): void {
  const rt = runtime.get(id);
  if (!rt) return;
  const box = new THREE.Box3().setFromObject(rt.clone);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;
  const vFov = THREE.MathUtils.degToRad(cam.fov ?? 60);
  const dist = (radius / Math.sin(Math.max(vFov, 0.3) / 2)) * 1.6;
  const dir = new THREE.Vector3(1.2, 0.9, 1.2).normalize();
  ctx.world.camera.controls.setLookAt(
    center.x + dir.x * dist, center.y + dir.y * dist, center.z + dir.z * dist,
    center.x, center.y, center.z, true,
  );
  updateClipping();
}

export function selectEdit(id: string | null): void {
  selectedEditId = id;
  refreshGizmoTargets();
  if (id) focusEdit(id);
  renderPanel();
}

/* ═════════════════════════════════════════════════════════════════════════
   Gizmo integration
   ═════════════════════════════════════════════════════════════════════════ */
let baseline: Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }> | null = null;

function refreshGizmoTargets(): void {
  const targets: THREE.Object3D[] = [];
  if (selectedEditId) {
    const rt = runtime.get(selectedEditId);
    if (rt) targets.push(rt.clone);
  } else if (runtime.size === 1) {
    const rt = [...runtime.values()][0];
    selectedEditId = rt.edit.id;
    targets.push(rt.clone);
  }
  gizmo.setEditTargets(targets);
}

function applyDeltaToRuntime(
  rt: EditRuntime,
  delta: THREE.Vector3,
  axis: "x" | "y" | "z" | "free",
  mode: "move" | "rotate" | "scale",
): void {
  const base = baseline?.get(rt.edit.id);
  if (!base) return;

  if (mode === "move") {
    const p = base.pos.clone().add(delta);
    rt.edit.position = [p.x, p.y, p.z];
  } else if (mode === "scale") {
    const f = 1 + (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z)) * 0.1;
    if (axis === "x") rt.edit.scale = [base.scale.x * f, base.scale.y, base.scale.z];
    else if (axis === "y") rt.edit.scale = [base.scale.x, base.scale.y * f, base.scale.z];
    else if (axis === "z") rt.edit.scale = [base.scale.x, base.scale.y, base.scale.z * f];
    else rt.edit.scale = [base.scale.x * f, base.scale.y * f, base.scale.z * f];
  } else if (mode === "rotate") {
    const angle = (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z)) * 0.02;
    const axisVec = axis === "x" ? new THREE.Vector3(1, 0, 0)
                  : axis === "z" ? new THREE.Vector3(0, 0, 1)
                  : new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(axisVec, angle);
    const nq = q.multiply(base.quat.clone());
    rt.edit.quaternion = [nq.x, nq.y, nq.z, nq.w];
  }
  rt.edit.updatedAt = Date.now();
  applyTransformToClone(rt);
}

export function setupFragEditGizmo(): void {
  gizmo.setEditCallbacks({
    onStart: () => {
      baseline = new Map();
      for (const rt of runtime.values()) {
        baseline.set(rt.edit.id, {
          pos: new THREE.Vector3(...rt.edit.position),
          quat: new THREE.Quaternion(...rt.edit.quaternion),
          scale: new THREE.Vector3(...rt.edit.scale),
        });
      }
    },
    onUpdate: (delta, axis) => {
      if (!baseline) return;
      const mode = gizmo.getMode();
      if (mode === "none") return;
      for (const rt of runtime.values()) {
        if (selectedEditId && rt.edit.id !== selectedEditId) continue;
        applyDeltaToRuntime(rt, delta, axis, mode as any);
      }
    },
    onEnd: (_delta, _axis) => {
      if (!baseline) return;
      const before = baseline;
      const after = new Map<string, FragEdit>();
      for (const rt of runtime.values()) after.set(rt.edit.id, { ...rt.edit });
      baseline = null;

      for (const rt of runtime.values()) {
        const b = before.get(rt.edit.id);
        if (!b) continue;
        rt.edit.position = [b.pos.x, b.pos.y, b.pos.z];
        rt.edit.quaternion = [b.quat.x, b.quat.y, b.quat.z, b.quat.w];
        rt.edit.scale = [b.scale.x, b.scale.y, b.scale.z];
        applyTransformToClone(rt);
      }

      const beforeSnap = new Map<string, FragEdit>();
      for (const rt of runtime.values()) {
        beforeSnap.set(rt.edit.id, {
          ...rt.edit,
          position: [...rt.edit.position] as [number, number, number],
          quaternion: [...rt.edit.quaternion] as [number, number, number, number],
          scale: [...rt.edit.scale] as [number, number, number],
        });
      }

      const applySnapshot = (snap: Map<string, FragEdit>) => {
        for (const rt of runtime.values()) {
          const s = snap.get(rt.edit.id);
          if (!s) continue;
          rt.edit.position = [...s.position];
          rt.edit.quaternion = [...s.quaternion];
          rt.edit.scale = [...s.scale];
          applyTransformToClone(rt);
        }
        renderPanel();
      };

      history.push({
        label: `Transform edit · ${after.size} element(s)`,
        apply: () => applySnapshot(after),
        revert: () => applySnapshot(beforeSnap),
      });
      applySnapshot(after);
      markDirty();
      updateClipping();
    },
  });
}

export function setNativeDimensions(id: string, width: number, height: number, depth: number): boolean {
  const rt = runtime.get(id);
  const d = rt?.edit.dimensions;
  if (!rt || !d) return false;
  const w = Number(width), h = Number(height), dep = Number(depth);
  if (!(w > 0) || !(h > 0) || !(dep > 0)) return false;
  const before = [...rt.edit.scale] as [number, number, number];
  const next: [number, number, number] = [w / Math.max(d.width, 1e-9), h / Math.max(d.height, 1e-9), dep / Math.max(d.depth, 1e-9)];
  rt.edit.scale = next;
  rt.edit.updatedAt = Date.now();
  history.push({
    label: `Native Twin dimensions · ${rt.edit.name}`,
    apply: () => { rt.edit.scale = [...next] as [number, number, number]; applyTransformToClone(rt); renderPanel(); },
    revert: () => { rt.edit.scale = [...before] as [number, number, number]; applyTransformToClone(rt); renderPanel(); },
  });
  applyTransformToClone(rt);
  markDirty();
  renderPanel();
  return true;
}

export function setNativeOverride(id: string, key: string, value: unknown): boolean {
  const rt = runtime.get(id);
  const k = String(key ?? "").trim();
  if (!rt || !k) return false;
  const before = jsonSafe(rt.edit.overrides ?? {});
  const next = { ...(rt.edit.overrides ?? {}) };
  next[k] = jsonSafe(value);
  rt.edit.overrides = next;
  rt.edit.updatedAt = Date.now();
  history.push({
    label: `Native Twin override · ${k}`,
    apply: () => { rt.edit.overrides = jsonSafe(next); renderPanel(); },
    revert: () => { rt.edit.overrides = jsonSafe(before); renderPanel(); },
  });
  markDirty();
  renderPanel();
  return true;
}

export function exportNativeTwin(id: string): boolean {
  const rt = runtime.get(id);
  if (!rt) return false;
  const payload = {
    schema: "openbim-native-twin/1.0",
    nativeId: rt.edit.nativeId ?? rt.edit.id,
    nativeEntity: rt.edit.nativeEntity ?? rt.edit.sourceEntity ?? "IfcBuildingElementProxy",
    source: {
      type: rt.edit.sourceType,
      format: rt.edit.sourceFormat,
      modelId: rt.edit.modelId,
      localId: rt.edit.localId,
      modelName: rt.edit.sourceModelName,
      globalId: rt.edit.sourceGlobalId,
      entity: rt.edit.sourceEntity,
    },
    placement: rt.edit.objectPlacement,
    dimensions: rt.edit.dimensions,
    transform: { position: rt.edit.position, quaternion: rt.edit.quaternion, scale: rt.edit.scale },
    attributes: rt.edit.sourceData ?? {},
    propertySets: rt.edit.propertySets ?? {},
    quantities: rt.edit.quantities ?? {},
    overrides: rt.edit.overrides ?? {},
    geometry: rt.edit.geometry ?? {},
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(rt.edit.name || "native-twin").replace(/[^a-z0-9._-]+/gi, "_")}.openbim-twin.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // Also emit a minimal IFC4 for interoperability with external IFC tools.
  try {
    downloadNativeTwinIfc(rt.edit as any);
  } catch (e) {
    console.warn("[frag-edit] IFC export failed", e);
  }
  return true;
}

export function clearNativeOverrides(id: string): void {
  const rt = runtime.get(id);
  if (!rt) return;
  const before = jsonSafe(rt.edit.overrides ?? {});
  rt.edit.overrides = {};
  history.push({
    label: `Clear Native Twin overrides`,
    apply: () => { rt.edit.overrides = {}; renderPanel(); },
    revert: () => { rt.edit.overrides = jsonSafe(before); renderPanel(); },
  });
  markDirty();
  renderPanel();
}

/* ═════════════════════════════════════════════════════════════════════════
   Serialization
   ═════════════════════════════════════════════════════════════════════════ */
export function serializeEdits(): FragEdit[] {
  return getEdits().map((e) => ({
    ...e,
    position: [...e.position] as [number, number, number],
    quaternion: [...e.quaternion] as [number, number, number, number],
    scale: [...e.scale] as [number, number, number],
  }));
}

export async function deserializeEdits(edits: FragEdit[] | undefined | null): Promise<void> {
  await clearAllEdits();
  if (!Array.isArray(edits) || !edits.length) return;

  for (const e of edits) {
    const model: any = ctx.fragments.list.get(e.modelId);
    let tris: Tri[] | null = null;
    if (e.geometry?.positions?.length) {
      const p = e.geometry.positions;
      tris = [];
      for (let i = 0; i + 8 < p.length; i += 9) tris.push(new Float32Array(p.slice(i, i + 9)));
      const local = new THREE.BufferGeometry();
      local.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      local.computeVertexNormals();
      const center = new THREE.Vector3(...e.position);
      const material = makeCloneMaterial();
      const clone = new THREE.Mesh(local, material);
      clone.userData.fragEdit = true;
      const rt: EditRuntime = {
        edit: { ...e, position: [...e.position], quaternion: [...e.quaternion], scale: [...e.scale] },
        clone, geometry: local, material, originalBox: new THREE.Box3().setFromObject(clone),
      };
      ensureNativeElementForEdit(rt.edit);
      runtime.set(rt.edit.id, rt);
      editGroup.add(clone);
      clone.visible = false;
      applyTransformToClone(rt);
      if (model) await hideOriginal(rt.edit.modelId, rt.edit.localId);
      continue;
    }
    if (!model) continue;
    try { tris = getElementTrianglesExact(model.object, e.localId); } catch { tris = null; }
    if (!tris || !tris.length) { try { tris = getElementTriangles(model.object, e.localId); } catch { tris = null; } }
    if (!tris || !tris.length) continue;

    const built = buildCenteredGeometry(tris);
    if (!built) continue;

    const material = makeCloneMaterial();
    const clone = new THREE.Mesh(built.geometry, material);
    clone.userData.fragEdit = true;

    const rt: EditRuntime = {
      edit: {
        ...e,
        position: [...e.position],
        quaternion: [...e.quaternion],
        scale: [...e.scale],
      },
      clone,
      geometry: built.geometry,
      material,
      originalBox: built.box.clone(),
    };
    ensureNativeElementForEdit(rt.edit);
    runtime.set(rt.edit.id, rt);
    editGroup.add(clone);
    clone.visible = false;
    applyTransformToClone(rt);
    await hideOriginal(rt.edit.modelId, rt.edit.localId);
  }
  refreshGizmoTargets();
  renderPanel();
  console.info(`[frag-edit] restored ${runtime.size} edit(s) from project`);
}

/* ═════════════════════════════════════════════════════════════════════════
   Panel
   ═════════════════════════════════════════════════════════════════════════ */
let panelEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let fragDock: DockHandle | null = null;

function ensurePanel(): HTMLDivElement {
  if (panelEl) return panelEl;

  panelEl = document.createElement("div");
  panelEl.id = "obs-frag-edit-panel";
  panelEl.style.cssText =
    "position:absolute;left:400px;top:14px;bottom:14px;width:300px;z-index:35;" +
    "display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
    "color:var(--text-primary,#e8eaf0);overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:9px 10px;" +
    "border-bottom:1px solid var(--border-subtle,#1e2029);" +
    "background:var(--bg-elevated,#181a23)";
  header.innerHTML = `<span style="font-weight:700;flex:1">✏ FRAG Edits</span>`;

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear all";
  clearBtn.style.cssText =
    "padding:4px 9px;background:transparent;color:#fca5a5;" +
    "border:1px solid rgba(239,68,68,.5);border-radius:5px;cursor:pointer;font:600 10.5px system-ui";
  clearBtn.onclick = async () => {
    if (!runtime.size) return;
    if (!confirm(`Revert all ${runtime.size} edit(s)?`)) return;
    await clearAllEdits();
    markDirty();
  };

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText =
    "padding:4px 8px;background:transparent;color:var(--text-secondary);" +
    "border:1px solid var(--border-default);border-radius:5px;cursor:pointer;font-size:11px";
  closeBtn.onclick = () => closeFragEditPanel();

  header.append(clearBtn, closeBtn);

  listEl = document.createElement("div");
  listEl.style.cssText = "flex:1;overflow-y:auto;padding:6px";

  panelEl.append(header, listEl);
  ctx.rightHost.appendChild(panelEl);
  fragDock = makeDockable(panelEl, {
    id: "frag-native-twin", host: ctx.rightHost, header,
    minWidth: 290, minHeight: 260, defaultDock: "right", defaultWidth: 340, defaultHeight: 680,
  });
  return panelEl;
}

function renderPanel(): void {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!runtime.size) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:24px 16px;text-align:center;color:var(--text-tertiary,#6b7280);" +
      "font:11.5px/1.6 system-ui";
    empty.innerHTML =
      `No Native Twins.<br><br>` +
      `1. Select an element from a linked IFC / FRAG model.<br>` +
      `2. Click <b>Make Editable</b>.<br>` +
      `3. The source object is preserved and an editable twin is created.<br>` +
      `4. Modify the twin, review source properties, and add controlled overrides.`;
    listEl.appendChild(empty);
    return;
  }

  for (const rt of runtime.values()) {
    const e = rt.edit;
    const active = e.id === selectedEditId;

    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;flex-direction:column;gap:4px;padding:8px 9px;" +
      "border-radius:6px;margin:2px 0;cursor:pointer;" +
      (active
        ? "background:var(--accent-dim,rgba(56,189,248,.14));border:1px solid var(--accent,#38bdf8)"
        : "border:1px solid transparent");
    row.onclick = () => selectEdit(e.id);

    const top = document.createElement("div");
    top.style.cssText = "display:flex;align-items:center;gap:6px";
    const name = document.createElement("div");
    name.style.cssText = "flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    name.textContent = e.name;
    name.title = `${e.name}  [${e.category}]`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Revert this element and restore the linked source";
    del.style.cssText =
      "padding:2px 6px;background:transparent;color:#fca5a5;" +
      "border:1px solid rgba(239,68,68,.4);border-radius:4px;cursor:pointer;font-size:10px;flex:none";
    del.onclick = (ev) => { ev.stopPropagation(); void removeEdit(e.id).then(() => markDirty()); };
    top.append(name, del);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:10px;color:var(--text-tertiary);line-height:1.55";
    const [px, py, pz] = e.position.map((n) => n.toFixed(2));
    const scl = e.scale.map((n) => n.toFixed(2)).join(" , ");
    const d = e.dimensions;
    const dims = d ? `${d.width.toFixed(3)} × ${d.height.toFixed(3)} × ${d.depth.toFixed(3)} m` : "dimensions unavailable";
    const gid = e.sourceGlobalId ? ` · ${e.sourceGlobalId}` : "";
    meta.innerHTML =
      `<div><span style="font-family:var(--font-mono,monospace)">${px}, ${py}, ${pz}</span> · ` +
      `scale ${scl} · <span style="opacity:.65">${escapeHtml(e.category)}</span></div>` +
      `<div style="color:#93c5fd;font-weight:700">Native Twin · ${escapeHtml(e.sourceType ?? "openBIM")} · ${escapeHtml(dims)}</div>` +
      `<div style="color:#94a3b8">Source: ${escapeHtml(e.sourceModelName ?? e.modelId)}${gid ? ` · ${escapeHtml(gid)}` : ""}</div>`;

    row.append(top, meta);
    listEl.appendChild(row);

    if (active) {
      const detail = document.createElement("div");
      detail.style.cssText = "margin:2px 0 8px 0;padding:9px;border:1px solid #293140;border-radius:6px;background:#0e1118";
      const dTitle = document.createElement("div");
      dTitle.textContent = "Native Twin — Source Snapshot";
      dTitle.style.cssText = "font-weight:800;font-size:10.5px;color:#dbeafe;margin-bottom:7px";
      detail.appendChild(dTitle);

      const sourceRows: Array<[string, string]> = [
        ["Native Class", String(e.nativeEntity ?? e.sourceEntity ?? "IfcBuildingElementProxy")],
        ["Native ID", String(e.nativeElementId ?? e.nativeId ?? e.id)],
        ["IFC Entity", String(e.nativeEntity ?? e.sourceEntity ?? "IfcBuildingElementProxy")],
        ["Source IFC Entity", String(e.sourceEntity ?? "—")],
        ["Source GlobalId", String(e.sourceGlobalId ?? "—")],
        ["Tag", String(e.sourceTag ?? "—")],
        ["Predefined Type", String(e.predefinedType ?? "—")],
        ["Description", String(e.description ?? "—")],
        ["Property Sets", String(Object.keys(e.propertySets ?? {}).length)],
        ["Quantities", String(Object.keys(e.quantities ?? {}).length)],
        ["Overrides", String(Object.keys(e.overrides ?? {}).length)],
      ];
      for (const [k, v] of sourceRows) {
        const rr = document.createElement("div");
        rr.style.cssText = "display:grid;grid-template-columns:92px 1fr;gap:7px;padding:2px 0;font-size:9.5px";
        const kk = document.createElement("span"); kk.textContent = k; kk.style.color = "#7f8ba0";
        const vv = document.createElement("span"); vv.textContent = v; vv.style.color = "#cbd5e1"; vv.style.overflowWrap = "anywhere";
        rr.append(kk, vv); detail.appendChild(rr);
      }

      if (e.dimensions) {
        const dim = document.createElement("div");
        const currentDims = [e.dimensions.width * Math.abs(e.scale[0]), e.dimensions.height * Math.abs(e.scale[1]), e.dimensions.depth * Math.abs(e.scale[2])];
        dim.textContent = `Source: ${e.dimensions.width.toFixed(4)} × ${e.dimensions.height.toFixed(4)} × ${e.dimensions.depth.toFixed(4)} m · Current: ${currentDims.map((v) => v.toFixed(4)).join(" × ")} m`;
        dim.style.cssText = "margin-top:6px;padding:5px 6px;border:1px solid #243247;border-radius:4px;color:#bfdbfe;background:rgba(30,64,175,.08);font-size:9.5px";
        detail.appendChild(dim);

        const dimEditor = document.createElement("div");
        dimEditor.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr) auto;gap:4px;margin-top:6px";
        const inputs = [
          { value: currentDims[0], placeholder: "W" },
          { value: currentDims[1], placeholder: "H" },
          { value: currentDims[2], placeholder: "D" },
        ].map((it) => {
          const inp = document.createElement("input"); inp.value = it.value.toFixed(4); inp.title = it.placeholder + " (m)";
          inp.style.cssText = "min-width:0;padding:5px 5px;background:#0a0d12;border:1px solid #2b3442;border-radius:4px;color:#e2e8f0;font-size:9px";
          return inp;
        });
        const applyDim = document.createElement("button"); applyDim.textContent = "Set";
        applyDim.style.cssText = "padding:5px 7px;background:rgba(56,189,248,.12);border:1px solid #38bdf8;color:#bae6fd;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer";
        applyDim.onclick = () => { setNativeDimensions(e.id, Number(inputs[0].value), Number(inputs[1].value), Number(inputs[2].value)); };
        dimEditor.append(inputs[0], inputs[1], inputs[2], applyDim); detail.appendChild(dimEditor);
      }

      const rawDetails = document.createElement("details");
      rawDetails.style.cssText = "margin-top:7px";
      const summary = document.createElement("summary"); summary.textContent = "View complete copied IFC / FRAG data"; summary.style.cssText = "cursor:pointer;color:#93c5fd;font-size:9.5px;font-weight:700";
      rawDetails.appendChild(summary);
      const raw = document.createElement("pre");
      raw.textContent = JSON.stringify({ sourceData: e.sourceData ?? {}, propertySets: e.propertySets ?? {}, quantities: e.quantities ?? {} }, null, 2);
      raw.style.cssText = "max-height:260px;overflow:auto;margin:6px 0 0;padding:7px;background:#080b10;border:1px solid #212a36;border-radius:4px;color:#a7f3d0;font:8.5px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word";
      rawDetails.appendChild(raw); detail.appendChild(rawDetails);

      const exportTwin = document.createElement("button");
      exportTwin.textContent = "Export Native Twin audit JSON";
      exportTwin.style.cssText = "margin-top:7px;padding:5px 7px;background:rgba(34,197,94,.09);border:1px solid #3f8f62;color:#bbf7d0;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer";
      exportTwin.onclick = () => exportNativeTwin(e.id);
      const exportIfc = document.createElement("button");
      exportIfc.textContent = "Export as IFC4";
      exportIfc.style.cssText = exportTwin.style.cssText;
      exportIfc.onclick = () => {
        try { downloadNativeTwinIfc(e as any); } catch (err) { console.warn(err); }
      };
      detail.appendChild(exportIfc);
      detail.appendChild(exportTwin);

      const overrideTitle = document.createElement("div");
      overrideTitle.textContent = "Editable Overrides";
      overrideTitle.style.cssText = "font-weight:800;font-size:10px;color:#e2e8f0;margin:9px 0 5px";
      detail.appendChild(overrideTitle);

      const overrideList = document.createElement("div");
      for (const [k, v] of Object.entries(e.overrides ?? {})) {
        const or = document.createElement("div");
        or.style.cssText = "display:flex;gap:5px;margin-bottom:3px";
        const kk = document.createElement("span"); kk.textContent = k; kk.style.cssText = "flex:1;color:#93c5fd;font-size:9px;overflow:hidden;text-overflow:ellipsis";
        const vv = document.createElement("span"); vv.textContent = typeof v === "string" ? v : JSON.stringify(v); vv.style.cssText = "max-width:145px;color:#cbd5e1;font-size:9px;overflow-wrap:anywhere";
        or.append(kk, vv); overrideList.appendChild(or);
      }
      if (!Object.keys(e.overrides ?? {}).length) {
        const none = document.createElement("div"); none.textContent = "No overrides — twin currently reflects the source snapshot."; none.style.cssText = "color:#667085;font-size:9px"; overrideList.appendChild(none);
      }
      detail.appendChild(overrideList);

      const editor = document.createElement("div");
      editor.style.cssText = "display:grid;grid-template-columns:1fr 1fr auto;gap:4px;margin-top:6px";
      const keyInput = document.createElement("input"); keyInput.placeholder = "Property / override key";
      const valueInput = document.createElement("input"); valueInput.placeholder = "Value";
      for (const inp of [keyInput, valueInput]) inp.style.cssText = "min-width:0;padding:5px 6px;background:#0a0d12;border:1px solid #2b3442;border-radius:4px;color:#e2e8f0;font-size:9.5px";
      const apply = document.createElement("button"); apply.textContent = "Apply"; apply.style.cssText = "padding:5px 7px;background:rgba(56,189,248,.12);border:1px solid #38bdf8;color:#bae6fd;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer";
      apply.onclick = () => { if (setNativeOverride(e.id, keyInput.value, valueInput.value)) { keyInput.value = ""; valueInput.value = ""; } };
      editor.append(keyInput, valueInput, apply); detail.appendChild(editor);

      const clearOverrides = document.createElement("button");
      clearOverrides.textContent = "Clear all overrides";
      clearOverrides.style.cssText = "margin-top:6px;padding:4px 7px;background:transparent;border:1px solid #3a414f;color:#aab4c5;border-radius:4px;font-size:9px;cursor:pointer";
      clearOverrides.onclick = () => clearNativeOverrides(e.id);
      detail.appendChild(clearOverrides);

      listEl.appendChild(detail);
    }
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

export function isFragEditPanelVisible(): boolean {
  return !!panelEl && panelEl.style.display === "flex";
}
export function openFragEditPanel(): void {
  ensurePanel();
  if (panelEl) panelEl.style.display = "flex";
  renderPanel();
}
export function closeFragEditPanel(): void {
  fragDock?.hide();
  if (panelEl) panelEl.style.display = "none";
}
export function toggleFragEditPanel(): void {
  isFragEditPanelVisible() ? closeFragEditPanel() : openFragEditPanel();
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupFragEdit(): void {
  if (initialized) return;
  initialized = true;

  ctx.world.scene.three.add(editGroup);
  setupFragEditGizmo();

  if (gizmo.getMode() === "none") gizmo.setMode("move");

  ctx.features.fragEdit = {
    begin: beginEdit,
    beginFromSelection: beginEditFromSelection,
    remove: removeEdit,
    clearAll: clearAllEdits,
    list: getEdits,
    count: getEditCount,
    select: selectEdit,
    focus: focusEdit,
    serialize: serializeEdits,
    deserialize: deserializeEdits,
    serializeNativeTwins: serializeEdits,
    deserializeNativeTwins: deserializeEdits,
    getSelected: () => selectedEditId ? runtime.get(selectedEditId)?.edit ?? null : null,
    setOverride: setNativeOverride,
    setDimensions: setNativeDimensions,
    clearOverrides: clearNativeOverrides,
    exportNativeTwin,
    showAllPreservingTwins,
    togglePanel: toggleFragEditPanel,
    isPanelVisible: isFragEditPanelVisible,
  };
}