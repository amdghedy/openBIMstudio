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

  // Measurement helpers for the reproducible benchmark harness
  // (bench/bench-browser.mjs). They expose read-only state + real
  // production entry points; they do not alter app behavior.
  const benchHelpers = {
    /** Real import pipeline entry (file-interop importFiles). */
    importFiles: async (files: File[]) => {
      const fi: any = (ctx as any)?.features?.fileInterop;
      if (!fi?.importFiles) throw new Error("fileInterop not ready");
      await fi.importFiles(files);
    },
    /** Model ids currently registered in the fragments manager. */
    modelIds: (): string[] => {
      try { return [...((ctx as any)?.fragments?.list?.keys?.() ?? [])]; }
      catch { return []; }
    },
    /** Element counts per model (items with geometry). */
    modelInfo: async (id: string) => {
      const model: any = (ctx as any)?.fragments?.list?.get?.(id);
      if (!model) return null;
      let elements = -1;
      try {
        const ids = await model.getItemsIdsWithGeometry();
        elements = Array.isArray(ids) ? ids.length : 0;
      } catch { /* */ }
      return { id, elements };
    },
    /** JS heap in MB (Chromium). */
    heapMB: (): number => {
      const m = (performance as any).memory;
      return m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : -1;
    },
    /** GC if the host exposes it (--js-flags=--expose-gc). */
    gc: () => { try { (window as any).gc?.(); } catch { /* */ } },
    /** Mesh count currently in the 3D scene. */
    sceneMeshes: (): number => {
      let n = 0;
      try {
        (ctx as any)?.world?.scene?.three?.traverse?.((o: any) => { if ((o as any).isMesh) n++; });
      } catch { /* */ }
      return n;
    },
    /**
     * Dispatch a real pointermove at client coords, let the event loop run,
     * then time one production raycast (OBC.Raycasters.castRay).
     */
    castRayAt: async (clientX: number, clientY: number) => {
      const canvas: HTMLCanvasElement | null =
        (ctx as any)?.world?.renderer?.three?.domElement ??
        document.querySelector("canvas");
      if (!canvas) throw new Error("no canvas");
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + clientX;
      const y = rect.top + clientY;
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
      }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Same raycast path as features/selection.ts: OBC.Raycasters via components
      const t0 = performance.now();
      let hit: any = null;
      try {
        const comps = (ctx as any).components;
        const OBC = await import("@thatopen/components");
        const caster = comps.get(OBC.Raycasters).get((ctx as any).world);
        hit = await caster.castRay();
      } catch { /* */ }
      const t1 = performance.now();
      return { ms: t1 - t0, hit: hit ? { localId: hit.localId ?? null, modelId: hit.modelId ?? null, distance: hit.distance ?? null } : null };
    },
    /**
     * Sample requestAnimationFrame deltas for `ms` milliseconds.
     * Returns { frames, fps, p50, p95, max } — real frame cadence.
     */
    frameTimes: (ms: number) => {
      return new Promise((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + ms;
        function tick(t: number) {
          deltas.push(t - last);
          last = t;
          if (t >= end) {
            const sorted = [...deltas].slice(1).sort((a, b) => a - b);
            const q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
            const total = sorted.reduce((a, b) => a + b, 0);
            resolve({
              frames: sorted.length,
              fps: total > 0 ? Math.round((sorted.length / total) * 1000) : 0,
              p50: Math.round(q(0.5) * 10) / 10,
              p95: Math.round(q(0.95) * 10) / 10,
              max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
            });
            return;
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    },
    /**
     * Run an async action while timing ctx.fragments.core.load inside it
     * (temporary instrumentation, restored in finally). Returns
     * { actionMs, fragmentsLoadMs, bytes, loads }.
     */
    probeFragmentsLoad: async (action: () => Promise<void>) => {
      const core: any = (ctx as any)?.fragments?.core;
      if (!core?.load) throw new Error("fragments core not ready");
      const orig = core.load.bind(core);
      let loadMs = 0;
      let bytes = 0;
      let loads = 0;
      core.load = async (buf: any, opts: any) => {
        const t0 = performance.now();
        await orig(buf, opts);
        loadMs += performance.now() - t0;
        bytes += buf?.byteLength ?? 0;
        loads++;
      };
      const tA = performance.now();
      try { await action(); } finally { core.load = orig; }
      const actionMs = performance.now() - tA;
      return {
        actionMs: Math.round(actionMs * 10) / 10,
        fragmentsLoadMs: Math.round(loadMs * 10) / 10,
        bytes,
        loads,
      };
    },
    /** Import phase timings (exposed by features/importer.ts, read-only). */
    importPhases: () => {
      try { return ((ctx as any)?.features?.importer?.lastImportPhases?.() ?? []); }
      catch { return []; }
    },
    /**
     * Pause/resume the 3D renderer (OBC SimpleRenderer.enabled). Used by the
     * benchmark harness to measure the 2D plan subsystem in isolation from
     * the software-GL 3D loop. Production rendering state is restored by the
     * caller.
     */
    setRendererEnabled: (on: boolean) => {
      const r: any = (ctx as any)?.world?.renderer;
      if (!r) return false;
      r.enabled = !!on;
      return true;
    },
    /**
     * Count production fast-pick calls (FastModelPickers.getFullPick) while
     * firing pointer moves: 60 with the button held (orbiting) + 10 free
     * moves. Restores the wrapped method afterwards. Diagnostics only.
     */
    countHoverPicks: async () => {
      const canvas: HTMLCanvasElement | null =
        (ctx as any)?.world?.renderer?.three?.domElement ?? document.querySelector("canvas");
      if (!canvas) throw new Error("no canvas");
      const comps: any = (ctx as any).components;
      const OBC = await import("@thatopen/components");
      const picker = comps.get(OBC.FastModelPickers).get((ctx as any).world);
      const orig = picker.getFullPick.bind(picker);
      let picks = 0;
      picker.getFullPick = async (...a: any[]) => { picks++; return orig(...a); };
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const move = (buttons: number, dx: number, dy: number) => {
        canvas.dispatchEvent(new PointerEvent("pointermove", {
          clientX: cx + dx, clientY: cy + dy, bubbles: true, pointerId: 1, isPrimary: true, buttons,
        }));
      };
      let picksDuringHeld = -1;
      // phase 1: 60 moves with left button held (orbiting) — no hover picks expected
      for (let i = 0; i < 60; i++) {
        move(1, Math.sin(i / 6) * 80, Math.cos(i / 6) * 40);
        await new Promise((r) => setTimeout(r, 4));
      }
      picksDuringHeld = picks;
      // phase 2: 10 free moves — hover picks expected (up to 10)
      for (let i = 0; i < 10; i++) {
        move(0, Math.sin(i / 3) * 60, Math.cos(i / 3) * 30);
        await new Promise((r) => setTimeout(r, 30));
      }
      const picksDuringFree = picks - picksDuringHeld;
      picker.getFullPick = orig;
      return { heldMoves: 60, freeMoves: 10, picksDuringHeld, picksDuringFree };
    },
    /** Whether the 3D renderer is currently enabled (OBC SimpleRenderer). */
    isRendererEnabled: (): boolean => {
      const r: any = (ctx as any)?.world?.renderer;
      return !!r && r.enabled !== false;
    },
    /** three.js renderer.info for the last rendered frame + scene inventory. */
    renderStats: () => {
      const r: any = (ctx as any)?.world?.renderer?.three;
      const meshes: any[] = [];
      try { meshes.push(...((ctx as any)?.world?.meshes ?? [])); } catch { /* */ }
      const big = meshes
        .map((m: any) => ({
          name: m.name || m.type,
          indexCount: m.geometry?.index?.count ?? m.geometry?.attributes?.position?.count ?? 0,
          instanced: !!m.isInstancedMesh || !!m.geometry?.attributes?.instance,
        }))
        .sort((a, b) => b.indexCount - a.indexCount)
        .slice(0, 8);
      return {
        drawCalls: r?.info?.render?.calls ?? -1,
        triangles: r?.info?.render?.triangles ?? -1,
        geometries: r?.info?.memory?.geometries ?? -1,
        textures: r?.info?.memory?.textures ?? -1,
        programs: r?.info?.programs?.length ?? -1,
        worldMeshes: meshes.length,
        biggestMeshes: big,
      };
    },
    /**
     * Split one pick into its two production halves: the GPU fast pick
     * (FastModelPickers.getFullPick) and the three.js linear intersect over
     * all world meshes. Returns both timings + inventory.
     */
    pickSplit: async (clientX: number, clientY: number) => {
      const canvas: HTMLCanvasElement | null =
        (ctx as any)?.world?.renderer?.three?.domElement ?? document.querySelector("canvas");
      if (!canvas) throw new Error("no canvas");
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + clientX, y = rect.top + clientY;
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
      }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const comps: any = (ctx as any).components;
      const OBC = await import("@thatopen/components");
      const caster: any = comps.get(OBC.Raycasters).get((ctx as any).world);
      const position = caster.mouse.position;
      const items = Array.from((ctx as any).world.meshes);
      // fast GPU pick
      const t0 = performance.now();
      let fastHit: any = null;
      try {
        const fastPicker = comps.get(OBC.FastModelPickers).get((ctx as any).world);
        fastHit = await fastPicker.getFullPick(position);
      } catch { /* */ }
      const t1 = performance.now();
      // three.js linear intersect over all world meshes
      const t2 = performance.now();
      let hits = -1;
      try {
        caster.three.setFromCamera(position, (ctx as any).world.camera.three);
        const res = caster.three.intersectObjects(items);
        hits = res.length;
      } catch { /* */ }
      const t3 = performance.now();
      return {
        fastPickMs: Math.round((t1 - t0) * 10) / 10,
        fastHit: !!fastHit,
        intersectMs: Math.round((t3 - t2) * 10) / 10,
        items: items.length,
        hits,
      };
    },
    /** Production properties-palette open path (features/property-palette.ts). */
    openPropertyPalette: async () => {
      const pal: any = (ctx as any)?.features?.propertyPalette;
      if (!pal?.open) throw new Error("propertyPalette not ready");
      const t0 = performance.now();
      pal.open();
      return { ms: performance.now() - t0 };
    },
    isPropertyPaletteVisible: (): boolean => {
      try { return !!(ctx as any)?.features?.propertyPalette?.isVisible?.(); }
      catch { return false; }
    },
    /** Production IFC export of the authored project, timed (serialization). */
    serializeProject: async () => {
      const t0 = performance.now();
      let bytes = -1;
      try {
        const proj: any = (ctx as any)?.features?.projects;
        if (proj?.exportProject) {
          const blob: Blob = await proj.exportProject();
          bytes = blob.size;
        } else {
          return { supported: false };
        }
      } catch (e: any) {
        return { supported: true, error: e?.message ?? String(e) };
      }
      return { supported: true, ms: performance.now() - t0, bytes };
    },
  };

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
    ...benchHelpers,
  };

  console.log(
    "[perf] performance engine ready. BVH: " +
      (bvhInstalled ? "installed" : "not available") +
      ". Batching: OFF (enable via __obsPerf.setBatchingEnabled(true))",
  );
}
