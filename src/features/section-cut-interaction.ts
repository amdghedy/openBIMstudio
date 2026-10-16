/**
 * Section cut interaction
 *
 * Double-click a model face -> section plane PARALLEL to that face.
 * Uses ThatOpen OBC.Raycasters (same path as selection) so IFC/fragment
 * geometry is detected correctly without BufferAttribute crashes.
 *
 * Hover cut arrow -> only arrow move; orbit/select blocked.
 * Press-drag arrow -> move plane; release -> stop.
 */

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { forceResumeCameraControls } from "../core/camera-gate";
import { whenNavigationBlocked } from "./navigation";

type Any = Record<string, any>;

let installed = false;
let dragging = false;
let hoverArrow = false;
let dragPlane: Any | null = null;
let dragPoint = new THREE.Vector3();
let pointerId: number | null = null;
let unblockNav: (() => void) | null = null;

function toast(msg: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { kind: "info", message: msg, timeout: 1600 },
      }),
    );
  } catch {
    /* */
  }
}

function hostEl(): HTMLElement | null {
  try {
    return (ctx as Any).rightHost as HTMLElement;
  } catch {
    return null;
  }
}

function camera(): THREE.Camera | null {
  try {
    return (ctx as Any).world?.camera?.three as THREE.Camera;
  } catch {
    return null;
  }
}

function isSectionEnabled(): boolean {
  try {
    return !!(ctx.features as Any)?.section?.isEnabled?.();
  } catch {
    return false;
  }
}

function releaseEverything(e?: PointerEvent | null): void {
  dragging = false;
  dragPlane = null;
  pointerId = null;
  try {
    forceResumeCameraControls();
  } catch {
    /* */
  }
  const host = hostEl();
  if (host) {
    host.style.cursor = hoverArrow ? "grab" : "";
    if (e) {
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* */
      }
    }
  }
  try {
    const target = host ?? document.body;
    target.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: e?.pointerId ?? 1,
        clientX: e?.clientX ?? 0,
        clientY: e?.clientY ?? 0,
        button: 0,
        buttons: 0,
      }),
    );
  } catch {
    /* */
  }
}

/* -- Face pick via OBC Raycasters + safe mesh fallback --------------------- */

interface FaceHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

function viewFacingNormal(): THREE.Vector3 {
  const n = new THREE.Vector3(0, 0, 1);
  const cam = camera();
  if (cam) {
    cam.getWorldDirection(n);
    n.negate();
  }
  if (n.lengthSq() < 1e-10) n.set(0, 0, 1);
  return n.normalize();
}

function normalFromRayResult(r: Any, point: THREE.Vector3): THREE.Vector3 {
  // ThatOpen / three ray results expose normal in several shapes
  const candidates = [
    r?.normal,
    r?.faceNormal,
    r?.face?.normal,
    r?.hitNormal,
    r?.worldNormal,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c.isVector3 || (typeof c.x === "number" && typeof c.y === "number")) {
      const n = new THREE.Vector3(c.x, c.y, c.z);
      if (n.lengthSq() > 1e-10) return n.normalize();
    }
    if (Array.isArray(c) && c.length >= 3) {
      const n = new THREE.Vector3(c[0], c[1], c[2]);
      if (n.lengthSq() > 1e-10) return n.normalize();
    }
  }

  // Fragment mesh may include object + face index - try face normal transform
  try {
    const face = r?.face;
    const obj = r?.object ?? r?.mesh;
    if (face?.normal && obj?.matrixWorld) {
      const n = face.normal.clone();
      const nm = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
      n.applyMatrix3(nm).normalize();
      if (n.lengthSq() > 1e-10) return n;
    }
  } catch {
    /* */
  }

  // Approximate: from camera to point (plane faces camera) - last resort
  void point;
  return viewFacingNormal();
}

async function pickFaceOBC(): Promise<FaceHit | null> {
  try {
    const components = (ctx as Any).components;
    if (!components?.get) return null;
    const raycasters = components.get(OBC.Raycasters);
    const caster = raycasters?.get?.((ctx as Any).world);
    if (!caster?.castRay) return null;

    const r: Any = await caster.castRay();
    if (!r) return null;

    // World hit point
    let point: THREE.Vector3 | null = null;
    if (r.point?.isVector3) point = r.point.clone();
    else if (r.point && typeof r.point.x === "number") {
      point = new THREE.Vector3(r.point.x, r.point.y, r.point.z);
    } else if (Array.isArray(r.point) && r.point.length >= 3) {
      point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
    } else if (r.position?.isVector3) point = r.position.clone();

    if (!point) return null;

    const normal = normalFromRayResult(r, point);
    return { point, normal };
  } catch (err) {
    console.warn("[section-cut] OBC castRay failed", err);
    return null;
  }
}

function isSafeMesh(obj: Any): boolean {
  try {
    if (!obj?.isMesh) return false;
    if (obj.userData?.isSectionHelper || obj.userData?.isClipperHelper) return false;
    const name = String(obj.name || "");
    if (/clip|gizmo|helper|axis|arrow|section|grid/i.test(name)) return false;
    const pos = obj.geometry?.attributes?.position;
    if (!pos?.array || pos.count < 3) return false;
    try {
      const x = pos.getX(0);
      if (!Number.isFinite(x)) return false;
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pickFaceMesh(clientX: number, clientY: number): FaceHit | null {
  try {
    const cam = camera();
    const host = hostEl();
    const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
    if (!cam || !host || !scene) return null;

    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);

    const targets: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (isSafeMesh(o as Any)) targets.push(o);
    });

    let hits: THREE.Intersection[] = [];
    try {
      hits = raycaster.intersectObjects(targets, false);
    } catch {
      for (const mesh of targets) {
        try {
          hits.push(...raycaster.intersectObject(mesh, false));
        } catch {
          /* */
        }
      }
      hits.sort((a, b) => a.distance - b.distance);
    }

    if (!hits.length) return null;
    const h = hits[0];
    const normal = new THREE.Vector3();
    if (h.face?.normal) {
      normal.copy(h.face.normal);
      try {
        const nm = new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld);
        normal.applyMatrix3(nm).normalize();
      } catch {
        normal.normalize();
      }
    } else {
      normal.copy(viewFacingNormal());
    }
    return { point: h.point.clone(), normal };
  } catch {
    return null;
  }
}

async function pickModelFace(clientX: number, clientY: number): Promise<FaceHit | null> {
  // 1) ThatOpen fragment raycaster - primary for IFC models
  const obc = await pickFaceOBC();
  if (obc) return obc;

  // 2) Safe THREE mesh raycast - authored solids
  const mesh = pickFaceMesh(clientX, clientY);
  if (mesh) return mesh;

  return null;
}

/* -- Clipper create / move ------------------------------------------------- */

function createPlaneAt(point: THREE.Vector3, normal: THREE.Vector3): void {
  const clipper: Any = (ctx as Any).clipper;
  if (!clipper) {
    toast("Clipper not ready");
    return;
  }
  const n = normal.clone().normalize();
  const p = point.clone();

  try {
    if (typeof clipper.createFromNormalAndCoplanarPoint === "function") {
      clipper.createFromNormalAndCoplanarPoint(ctx.world, n, p);
      return;
    }
  } catch (e) {
    console.warn("[section-cut] createFromNormal failed", e);
  }

  try {
    const item = clipper.create?.(ctx.world);
    const plane: THREE.Plane | undefined =
      item?.three?.plane ?? item?.plane ?? item?.three;
    if (plane?.normal) {
      plane.normal.copy(n);
      plane.constant = -p.dot(n);
    }
  } catch (e) {
    console.warn("[section-cut] create failed", e);
  }
}

function getPlaneFromItem(item: Any): THREE.Plane | null {
  try {
    const p = item?.three?.plane ?? item?.plane ?? (item?.three?.isPlane ? item.three : null);
    if (p?.normal && typeof p.constant === "number") return p as THREE.Plane;
  } catch {
    /* */
  }
  return null;
}

function collectClipperHelpers(): Array<{ item: Any; objects: THREE.Object3D[] }> {
  const out: Array<{ item: Any; objects: THREE.Object3D[] }> = [];
  try {
    const list = (ctx as Any).clipper?.list;
    if (!list) return out;
    const entries: Any[] = list[Symbol.iterator] ? [...list] : Object.values(list);
    for (const entry of entries) {
      const item = Array.isArray(entry) ? entry[1] : entry;
      if (!item) continue;
      const objects: THREE.Object3D[] = [];
      const push = (o: Any) => {
        if (o?.isObject3D) objects.push(o as THREE.Object3D);
        if (o?.object?.isObject3D) objects.push(o.object as THREE.Object3D);
      };
      for (const key of ["helper", "arrow", "mesh", "object", "three", "root", "group", "controls"]) {
        push(item[key]);
      }
      for (const o of objects) {
        o.traverse((ch) => {
          (ch as Any).userData = (ch as Any).userData || {};
          (ch as Any).userData.isClipperHelper = true;
        });
      }
      if (objects.length) out.push({ item, objects });
    }
  } catch {
    /* */
  }
  return out;
}

function pickClipperHandle(
  clientX: number,
  clientY: number,
): { item: Any; point: THREE.Vector3 } | null {
  try {
    const cam = camera();
    const host = hostEl();
    if (!cam || !host) return null;
    const rect = host.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    for (const g of collectClipperHelpers()) {
      try {
        const hits = raycaster.intersectObjects(g.objects, true);
        if (hits.length && hits[0].point) {
          return { item: g.item, point: hits[0].point.clone() };
        }
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
  return null;
}

function movePlaneAlongNormal(item: Any, clientX: number, clientY: number): void {
  const plane = getPlaneFromItem(item);
  const cam = camera();
  if (!plane || !cam) return;
  const host = hostEl();
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, cam);
  const n = plane.normal.clone().normalize();
  const camDir = new THREE.Vector3();
  cam.getWorldDirection(camDir);
  const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    camDir.clone().negate(),
    dragPoint,
  );
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(viewPlane, hit)) return;
  const dist = hit.clone().sub(dragPoint).dot(n);
  plane.constant -= dist;
  dragPoint.addScaledVector(n, dist);
  try {
    if (item.helper?.position) item.helper.position.addScaledVector(n, dist);
    if (typeof item.update === "function") item.update();
  } catch {
    /* */
  }
}

/* -- Hover lock ------------------------------------------------------------ */

function isArrowMode(): boolean {
  return hoverArrow || dragging;
}

/** Block select / window-select / box / authoring while arrow is live. */
function installGlobalMouseLock(): void {
  // Bubble-phase blockers on host: after our capture handlers run,
  // prevent selection / window-select from seeing click & LMB drag.
  // Do NOT use window capture stopImmediate on pointer* or our arrow drag breaks.
  const killSelectGestures = (e: Event) => {
    if (!isArrowMode()) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const attach = () => {
    const host = hostEl();
    if (!host) {
      window.setTimeout(attach, 400);
      return;
    }
    // These fire in bubble after our capture handlers - kill select/box-select
    host.addEventListener("click", killSelectGestures, false);
    host.addEventListener("dblclick", killSelectGestures, false);
    host.addEventListener("contextmenu", killSelectGestures, true);
    host.addEventListener("wheel", killSelectGestures, true);

    // Mark pointerdown so box-select can check the flag
    host.addEventListener(
      "pointerdown",
      () => {
        if (isArrowMode()) {
          (window as Any).__OBS_BLOCK_BOX_SELECT = true;
          (window as Any).__OBS_BLOCK_SELECT = true;
        }
      },
      true,
    );
  };
  attach();
}

function setArrowHover(on: boolean): void {
  if (hoverArrow === on) return;
  hoverArrow = on;
  const host = hostEl();
  if (on) {
    try {
      if (!unblockNav) unblockNav = whenNavigationBlocked(() => true);
    } catch {
      /* */
    }
    try {
      const c = (ctx as Any).world?.camera?.controls;
      if (c) c.enabled = false;
    } catch {
      /* */
    }
    if (host) {
      host.style.cursor = "grab";
      host.style.pointerEvents = "auto";
    }
    // Flags consumed by selection / box-select / navigation guards
    (window as Any).__OBS_SECTION_ARROW_HOVER = true;
    (window as Any).__OBS_SECTION_ARROW_LOCK = true;
    (window as Any).__OBS_BLOCK_SELECT = true;
    (window as Any).__OBS_BLOCK_BOX_SELECT = true;
  } else if (!dragging) {
    try {
      unblockNav?.();
    } catch {
      /* */
    }
    unblockNav = null;
    try {
      forceResumeCameraControls();
      const c = (ctx as Any).world?.camera?.controls;
      if (c) c.enabled = true;
    } catch {
      /* */
    }
    if (host) host.style.cursor = "";
    (window as Any).__OBS_SECTION_ARROW_HOVER = false;
    (window as Any).__OBS_SECTION_ARROW_LOCK = false;
    (window as Any).__OBS_BLOCK_SELECT = false;
    (window as Any).__OBS_BLOCK_BOX_SELECT = false;
  }
}

/* -- Events ---------------------------------------------------------------- */

async function onDblClick(e: MouseEvent): Promise<void> {
  if (!isSectionEnabled()) return;
  try {
    if ((ctx.features as Any)?.drawing?.isActive?.()) return;
    if ((ctx.features as Any)?.measure?.isEnabled?.()) return;
  } catch {
    /* */
  }

  e.preventDefault();
  e.stopPropagation();

  const face = await pickModelFace(e.clientX, e.clientY);
  if (!face) {
    toast("No model face under cursor");
    releaseEverything(e as unknown as PointerEvent);
    return;
  }

  // Parallel to the detected element face
  createPlaneAt(face.point, face.normal);

  window.setTimeout(() => releaseEverything(e as unknown as PointerEvent), 0);
  window.setTimeout(() => releaseEverything(null), 40);
  window.setTimeout(() => releaseEverything(null), 120);

  toast("Section parallel to face");
}

function onPointerMove(e: PointerEvent): void {
  if (!isSectionEnabled()) {
    if (hoverArrow) setArrowHover(false);
    return;
  }
  if (dragging && dragPlane) {
    if (pointerId != null && e.pointerId !== pointerId) return;
    movePlaneAlongNormal(dragPlane, e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const handle = pickClipperHandle(e.clientX, e.clientY);
  setArrowHover(!!handle);
}

function onPointerDown(e: PointerEvent): void {
  if (!isSectionEnabled()) return;
  if (e.button !== 0) return;
  const handle = pickClipperHandle(e.clientX, e.clientY);
  if (!handle) return;
  setArrowHover(true);
  dragging = true;
  (window as Any).__OBS_SECTION_ARROW_LOCK = true;
  (window as Any).__OBS_BLOCK_SELECT = true;
  (window as Any).__OBS_BLOCK_BOX_SELECT = true;
  dragPlane = handle.item;
  dragPoint.copy(handle.point);
  pointerId = e.pointerId;
  try {
    hostEl()?.setPointerCapture?.(e.pointerId);
  } catch {
    /* */
  }
  const host = hostEl();
  if (host) host.style.cursor = "grabbing";
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging) return;
  if (pointerId != null && e.pointerId !== pointerId) return;
  releaseEverything(e);
  setArrowHover(!!pickClipperHandle(e.clientX, e.clientY));
}

export function setupSectionCutInteraction(): void {
  if (installed) return;
  installed = true;

  const host = hostEl();
  if (!host) {
    window.setTimeout(() => {
      installed = false;
      setupSectionCutInteraction();
    }, 800);
    return;
  }

  host.addEventListener(
    "dblclick",
    (e) => {
      void onDblClick(e);
    },
    true,
  );
  host.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (dragging) releaseEverything(null);
      setArrowHover(false);
    }
  });

  try {
    void import("../core/input-router").then((mod: Any) => {
      // Priority 200 - above gizmo(100), box-select(50), selection/authoring
      mod.inputRouter?.subscribe?.((g: Any) => {
        if (!hoverArrow && !dragging) return false;
        // Claim EVERY gesture so select / window-select / pan / orbit cannot run
        return true;
      }, 200);
    });
  } catch {
    /* */
  }

  installGlobalMouseLock();

  // Also block selection feature if it exposes a gate
  try {
    const sel = (ctx.features as Any)?.selection;
    if (sel && typeof sel.setSuspended !== "function") {
      (window as Any).__obsSelectionSuspended = () => isArrowMode();
    }
  } catch {
    /* */
  }

  (window as Any).__obsSectionCut = {
    release: () => releaseEverything(null),
    createAt: createPlaneAt,
    pickFace: pickModelFace,
  };

  console.log(
    "[section-cut-interaction] OBC face pick + parallel cut; hover arrow = move only",
  );
}
