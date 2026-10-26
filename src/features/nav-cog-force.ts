/**
 * Own MMB orbit when a selection exists, pivoting about selection COG.
 * Priority 80 > navigation (30), so this handler claims the gesture first.
 *
 * Wheel zoom is NOT handled here — wheel-arbiter is the sole owner
 * (__OBS_WHEEL_AUTHORITY). A previous path called setLookAt toward the COG
 * on every wheel tick, which rotated the camera during zoom.
 *
 * Draws a small 3D crosshair at the active pivot so you can verify it.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { forceResumeCameraControls } from "../core/camera-gate";
import { syncOrthoZoom } from "../core/ortho-zoom";

type Any = Record<string, any>;

let installed = false;
let cog = new THREE.Vector3();
let hasCog = false;
let lastSelKey = "";

type OrbitState = {
  startX: number;
  startY: number;
  pivot: THREE.Vector3;
  startSpherical: THREE.Spherical;
  pixelsToRadians: number;
} | null;

let orbit: OrbitState = null;
let pivotHelper: THREE.Group | null = null;

function worldReady(): boolean {
  try {
    return !!(ctx as Any).world?.camera?.three;
  } catch {
    return false;
  }
}

function camera(): Any {
  return (ctx as Any).world.camera.three;
}

function controls(): Any {
  return (ctx as Any).world.camera.controls;
}

/* -- Selection COG ------------------------------------------------------- */

async function refreshCOG(): Promise<boolean> {
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
      else if (a.selection?.ids) ids = [...a.selection.ids];

      for (const id of ids) {
        const el =
          a.getElementById?.(id) ??
          a.getElement?.(id) ??
          (Array.isArray(a.elements) ? a.elements.find((e: Any) => e.id === id) : null);

        if (!el) continue;

        const wb = a.getElementWorldBox?.(el);
        if (wb && !wb.isEmpty?.()) {
          box.union(wb);
          any = true;
          continue;
        }

        const mesh =
          el.mesh ??
          el.object3d ??
          el.object ??
          el.group ??
          el.root;
        if (mesh && mesh.isObject3D) {
          mesh.updateWorldMatrix?.(true, true);
          const b = new THREE.Box3().setFromObject(mesh as THREE.Object3D);
          if (!b.isEmpty()) {
            box.union(b);
            any = true;
            continue;
          }
        }

        const p = el.params ?? el;
        const x = Number(p.x ?? p.origin?.x ?? el.position?.x);
        const y = Number(p.y ?? p.origin?.y ?? el.position?.y);
        const z = Number(p.z ?? p.origin?.z ?? el.position?.z);
        if ([x, y, z].every((n) => Number.isFinite(n))) {
          box.expandByPoint(new THREE.Vector3(x, y, z));
          box.expandByScalar(0.05);
          any = true;
        }
      }
    }
  } catch {
    /* */
  }

  try {
    const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
    if (scene) {
      scene.traverse((o: Any) => {
        if (
          o.userData?.selected ||
          o.userData?.obsSelected ||
          o.userData?.isSelected ||
          o.userData?.highlight
        ) {
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

  if (!any || box.isEmpty()) {
    hasCog = false;
    hidePivotHelper();
    (window as Any).__OBS_HAS_SELECTION_PIVOT = false;
    (window as Any).__OBS_ORBIT_PIVOT = null;
    return false;
  }

  box.getCenter(cog);
  hasCog = true;
  (window as Any).__OBS_HAS_SELECTION_PIVOT = true;
  (window as Any).__OBS_ORBIT_PIVOT = cog.clone();
  showPivotHelper(cog);
  return true;
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

/* -- Visible pivot marker ------------------------------------------------ */

function showPivotHelper(p: THREE.Vector3): void {
  try {
    const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
    if (!scene) return;
    if (!pivotHelper) {
      pivotHelper = new THREE.Group();
      pivotHelper.name = "obs-sel-cog-pivot";
      const makeAxis = (dir: THREE.Vector3, color: number) => {
        const geo = new THREE.BufferGeometry().setFromPoints([
          dir.clone().multiplyScalar(-0.4),
          dir.clone().multiplyScalar(0.4),
        ]);
        const mat = new THREE.LineBasicMaterial({
          color,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        return line;
      };
      pivotHelper.add(makeAxis(new THREE.Vector3(1, 0, 0), 0xff4466));
      pivotHelper.add(makeAxis(new THREE.Vector3(0, 1, 0), 0x44ff88));
      pivotHelper.add(makeAxis(new THREE.Vector3(0, 0, 1), 0x4488ff));
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 12, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffcc00,
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        }),
      );
      sph.renderOrder = 1000;
      pivotHelper.add(sph);
      scene.add(pivotHelper);
    }
    pivotHelper.visible = true;
    pivotHelper.position.copy(p);
  } catch {
    /* */
  }
}

function hidePivotHelper(): void {
  if (pivotHelper) pivotHelper.visible = false;
}

/* -- Orbit about COG (we own the gesture) -------------------------------- */

function beginOrbit(e: PointerEvent, pivot: THREE.Vector3): void {
  const cam = camera();
  const camToPivot = new THREE.Vector3().subVectors(cam.position, pivot);
  const spherical = new THREE.Spherical().setFromVector3(camToPivot);
  const host = (ctx as Any).rightHost as HTMLElement;
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
  const sph = orbit.startSpherical.clone();
  sph.theta -= dx * orbit.pixelsToRadians;
  sph.phi += dy * orbit.pixelsToRadians;
  sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi));

  if (cam.isOrthographicCamera) {
    sph.radius = Math.max(sph.radius, 1);
  }

  const newPos = orbit.pivot
    .clone()
    .add(new THREE.Vector3().setFromSpherical(sph));

  try {
    if (c && c.enabled === false) c.enabled = true;
  } catch {
    /* */
  }

  try {
    c.setLookAt(
      newPos.x,
      newPos.y,
      newPos.z,
      orbit.pivot.x,
      orbit.pivot.y,
      orbit.pivot.z,
      false,
    );
    try {
      c.update?.(0);
    } catch {
      /* */
    }
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
    const host = (ctx as Any).rightHost as HTMLElement;
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
  if (g.kind === "drag-start" && g.button === 1) {
    if (!hasCog) return false;
    const wantOrbit = g.mods.shift || g.mods.ctrl || g.mods.meta;
    if (!wantOrbit) {
      return false; // let navigation pan
    }
    beginOrbit(g.event, cog);
    return true;
  }

  if (g.kind === "drag-move" && g.button === 1) {
    if (!orbit) return false;
    applyOrbit(g.dx, g.dy);
    return true;
  }

  if (g.kind === "drag-end" && g.button === 1) {
    if (!orbit) return false;
    endOrbit();
    return true;
  }

  return false;
}

/**
 * Keyboard +/- zoom: pure view-axis translation.
 * NEVER setLookAt toward the COG — that rotates the camera.
 */
function zoomAboutViewAxis(factor: number): void {
  if (!worldReady()) return;
  const cam = camera();
  const c = controls();
  const q = cam.quaternion.clone();
  const up = cam.up.clone();

  if (cam.isOrthographicCamera) {
    const z = Math.max(1e-4, Number(cam.zoom) || 1);
    cam.zoom = Math.max(0.01, Math.min(8000, z * factor));
    syncOrthoZoom(cam);
    cam.updateProjectionMatrix();
    cam.quaternion.copy(q);
    cam.up.copy(up);
    try {
      c?.update?.(0);
    } catch {
      /* */
    }
    cam.quaternion.copy(q);
    cam.up.copy(up);
  } else {
    const target = new THREE.Vector3();
    try {
      if (typeof c?.getTarget === "function") c.getTarget(target);
      else if (c?.target?.isVector3) target.copy(c.target);
      else {
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        target.copy(cam.position).addScaledVector(dir, 10);
      }
    } catch {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      target.copy(cam.position).addScaledVector(dir, 10);
    }

    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const dist = Math.max(target.clone().sub(cam.position).dot(fwd), 0.5);
    const newDist = Math.max(0.05, dist / factor);
    const along = dist - newDist;

    // Translate eye and target together along the view axis.
    cam.position.addScaledVector(fwd, along);
    target.addScaledVector(fwd, along);
    try {
      if (typeof c?.setTarget === "function") {
        c.setTarget(target.x, target.y, target.z, false);
      } else if (c?.target?.isVector3) {
        c.target.copy(target);
      }
      if (typeof c?.setPosition === "function") {
        c.setPosition(cam.position.x, cam.position.y, cam.position.z, false);
      }
      c?.update?.(0);
    } catch {
      /* */
    }
    cam.quaternion.copy(q);
    cam.up.copy(up);
    cam.updateMatrixWorld?.(true);
  }

  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* */
  }
}

function installWheel(): void {
  // Intentionally empty: wheel-arbiter owns all viewport wheel zoom.
  // A previous implementation here called setLookAt toward the selection COG
  // on every wheel tick, which rotated the camera during zoom.
  window.addEventListener(
    "wheel",
    (_e: WheelEvent) => {
      // Permanent yield — do not process wheel here.
      return;
    },
    { capture: true, passive: true },
  );
}

/* -- Setup --------------------------------------------------------------- */

export function setupNavCogForce(): void {
  if (installed) return;
  installed = true;

  try {
    inputRouter.subscribe(onGesture, 80);
  } catch (e) {
    console.warn("[nav-cog-force] inputRouter subscribe failed", e);
  }

  installWheel();

  const tick = () => {
    const k = selectionKey();
    if (k !== lastSelKey) {
      lastSelKey = k;
      void refreshCOG();
    }
  };
  window.setInterval(tick, 200);
  window.addEventListener("obs:selection-changed", () => void refreshCOG());
  window.addEventListener("obs:authoring-selection-changed", () => void refreshCOG());
  window.addEventListener("pointerup", () => {
    window.setTimeout(() => void refreshCOG(), 30);
  });

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t?.closest?.("input,textarea,[contenteditable],select")) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAboutViewAxis(e.shiftKey ? 1.35 : 1.18);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAboutViewAxis(e.shiftKey ? 1 / 1.35 : 1 / 1.18);
    }
  });

  (window as Any).__obsNavCog = {
    refresh: refreshCOG,
    zoomIn: () => zoomAboutViewAxis(1.2),
    zoomOut: () => zoomAboutViewAxis(1 / 1.2),
    hasCog: () => hasCog,
    getCog: () => (hasCog ? cog.clone() : null),
  };

  console.log(
    "[nav-cog-force] PRIORITY 80 orbit about selection COG; wheel deferred to wheel-arbiter",
  );
}
