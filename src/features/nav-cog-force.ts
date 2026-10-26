/**
 * Own MMB orbit when a selection exists, pivoting about selection COG.
 * Priority 80 > navigation (30), so this handler claims the gesture first.
 * Also fixes orthographic wheel zoom about that same pivot.
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

  // Fragment selection
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

  // Authored selection - try every known API
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

        // World box helper
        const wb = a.getElementWorldBox?.(el);
        if (wb && !wb.isEmpty?.()) {
          box.union(wb);
          any = true;
          continue;
        }

        // Mesh / Object3D
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

        // Placement
        const p = el.params ?? el;
        const x = Number(p.x ?? p.origin?.x ?? el.position?.x);
        const y = Number(p.y ?? p.origin?.y ?? el.position?.y);
        const z = Number(p.z ?? p.origin?.z ?? el.position?.z);
        if ([x, y, z].every((n) => Number.isFinite(n))) {
          box.expandByPoint(new THREE.Vector3(x, y, z));
          // Expand a bit so single points still form a box
          box.expandByScalar(0.05);
          any = true;
        }
      }
    }
  } catch {
    /* */
  }

  // Highlighted / selected THREE objects in the scene
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
      // small sphere
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

  // Keep radius stable; for ortho radius is less meaningful but position still moves
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

  // Keep controls target locked on pivot
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
  // Only claim when we have a selection COG and user wants orbit (Shift/Ctrl+MMB)
  // or always on MMB orbit-style with shift
  if (g.kind === "drag-start" && g.button === 1) {
    if (!hasCog) return false;
    const wantOrbit =
      g.mods.shift || g.mods.ctrl || g.mods.meta;
    // Also claim plain MMB orbit if user holds shift on keyboard
    // For BIM: Shift+MMB = orbit. Plain MMB = pan (leave to navigation).
    if (!wantOrbit) {
      // Pan must never re-aim the camera: leave the target alone.
      return false; // let navigation pan
    }
    beginOrbit(g.event, cog);
    return true; // claim gesture - navigation will NOT receive it
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

/* -- Ortho zoom about COG ------------------------------------------------ */

function zoomAboutPivot(factor: number): void {
  if (!worldReady()) return;
  const cam = camera();
  const c = controls();
  const pivot = hasCog ? cog.clone() : new THREE.Vector3();
  if (!hasCog) {
    if (c?.target?.isVector3) pivot.copy(c.target);
    else {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      pivot.copy(cam.position).addScaledVector(dir, 10);
    }
  }

  if (cam.isOrthographicCamera) {
    const z = Math.max(1e-4, Number(cam.zoom) || 1);
    cam.zoom = Math.max(0.01, Math.min(8000, z * factor));
    syncOrthoZoom(cam);
    cam.updateProjectionMatrix();
    try {
      c?.setLookAt?.(
        cam.position.x,
        cam.position.y,
        cam.position.z,
        pivot.x,
        pivot.y,
        pivot.z,
        false,
      );
      c?.update?.(0);
    } catch {
      /* */
    }
  } else {
    const offset = new THREE.Vector3().subVectors(cam.position, pivot);
    const dist = offset.length();
    if (dist < 1e-6) return;
    const newDist = Math.max(1e-4, dist / factor);
    offset.normalize().multiplyScalar(newDist);
    const np = pivot.clone().add(offset);
    try {
      c?.setLookAt?.(np.x, np.y, np.z, pivot.x, pivot.y, pivot.z, false);
      c?.update?.(0);
    } catch {
      cam.position.copy(np);
      cam.lookAt(pivot);
    }
  }
  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* */
  }
}

function installWheel(): void {
  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      try {
        if ((window as Any).__OBS_MMB_HELD) return;
        // Self-contained overlays (CAD Viewer) handle their own wheel zoom.
        if ((e.target as HTMLElement | null)?.closest?.("#obs-cad-viewer,[data-obs-own-wheel]")) return;
        // One wheel authority: wheel-arbiter owns zoom (cursor-centred, ortho + perspective).
        if ((window as Any).__OBS_WHEEL_AUTHORITY) return;
        const cam = camera();
        if (!cam) return;

        // (Zoom never re-aims the camera: the target is not forced onto the COG here.)

        // Own zoom when: orthographic OR selection COG active
        const own = cam.isOrthographicCamera || hasCog;
        if (!own) return;

        const host = (ctx as Any).rightHost as HTMLElement | undefined;
        if (host && e.target && host.contains(e.target as Node) === false) {
          const t = e.target as HTMLElement;
          if (t.closest?.("#obs-parity-tabs,input,textarea,button")) return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();

        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        if (e.deltaMode === 2) dy *= 400;
        const zoomIn = dy < 0;
        const base = e.shiftKey ? 1.28 : 1.12;
        zoomAboutPivot(zoomIn ? base : 1 / base);
      } catch {
        /* */
      }
    },
    { capture: true, passive: false },
  );
}

/* -- Setup --------------------------------------------------------------- */

export function setupNavCogForce(): void {
  if (installed) return;
  installed = true;

  // Priority 80 > navigation 30
  try {
    inputRouter.subscribe(onGesture, 80);
  } catch (e) {
    console.warn("[nav-cog-force] inputRouter subscribe failed", e);
  }

  installWheel();

  // Selection watch
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
      zoomAboutPivot(e.shiftKey ? 1.35 : 1.18);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAboutPivot(e.shiftKey ? 1 / 1.35 : 1 / 1.18);
    }
  });

  (window as Any).__obsNavCog = {
    refresh: refreshCOG,
    zoomIn: () => zoomAboutPivot(1.2),
    zoomOut: () => zoomAboutPivot(1 / 1.2),
    hasCog: () => hasCog,
    getCog: () => (hasCog ? cog.clone() : null),
  };

  console.log(
    "[nav-cog-force] PRIORITY 80 orbit about selection COG + ortho zoom + pivot marker",
  );
}
