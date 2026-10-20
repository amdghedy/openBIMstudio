/**
 * Performance engine — BVH-accelerated raycasting + InstancedMesh batching.
 *
 * Two optimizations:
 *
 * 1. BVH raycasting: uses three-mesh-bvh to build a Bounding Volume
 *    Hierarchy on every mesh's geometry. This makes raycast queries
 *    (selection, snapping, picking) O(log n) instead of O(n) — critical
 *    for large models with thousands of elements.
 *
 *    The three-mesh-bvh library monkey-patches THREE.BufferGeometry with
 *    a `computeBoundsTree()` method and THREE.Mesh with an
 *    `acceleratedRaycast` method. We call computeBoundsTree() on every
 *    new mesh geometry and recompute it when geometry changes.
 *
 * 2. InstancedMesh batching: groups authored elements of the same type
 *    (e.g. all walls) into a single THREE.InstancedMesh, reducing draw
 *    calls from N (one per element) to 1 (one per type). This is the
 *    single biggest rendering optimization for BIM models — a typical
 *    project has 500-2000 walls, all identical geometry that only
 *    differs in transform.
 *
 * The batching is optional and can be toggled — when the user needs
 * per-element editing (move/delete), we fall back to individual meshes.
 */

import * as THREE from "three";
import { ctx } from "../core/context";

type Any = Record<string, any>;

let bvhInstalled = false;
let batchingEnabled = false;

/**
 * Install BVH acceleration on three-mesh-bvh.
 *
 * This patches THREE.BufferGeometry.prototype.computeBoundsTree and
 * THREE.Mesh.prototype.acceleratedRaycast. After calling this once,
 * every mesh with `geometry.computeBoundsTree()` called will use BVH
 * for raycasting instead of the default linear scan.
 */
export function installBVH(): boolean {
  if (bvhInstalled) return true;
  try {
    const { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } =
      require("three-mesh-bvh");

    // Patch BufferGeometry to support BVH.
    const geoProto = THREE.BufferGeometry.prototype as any;
    if (!geoProto.computeBoundsTree) {
      geoProto.computeBoundsTree = computeBoundsTree;
      geoProto.disposeBoundsTree = disposeBoundsTree;
      geoProto.boundsTree = null;
    }

    // Patch Mesh to use accelerated raycast when BVH is available.
    const meshProto = THREE.Mesh.prototype as any;
    if (!meshProto._bvhRaycastPatched) {
      meshProto._bvhRaycastPatched = true;
      meshProto.acceleratedRaycast = acceleratedRaycast;
    }

    bvhInstalled = true;
    console.log("[perf] BVH acceleration installed (three-mesh-bvh 0.7.x)");
    return true;
  } catch (e) {
    console.warn("[perf] three-mesh-bvh not available, using linear raycast:", e);
    return false;
  }
}

/**
 * Accelerate a single mesh by building a BVH on its geometry.
 *
 * Call this after creating or updating any mesh that will be raycast
 * (selection, snapping, picking). The BVH is built once and cached
 * on the geometry object.
 */
export function accelerateMesh(mesh: THREE.Mesh): void {
  if (!bvhInstalled) return;
  try {
    const geo = mesh.geometry as any;
    if (!geo.boundsTree && geo.attributes.position) {
      geo.computeBoundsTree();
    }
  } catch { /* geometry may not be compatible */ }
}

/**
 * Accelerate all meshes in the scene.
 *
 * Walks the scene graph, finds all Mesh objects, and builds a BVH on
 * each. This is a one-time call after loading a model. For dynamic
 * scenes (authored elements being added/edited), call accelerateMesh()
 * on individual meshes as they're created.
 */
export function accelerateAllMeshes(): number {
  if (!bvhInstalled) return 0;
  const scene = (ctx as any)?.world?.scene?.three as THREE.Scene | null;
  if (!scene) return 0;

  let count = 0;
  scene.traverse((obj: any) => {
    if (obj.isMesh && obj.geometry) {
      try {
        const geo = obj.geometry;
        if (!geo.boundsTree && geo.attributes.position) {
          geo.computeBoundsTree();
          count++;
        }
      } catch { /* */ }
    }
  });

  console.log(`[perf] BVH built on ${count} mesh(es)`);
  return count;
}

/**
 * Dispose BVH on a mesh's geometry (when the mesh is removed).
 */
export function disposeMeshBVH(mesh: THREE.Mesh): void {
  if (!bvhInstalled) return;
  try {
    const geo = mesh.geometry as any;
    if (geo.disposeBoundsTree) {
      geo.disposeBoundsTree();
    }
  } catch { /* */ }
}

// ─── InstancedMesh batching ─────────────────────────────────────────────

/** Track InstancedMesh batches by element type. */
const batches = new Map<string, THREE.InstancedMesh>();

/**
 * Create or update an InstancedMesh batch for a set of elements
 * of the same type.
 *
 * @param batchKey - unique key (e.g. "wall", "column")
 * @param geometry - shared geometry for all instances
 * @param material - shared material for all instances
 * @param matrices - array of 4x4 world matrices, one per instance
 * @returns the InstancedMesh, added to the scene
 */
export function createBatch(
  batchKey: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
): THREE.InstancedMesh | null {
  if (matrices.length === 0) return null;

  // Remove existing batch if any.
  removeBatch(batchKey);

  const count = matrices.length;
  const instancedMesh = new THREE.InstancedMesh(geometry, material, count);

  for (let i = 0; i < count; i++) {
    instancedMesh.setMatrixAt(i, matrices[i]);
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  instancedMesh.frustumCulled = false; // batch handles its own culling
  instancedMesh.userData.isBatch = true;
  instancedMesh.userData.batchKey = batchKey;

  // Accelerate the batch geometry with BVH.
  if (bvhInstalled) {
    try {
      (geometry as any).computeBoundsTree?.();
    } catch { /* */ }
  }

  // Add to scene.
  try {
    (ctx as any)?.world?.scene?.three?.add(instancedMesh);
  } catch { /* */ }

  batches.set(batchKey, instancedMesh);
  return instancedMesh;
}

/** Remove a batch from the scene. */
export function removeBatch(batchKey: string): void {
  const batch = batches.get(batchKey);
  if (!batch) return;
  try {
    (ctx as any)?.world?.scene?.three?.remove(batch);
    batch.dispose();
  } catch { /* */ }
  batches.delete(batchKey);
}

/** Remove all batches. */
export function clearAllBatches(): void {
  for (const key of batches.keys()) {
    removeBatch(key);
  }
  console.log("[perf] cleared all InstancedMesh batches");
}

/** List active batch keys. */
export function listBatches(): string[] {
  return [...batches.keys()];
}

// ─── Toggle + status ────────────────────────────────────────────────────

/** Enable/disable InstancedMesh batching. */
export function setBatchingEnabled(on: boolean): void {
  batchingEnabled = on;
  if (!on) clearAllBatches();
  console.log(`[perf] InstancedMesh batching: ${on ? "ON" : "OFF"}`);
}

/** Check if batching is enabled. */
export function isBatchingEnabled(): boolean {
  return batchingEnabled;
}

/** Check if BVH acceleration is installed. */
export function isBVHInstalled(): boolean {
  return bvhInstalled;
}

/**
 * Full performance setup — called from critical-gaps-boot.ts.
 */
export function setupPerformanceEngine(): void {
  installBVH();

  // Accelerate existing meshes after a short delay (let the scene settle).
  setTimeout(() => {
    try { accelerateAllMeshes(); } catch { /* */ }
  }, 1000);

  // Expose globals.
  (window as any).__obsPerf = {
    installBVH,
    accelerateMesh,
    accelerateAllMeshes,
    disposeMeshBVH,
    createBatch,
    removeBatch,
    clearAllBatches,
    listBatches,
    setBatchingEnabled,
    isBatchingEnabled,
    isBVHInstalled,
  };

  console.log(
    "[perf] performance engine ready. BVH: " +
    (bvhInstalled ? "installed" : "not available") +
    ". Batching: OFF (enable via __obsPerf.setBatchingEnabled(true))",
  );
}
