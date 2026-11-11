/**
 * Authored-mesh clip sync — the bridge that makes 3D section cuts work on
 * the model the user actually authors.
 *
 * ThatOpen's Clipper applies its planes only to materials of meshes in
 * `world.meshes` (Clipper.updateMaterialsAndPlanes walks exactly that set),
 * and the OBC raycaster picks against the same set. Authored elements are
 * plain three.js meshes in the authoring group and were never registered,
 * so double-click section planes and section-box faces silently did nothing
 * to them: the plane appeared, the model stayed whole.
 *
 * This module keeps `world.meshes` in sync with the authoring group:
 *   • new authored meshes are registered on every authoring change (plus a
 *     slow safety interval for rebuilds that skip the event, e.g. undo);
 *   • meshes removed from the group are pruned so deleted elements don't
 *     leak or keep ghost-clipping;
 *   • OBC then handles the rest natively — picks, cuts and live arrow-drag
 *     updates all flow through its own machinery.
 *
 * If a future SDK drops `world.meshes`, a material-mirror fallback keeps
 * cuts working: the live clipper planes are applied straight onto authored
 * materials (local clipping, like OBC does for fragments) with change
 * detection so orbiting stays free.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { getAuthoredGroup, onAuthoringChange } from "./authoring";
import { extractClipperPlanes, planesKey } from "./section-authored-clip-math";

let started = false;
let offAuthoring: (() => void) | null = null;
let safetyTimer: ReturnType<typeof setInterval> | null = null;
let raf = 0;
let frame = 0;
let lastKey = "";

/** Meshes we registered into world.meshes (for precise pruning). */
const registered = new Set<THREE.Object3D>();

/** Reused plane array for the fallback mirror — materials hold the reference. */
let livePlanes: THREE.Plane[] = [];

function authoredRoot(): THREE.Object3D | null {
  try {
    return getAuthoredGroup();
  } catch {
    return null;
  }
}

/* ── Primary path: register into world.meshes (OBC-native) ────────────── */

function syncWorldMeshes(): void {
  const root = authoredRoot();
  const world = (ctx as unknown as { world?: { meshes?: Set<THREE.Object3D> } }).world;
  const meshes = world?.meshes;
  if (!meshes) return;

  // Prune: gone from the authoring group → gone from the world set.
  for (const m of [...registered]) {
    if (!root || !m.parent) {
      meshes.delete(m);
      registered.delete(m);
    }
  }
  if (!root) return;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !registered.has(o)) {
      meshes.add(o);
      registered.add(o);
    }
  });
}

/* ── Fallback path: mirror clipper planes onto authored materials ─────── */

type PlaneThree = THREE.Plane;

function collectClipperPlanes(): PlaneThree[] {
  const out: PlaneThree[] = [];
  try {
    const c = (ctx as unknown as { clipper?: { list?: unknown; get?: (w: unknown) => unknown } }).clipper;
    if (!c) return out;
    let items: unknown[] = [];
    if (c.list && typeof (c.list as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
      items = Array.from(c.list as Iterable<unknown>);
    } else if (typeof c.get === "function") {
      const got = c.get((ctx as unknown as { world?: unknown }).world);
      if (Array.isArray(got)) items = got;
      else if (got && typeof got === "object") items = [got];
    }
    for (const p of extractClipperPlanes(items)) {
      out.push(new THREE.Plane(
        new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z),
        p.constant,
      ));
    }
  } catch {
    /* clipper absent or API drift — authored meshes simply stay unclipped */
  }
  return out;
}

function walkMaterials(apply: (m: THREE.Material) => void): void {
  const root = authoredRoot();
  if (!root) return;
  root.traverse((o: THREE.Object3D) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) for (const m of mat) apply(m);
    else apply(mat);
  });
}

function mirrorSync(): void {
  raf = requestAnimationFrame(mirrorSync);
  frame++;

  const planes = collectClipperPlanes();
  const key = planesKey(planes.map((p) => ({
    normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
    constant: p.constant,
  })));

  // Re-walk when planes changed, or every 30th frame to catch newly
  // authored/rebuilt meshes (their materials need the reference).
  if (key === lastKey && frame % 30 !== 0) return;
  lastKey = key;

  const renderer = (ctx.world as unknown as { renderer?: { three?: THREE.WebGLRenderer } })?.renderer?.three;
  if (planes.length && renderer) renderer.localClippingEnabled = true;

  livePlanes = planes;

  walkMaterials((m) => {
    const mat = m as THREE.Material & { clippingPlanes: THREE.Plane[] | null; clipShadows: boolean };
    if (!("clippingPlanes" in mat)) return;
    mat.clippingPlanes = planes.length ? livePlanes : null;
    mat.clipShadows = true;
  });
}

/* ── Lifecycle ────────────────────────────────────────────────────────── */

/** Idempotent — starts the authored-clip bridge once. */
export function startAuthoredClipSync(): void {
  if (started) return;
  started = true;

  const world = (ctx as unknown as { world?: { meshes?: Set<THREE.Object3D> } }).world;
  if (world?.meshes && typeof world.meshes.add === "function") {
    // Native path — OBC clips and raycasts world.meshes itself.
    syncWorldMeshes();
    offAuthoring = onAuthoringChange(syncWorldMeshes);
    // Safety net: element rebuilds that skip the authoring event (undo,
    // imports) re-sync on a slow tick; pruning makes repeats cheap.
    safetyTimer = setInterval(syncWorldMeshes, 2000);
  } else {
    // SDK drift fallback — mirror planes onto authored materials per frame.
    raf = requestAnimationFrame(mirrorSync);
  }
}

export function stopAuthoredClipSync(): void {
  if (!started) return;
  started = false;
  offAuthoring?.(); offAuthoring = null;
  if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null; }
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const world = (ctx as unknown as { world?: { meshes?: Set<THREE.Object3D> } }).world;
  if (world?.meshes) {
    for (const m of registered) world.meshes.delete(m);
  }
  registered.clear();
  walkMaterials((m) => {
    const mat = m as THREE.Material & { clippingPlanes: THREE.Plane[] | null };
    if ("clippingPlanes" in mat) mat.clippingPlanes = null;
  });
}
