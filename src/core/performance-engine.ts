/**
 * Performance engine — BVH-accelerated raycasting + InstancedMesh batching.
 *
 * FIX (2026-10-30): Replaced CommonJS `require("three-mesh-bvh")` with a
 * static ESM import. Vite browser builds do not provide `require`, which
 * caused:
 *   [perf] three-mesh-bvh not available, using linear raycast:
 *   ReferenceError: require is not defined
 *
 * Also correctly assigns THREE.Mesh.prototype.raycast = acceleratedRaycast
 * (previously only stored on a side property and never activated).
 *
 * Two optimizations:
 *
 * 1. BVH raycasting: uses three-mesh-bvh to build a Bounding Volume
 *    Hierarchy on every mesh's geometry. This makes raycast queries
 *    (selection, snapping, picking) O(log n) instead of O(n) — critical
 *    for large models with thousands of elements.
 *
 * 2. InstancedMesh batching: groups authored elements of the same type
 *    into a single THREE.InstancedMesh, reducing draw calls.
 */

import * as THREE from "three";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";
import { ctx } from "../core/context";

type Any = Record<string, any>;

let bvhInstalled = false;
let batchingEnabled = false;

/**
 * Install BVH acceleration from three-mesh-bvh (ESM).
 *
 * Patches:
 * - THREE.BufferGeometry.prototype.computeBoundsTree / disposeBoundsTree
 * - THREE.Mesh.prototype.raycast → acceleratedRaycast
 */
export function installBVH(): boolean {
  if (bvhInstalled) return true;
  try {
    const geoProto = THREE.BufferGeometry.prototype as any;
    if (!geoProto.computeBoundsTree) {
      geoProto.computeBoundsTree = computeBoundsTree;
      geoProto.disposeBoundsTree = disposeBoundsTree;
    }

    const meshProto = THREE.Mesh.prototype as any;
    if (!meshProto._bvhRaycastPatched) {
      meshProto._bvhRaycastPatched = true;
      // Critical: replace the default linear raycast with BVH-accelerated one.
      meshProto.raycast = acceleratedRaycast;
    }

    bvhInstalled = true;
    console.log("[perf] BVH acceleration installed (three-mesh-bvh ESM)");
    return true;
  } catch (e) {
    console.warn("[perf] three-mesh-bvh not available, using linear raycast:", e);
    return false;
  }
}

/**
 * Accelerate a single mesh by building a BVH on its geometry.
 * Call after creating or updating any mesh that will be raycast.
 */
export function accelerateMesh(mesh: THREE.Mesh): void {
  if (!bvhInstalled) return;
  try {
    const geo = mesh.geometry as any;
    if (!geo.boundsTree && geo.attributes?.position) {
      geo.computeBoundsTree();
    }
  } catch {
    /* geometry may not be compatible */
  }
}

/**
 * Accelerate all meshes in the scene (one-time after model load).
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
        if (!geo.boundsTree && geo.attributes?.position) {
          geo.computeBoundsTree();
          count++;
        }
      } catch {
        /* */
      }
    }
  });

  console.log(`[perf] BVH built on ${count} mesh(es)`);
  return count;
}

/** Dispose BVH on a mesh's geometry (when the mesh is removed). */
export function disposeMeshBVH(mesh: THREE.Mesh): void {
  if (!bvhInstalled) return;
  try {
    const geo = mesh.geometry as any;
    if (typeof geo.disposeBoundsTree === "function") {
      geo.disposeBoundsTree();
    }
  } catch {
    /* */
  }
}

// ─── InstancedMesh batching ─────────────────────────────────────────────

const batches = new Map<string, THREE.InstancedMesh>();

export function createBatch(
  batchKey: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
): THREE.InstancedMesh | null {
  if (matrices.length === 0) return null;

  removeBatch(batchKey);

  const count = matrices.length;
  const instancedMesh = new THREE.InstancedMesh(geometry, material, count);

  for (let i = 0; i < count; i++) {
    instancedMesh.setMatrixAt(i, matrices[i]);
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  instancedMesh.frustumCulled = false;
  instancedMesh.userData.isBatch = true;
  instancedMesh.userData.batchKey = batchKey;

  if (bvhInstalled) {
    try {
      (geometry as any).computeBoundsTree?.();
    } catch {
      /* */
    }
  }

  try {
    (ctx as any)?.world?.scene?.three?.add(instancedMesh);
  } catch {
    /* */
  }

  batches.set(batchKey, instancedMesh);
  return instancedMesh;
}

export function removeBatch(batchKey: string): void {
  const batch = batches.get(batchKey);
  if (!batch) return;
  try {
    (ctx as any)?.world?.scene?.three?.remove(batch);
    batch.dispose();
  } catch {
    /* */
  }
  batches.delete(batchKey);
}

export function clearAllBatches(): void {
  for (const key of [...batches.keys()]) {
    removeBatch(key);
  }
  console.log("[perf] cleared all InstancedMesh batches");
}

export function listBatches(): string[] {
  return [...batches.keys()];
}

export function setBatchingEnabled(on: boolean): void {
  batchingEnabled = on;
  if (!on) clearAllBatches();
  console.log(`[perf] InstancedMesh batching: ${on ? "ON" : "OFF"}`);
}

export function isBatchingEnabled(): boolean {
  return batchingEnabled;
}

export function isBVHInstalled(): boolean {
  return bvhInstalled;
}

/**
 * Full performance setup — call from critical-gaps-boot / main boot path.
 */
export function setupPerformanceEngine(): void {
  installBVH();

  setTimeout(() => {
    try {
      accelerateAllMeshes();
    } catch {
      /* */
    }
  }, 1000);

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
