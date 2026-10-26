/**
 * Shift + Left Mouse Button — orbit camera around selection (or target).
 *
 * Priority 85 > navigation (default) so this claims the gesture before
 * box-select starts. Wheel zoom is intentionally not handled here.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { forceResumeCameraControls } from "../core/camera-gate";

type Any = Record<string, any>;

let installed = false;

type OrbitState = {
  startX: number;
  startY: number;
  pivot: THREE.Vector3;
  startSpherical: THREE.Spherical;
  pixelsToRadians: number;
} | null;

let orbit: OrbitState = null;
let cachedCog: THREE.Vector3 | null = null;
let lastSelKey = "";

function controls(): Any {
  return (ctx as Any).world?.camera?.controls ?? null;
}

function camera(): THREE.Camera | null {
  try {
    const c = controls()?.camera;
    if (c?.isCamera) return c as THREE.Camera;
  } catch {
    /* */
  }
  const t = (ctx as Any).world?.camera?.three;
  return t?.isCamera ? (t as THREE.Camera) : null;
}

function getTarget(out = new THREE.Vector3()): THREE.Vector3 {
  const c = controls();
  try {
    if (typeof c?.getTarget === "function") {
      c.getTarget(out);
      if (Number.isFinite(out.x)) return out;
    }
  } catch {
    /* */
  }
  try {
    if (c?.target?.isVector3) return out.copy(c.target);
  } catch {
    /* */
  }
  return out.set(0, 0, 0);
}

function selectionKey(): string {
  try {
    const sel = (ctx.features as Any)?.selection;
    const a = (ctx.features as Any)?.authoring;
    const frag = sel?.size?.() ?? 0;
    const ids = a?.getSelectedIds?.() ?? a?.selectedIds ?? [];
    return `${frag}|${Array.isArray(ids) ? ids.join(",") : ""}`;
  } catch {
    return "";
  }
}

async function refreshCog(): Promise<void> {
  const box = new THREE.Box3();
  let any = false;
  try {
    const sel = (ctx.features as Any)?.selection;
    if (sel?.boundingBox) {
      const b = await sel.boundingBox();
      if (b && !b.isEmpty()) {
        box.union(b);
        any = true;
      }
    }
  } catch {
    /* */
  }
  try {
    const a = (ctx.features as Any)?.authoring;
    if (a) {
      let ids: string[] = [];
      if (typeof a.getSelectedIds === "function") ids = a.getSelectedIds() || [];
      else if (Array.isArray(a.selectedIds)) ids = a.selectedIds;
      for (const id of ids) {
        const el = a.getElementById?.(id) ?? a.getElement?.(id);
        if (!el) continue;
        const wb = a.getElementWorldBox?.(el);
        if (wb && !wb.isEmpty?.()) {
          box.union(wb);
          any = true;
          continue;
        }
        const mesh = el.mesh ?? el.object3d ?? el.object ?? el.group;
        if (mesh?.isObject3D) {
          mesh.updateWorldMatrix?.(true, true);
          const b = new THREE.Box3().setFromObject(mesh as THREE.Object3D);
          if (!b.isEmpty()) {
            box.union(b);
            any = true;
          }
        }
      }
    }
  } catch {
    /* */
  }
  if (any && !box.isEmpty()) {
    cachedCog = box.getCenter(new THREE.Vector3());
  } else {
    cachedCog = null;
  }
}

function pivotNow(): THREE.Vector3 {
  if (cachedCog) return cachedCog.clone();
  return getTarget();
}

function beginOrbit(e: PointerEvent, pivot: THREE.Vector3): void {
  const cam = camera();
  if (!cam) return;
  const offset = new THREE.Vector3().subVectors(cam.position, pivot);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  const host = (ctx as Any).rightHost as HTMLElement | undefined;
  const rect = host?.getBoundingClientRect?.() ?? { height: 600 };
  orbit = {
    startX: e.clientX,
    startY: e.clientY,
    pivot: pivot.clone(),
    startSpherical: spherical,
    pixelsToRadians: (Math.PI * 2) / Math.max(rect.height, 400),
  };
  try {
    forceResumeCameraControls();
  } catch {
    /* */
  }
  if (host) host.style.cursor = "grabbing";
}

function applyOrbit(dx: number, dy: number): void {
  if (!orbit) return;
  const cam = camera();
  const c = controls();
  if (!cam) return;

  const sph = orbit.startSpherical.clone();
  sph.theta -= dx * orbit.pixelsToRadians * 1.4;
  sph.phi -= dy * orbit.pixelsToRadians * 1.4;
  sph.phi = THREE.MathUtils.clamp(sph.phi, 0.02, Math.PI - 0.02);

  if ((cam as Any).isOrthographicCamera) {
    sph.radius = Math.max(sph.radius, 1);
  }

  const newPos = orbit.pivot.clone().add(new THREE.Vector3().setFromSpherical(sph));

  try {
    if (c && c.enabled === false) c.enabled = true;
  } catch {
    /* */
  }

  try {
    c?.setLookAt?.(
      newPos.x,
      newPos.y,
      newPos.z,
      orbit.pivot.x,
      orbit.pivot.y,
      orbit.pivot.z,
      false,
    );
    c?.update?.(0);
  } catch {
    cam.position.copy(newPos);
    cam.lookAt(orbit.pivot);
  }
  try {
    if (c?.target?.isVector3) c.target.copy(orbit.pivot);
  } catch {
    /* */
  }
}

function endOrbit(): void {
  orbit = null;
  try {
    const host = (ctx as Any).rightHost as HTMLElement | undefined;
    if (host) host.style.cursor = "";
  } catch {
    /* */
  }
  try {
    forceResumeCameraControls();
  } catch {
    /* */
  }
}

function onGesture(g: Gesture): boolean {
  // Shift + LMB only (no Ctrl/Meta/Alt — those keep other meanings).
  if (g.kind === "drag-start" && g.button === 0) {
    if (!g.mods.shift || g.mods.ctrl || g.mods.meta || g.mods.alt) return false;
    beginOrbit(g.event, pivotNow());
    return true;
  }
  if (g.kind === "drag-move" && g.button === 0) {
    if (!orbit) return false;
    applyOrbit(g.dx, g.dy);
    return true;
  }
  if (g.kind === "drag-end" && g.button === 0) {
    if (!orbit) return false;
    endOrbit();
    return true;
  }
  return false;
}

export function setupShiftLmbOrbit(): void {
  if (installed) return;
  installed = true;

  try {
    inputRouter.subscribe(onGesture, 85);
  } catch (e) {
    console.warn("[shift-lmb-orbit] subscribe failed", e);
  }

  const tick = () => {
    const k = selectionKey();
    if (k !== lastSelKey) {
      lastSelKey = k;
      void refreshCog();
    }
  };
  window.setInterval(tick, 250);
  window.addEventListener("obs:selection-changed", () => void refreshCog());
  window.addEventListener("obs:authoring-selection-changed", () => void refreshCog());

  (window as Any).__obsShiftLmbOrbit = {
    refresh: refreshCog,
    getPivot: () => pivotNow(),
  };

  console.log("[shift-lmb-orbit] Shift+LMB orbit around selection / target (priority 85)");
}
