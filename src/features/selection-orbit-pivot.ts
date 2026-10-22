/**
 * Selection orbit pivot + Ortho zoom fix
 *
 * When elements are selected, camera orbit / pan / zoom revolve around the
 * selection center of gravity (bounding-box center). Matches BIM:
 *   - With selection: rotate, pan, zoom about selection COG
 *   - Without selection: existing target / cursor zoom
 *   - Orthographic: zoom via camera.zoom (works); orbit still about pivot
 *
 * Shortcuts:
 *   VO / O          Toggle orthographic <-> perspective
 *   + / =           Zoom in  (toward selection COG if any)
 *   - / _           Zoom out
 *   ZO / ZS         Zoom to selection (fit box)
 *   Ctrl+Shift+O    Toggle ortho
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { syncOrthoZoom } from "../core/ortho-zoom";

type Any = Record<string, any>;

let installed = false;
let lastPivot = new THREE.Vector3();
let hasPivot = false;
let selectionListener: (() => void) | null = null;

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 1600 } }),
    );
  } catch {
    console.log(`[sel-pivot] ${msg}`);
  }
}

function worldReady(): boolean {
  try {
    return !!(ctx as Any).world?.camera?.three;
  } catch {
    return false;
  }
}

/** Compute center of gravity of current selection (authored + fragments). */
export async function computeSelectionCOG(): Promise<THREE.Vector3 | null> {
  const box = new THREE.Box3();
  let any = false;

  // 1) Fragment selection (IFC models)
  try {
    const sel = (ctx.features as Any)?.selection ?? (await import("./selection")).selection;
    if (sel?.boundingBox) {
      const b: THREE.Box3 | null = await sel.boundingBox();
      if (b && !b.isEmpty()) {
        box.union(b);
        any = true;
      }
    }
  } catch {
    /* */
  }

  // 2) Authored elements selection
  try {
    const a = (ctx.features as Any)?.authoring;
    const ids: string[] =
      a?.getSelectedIds?.() ??
      a?.selectedIds ??
      (a?.getSelection?.() ?? []).map((e: Any) => e?.id).filter(Boolean) ??
      [];
    const elements =
      a?.getElements?.() ??
      a?.elements ??
      (ctx as Any).authoring?.elements ??
      [];
    const byId = new Map<string, Any>();
    if (Array.isArray(elements)) {
      for (const el of elements) if (el?.id) byId.set(el.id, el);
    } else if (elements && typeof elements === "object") {
      for (const [k, v] of Object.entries(elements)) byId.set(k, v as Any);
    }

    for (const id of ids) {
      const el = byId.get(id);
      if (!el) continue;
      // Prefer mesh bounds
      const mesh = el.mesh ?? el.object3d ?? el.object;
      if (mesh && mesh.isObject3D) {
        const b = new THREE.Box3().setFromObject(mesh as THREE.Object3D);
        if (!b.isEmpty()) {
          box.union(b);
          any = true;
          continue;
        }
      }
      // Fallback: placement origin
      const p = el.params ?? el;
      const x = Number(p.x ?? p.origin?.x ?? el.position?.x);
      const y = Number(p.y ?? p.origin?.y ?? el.position?.y);
      const z = Number(p.z ?? p.origin?.z ?? el.position?.z);
      if ([x, y, z].every(Number.isFinite)) {
        box.expandByPoint(new THREE.Vector3(x, y, z));
        any = true;
      }
    }
  } catch {
    /* */
  }

  // 3) THREE scene objects marked selected
  try {
    const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
    if (scene) {
      scene.traverse((o: Any) => {
        if (o.userData?.selected || o.userData?.obsSelected) {
          const b = new THREE.Box3().setFromObject(o as THREE.Object3D);
          if (!b.isEmpty()) {
            box.union(b);
            any = true;
          }
        }
      });
    }
  } catch {
    /* */
  }

  if (!any || box.isEmpty()) return null;
  return box.getCenter(new THREE.Vector3());
}

export async function computeSelectionBox(): Promise<THREE.Box3 | null> {
  const cog = await computeSelectionCOG();
  if (!cog) return null;
  // Rebuild box for fit - reuse similar logic simplified via COG expansion
  const box = new THREE.Box3();
  try {
    const sel = (ctx.features as Any)?.selection;
    if (sel?.boundingBox) {
      const b = await sel.boundingBox();
      if (b && !b.isEmpty()) box.union(b);
    }
  } catch {
    /* */
  }
  try {
    const a = (ctx.features as Any)?.authoring;
    const ids: string[] = a?.getSelectedIds?.() ?? [];
    for (const id of ids) {
      const el = a?.getElement?.(id) ?? a?.elements?.find?.((e: Any) => e.id === id);
      const mesh = el?.mesh ?? el?.object3d;
      if (mesh) {
        const b = new THREE.Box3().setFromObject(mesh as THREE.Object3D);
        if (!b.isEmpty()) box.union(b);
      }
    }
  } catch {
    /* */
  }
  if (box.isEmpty()) {
    box.setFromCenterAndSize(cog, new THREE.Vector3(1, 1, 1));
  }
  return box;
}

/** Apply orbit pivot to CameraControls + navigation target. */
export function applyOrbitPivot(point: THREE.Vector3): void {
  if (!worldReady() || !point || !Number.isFinite(point.x)) return;
  lastPivot.copy(point);
  hasPivot = true;

  try {
    const tools = (ctx.features as Any)?.cameraTools;
    if (typeof tools?.setOrbitPivot === "function") {
      tools.setOrbitPivot(point);
    }
  } catch {
    /* */
  }

  // Direct controls write (always)
  try {
    const controls: Any = (ctx as Any).world?.camera?.controls;
    const cam = (ctx as Any).world?.camera?.three as THREE.Camera;
    if (controls) {
      if (controls.target?.isVector3) {
        controls.target.set(point.x, point.y, point.z);
      }
      if (typeof controls.setTarget === "function") {
        controls.setTarget(point.x, point.y, point.z, false);
      }
      if (typeof controls.setLookAt === "function" && cam) {
        const p = (cam as Any).position;
        controls.setLookAt(p.x, p.y, p.z, point.x, point.y, point.z, false);
        try {
          controls.update?.(0);
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* */
  }

  // Expose for navigation.ts Ctrl-orbit and wheel consumers
  try {
    (window as Any).__OBS_ORBIT_PIVOT = point.clone();
    (window as Any).__OBS_HAS_SELECTION_PIVOT = true;
  } catch {
    /* */
  }
}

export function clearOrbitPivotFlag(): void {
  hasPivot = false;
  try {
    (window as Any).__OBS_HAS_SELECTION_PIVOT = false;
    (window as Any).__OBS_ORBIT_PIVOT = null;
  } catch {
    /* */
  }
}

export async function syncPivotFromSelection(): Promise<boolean> {
  const cog = await computeSelectionCOG();
  if (!cog) {
    clearOrbitPivotFlag();
    return false;
  }
  applyOrbitPivot(cog);
  return true;
}

/* -- Zoom toward selection COG ------------------------------------------- */

export function zoomTowardSelection(factor: number): void {
  if (!worldReady()) return;
  const focus =
    hasPivot && lastPivot
      ? lastPivot.clone()
      : ((window as Any).__OBS_ORBIT_PIVOT as THREE.Vector3 | null) ?? null;

  try {
    // Prefer camera-tools zoomBy (handles ortho.zoom correctly)
    const tools = requireCameraTools();
    if (tools?.zoomBy) {
      tools.zoomBy(factor, focus ?? undefined);
      return;
    }
  } catch {
    /* */
  }

  // Fallback manual
  const cam: Any = (ctx as Any).world.camera.three;
  const controls: Any = (ctx as Any).world.camera.controls;
  const target = new THREE.Vector3();
  if (focus) target.copy(focus);
  else if (controls?.target?.isVector3) target.copy(controls.target);
  else {
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    target.copy(cam.position).addScaledVector(dir, 10);
  }

  if (cam.isOrthographicCamera) {
    const oldZ = Math.max(1e-3, cam.zoom || 1);
    // factor > 1 => zoom in (closer) => higher ortho.zoom
    cam.zoom = Math.max(0.01, Math.min(5000, oldZ * factor));
    syncOrthoZoom(cam);
    cam.updateProjectionMatrix();
  } else {
    const dir = new THREE.Vector3().subVectors(cam.position, target);
    const dist = dir.length();
    if (dist < 1e-6) return;
    const newDist = Math.max(1e-4, dist / factor);
    dir.normalize().multiplyScalar(newDist);
    const np = target.clone().add(dir);
    try {
      controls?.setLookAt?.(np.x, np.y, np.z, target.x, target.y, target.z, false);
      controls?.update?.(0);
    } catch {
      cam.position.copy(np);
      cam.lookAt(target);
    }
  }
  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* */
  }
}

function requireCameraTools(): Any | null {
  try {
    return (ctx.features as Any)?.cameraTools ?? null;
  } catch {
    return null;
  }
}

export async function zoomToSelection(): Promise<void> {
  const box = await computeSelectionBox();
  if (!box || box.isEmpty()) {
    toast("info", "Nothing selected to zoom to");
    return;
  }
  const tools = requireCameraTools();
  if (tools?.focusOnBox) {
    tools.focusOnBox(box);
  } else if (tools?.fitAll) {
    // fallback: center on COG
    const c = box.getCenter(new THREE.Vector3());
    applyOrbitPivot(c);
    tools.centerOnPoint?.(c);
  }
  applyOrbitPivot(box.getCenter(new THREE.Vector3()));
  toast("success", "Zoomed to selection");
}

/* -- Orthographic toggle (fixed) ----------------------------------------- */

export function isOrthographic(): boolean {
  if (!worldReady()) return false;
  const cam: Any = (ctx as Any).world.camera.three;
  if (cam?.isOrthographicCamera) return true;
  try {
    const tools = requireCameraTools();
    if (tools?.getProjection) return tools.getProjection() === "orthographic";
  } catch {
    /* */
  }
  return false;
}

export function setOrthographic(on: boolean): boolean {
  if (!worldReady()) return false;
  const tools = requireCameraTools();
  const mode = on ? "orthographic" : "perspective";

  // 1) Prefer camera-tools API
  if (tools?.setProjection) {
    const ok = tools.setProjection(mode);
    if (ok) {
      // Keep pivot after switch
      if (hasPivot) applyOrbitPivot(lastPivot);
      ensureOrthoFrustum();
      toast("info", on ? "Orthographic view" : "Perspective view");
      return true;
    }
  }

  // 2) ThatOpen / fragments camera setCameraType
  try {
    const camApi: Any = (ctx as Any).world.camera;
    if (typeof camApi.setCameraType === "function") {
      camApi.setCameraType(on ? "Plan" : "Orbit");
      if (hasPivot) applyOrbitPivot(lastPivot);
      ensureOrthoFrustum();
      toast("info", on ? "Orthographic view" : "Perspective view");
      return true;
    }
  } catch {
    /* */
  }

  toast("warn", "Could not switch projection on this camera API");
  return false;
}

export function toggleOrthographic(): boolean {
  return setOrthographic(!isOrthographic());
}

function ensureOrthoFrustum(): void {
  try {
    const cam: Any = (ctx as Any).world.camera.three;
    if (!cam?.isOrthographicCamera) return;
    const host = (ctx as Any).rightHost as HTMLElement | undefined;
    let aspect = 1;
    if (host) {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) aspect = r.width / r.height;
    }
    // Do not reset zoom - only fix near/far and frustum if degenerate
    if (!(cam.right > cam.left) || !(cam.top > cam.bottom)) {
      const halfH = 20;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
      cam.top = halfH;
      cam.bottom = -halfH;
    }
    cam.near = -1e6;
    cam.far = 1e6;
    if (!Number.isFinite(cam.zoom) || cam.zoom <= 0) cam.zoom = 1;
    cam.updateProjectionMatrix();
  } catch {
    /* */
  }
}

/* -- Wire selection change -> pivot -------------------------------------- */

function onSelectionMaybeChanged(): void {
  void syncPivotFromSelection();
}

function installSelectionListeners(): void {
  // Fragment selection events
  try {
    window.addEventListener("obs:selection-changed", onSelectionMaybeChanged);
    window.addEventListener("obs:authoring-selection-changed", onSelectionMaybeChanged);
    window.addEventListener("obs:authoring-changed", onSelectionMaybeChanged);
  } catch {
    /* */
  }

  // Poll lightly as backup (some selection paths miss events)
  let lastSize = -1;
  selectionListener = () => {
    try {
      const sel = (ctx.features as Any)?.selection;
      const a = (ctx.features as Any)?.authoring;
      const size =
        (sel?.size?.() ?? 0) +
        (a?.getSelectedIds?.()?.length ?? a?.selectedIds?.length ?? 0);
      if (size !== lastSize) {
        lastSize = size;
        onSelectionMaybeChanged();
      }
    } catch {
      /* */
    }
  };
  window.setInterval(selectionListener, 400);
}

/* -- Wheel: prefer selection pivot when present -------------------------- */

function installWheelPivotHook(): void {
  // When selection pivot is active, nudge wheel-arbiter zoom to use it by
  // temporarily setting controls target before zoom (arbiter reads target).
  window.addEventListener(
    "wheel",
    (e) => {
      if (!hasPivot) return;
      if ((window as Any).__OBS_MMB_HELD) return;
      try {
        const controls: Any = (ctx as Any).world?.camera?.controls;
        if (controls?.target?.isVector3) {
          controls.target.copy(lastPivot);
        }
      } catch {
        /* */
      }
    },
    { capture: true, passive: true },
  );
}

/* -- Keyboard ------------------------------------------------------------ */

function installKeys(): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t?.closest?.("input,textarea,[contenteditable],select")) return;

    const key = e.key;
    // Zoom in / out
    if (key === "+" || key === "=") {
      e.preventDefault();
      zoomTowardSelection(e.shiftKey ? 1.35 : 1.15);
      return;
    }
    if (key === "-" || key === "_") {
      e.preventDefault();
      zoomTowardSelection(e.shiftKey ? 1 / 1.35 : 1 / 1.15);
      return;
    }
    // Ctrl+Shift+O = ortho
    if (e.ctrlKey && e.shiftKey && (key === "O" || key === "o")) {
      e.preventDefault();
      toggleOrthographic();
      return;
    }
  });

  // Two-key chords VO, ZO via small buffer
  let buf = "";
  let bufTimer = 0;
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t?.closest?.("input,textarea,[contenteditable],select")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return;
    buf += e.key.toLowerCase();
    if (buf.length > 2) buf = buf.slice(-2);
    window.clearTimeout(bufTimer);
    bufTimer = window.setTimeout(() => {
      buf = "";
    }, 600);
    if (buf === "vo" || buf === "op") {
      e.preventDefault();
      buf = "";
      toggleOrthographic();
    } else if (buf === "zo" || buf === "zs") {
      e.preventDefault();
      buf = "";
      void zoomToSelection();
    }
  });
}

export function setupSelectionOrbitPivot(): void {
  if (installed) return;
  installed = true;

  installSelectionListeners();
  installWheelPivotHook();
  installKeys();

  // Initial sync
  window.setTimeout(() => void syncPivotFromSelection(), 800);

  (window as Any).__obsSelPivot = {
    sync: syncPivotFromSelection,
    cog: computeSelectionCOG,
    zoomIn: () => zoomTowardSelection(1.2),
    zoomOut: () => zoomTowardSelection(1 / 1.2),
    zoomToSelection,
    toggleOrtho: toggleOrthographic,
    setOrtho: setOrthographic,
    isOrtho: isOrthographic,
    applyPivot: applyOrbitPivot,
  };

  // Register camera-tools on ctx if missing link
  try {
    void import("./camera-tools").then((m: Any) => {
      if (!(ctx.features as Any).cameraTools) {
        (ctx.features as Any).cameraTools = m;
      }
    });
  } catch {
    /* */
  }

  console.log(
    "[selection-orbit-pivot] ready - orbit/zoom about selection COG; VO=ortho; +/-=zoom; ZO=zoom selection",
  );
}
