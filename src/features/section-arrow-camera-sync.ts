/**
 * Keep section-cut arrows visible and usable when the camera moves.
 *
 * Problem: clipper helpers are created at the face-pick point. After orbit /
 * zoom / view-cube jumps the arrow stays at that world point — often off-screen
 * or tiny — while the cut plane itself is still active.
 *
 * Fix: each camera update, project the view center onto every section plane and
 * move the helper/arrow there. Scale the handle with camera distance so it stays
 * a consistent screen size. The plane equation (cut) is unchanged — only the
 * grab handle slides in-plane.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { readControlsTarget } from "../core/controls-target";

type Any = Record<string, any>;

let installed = false;
let rafId: number | null = null;
let lastSync = 0;

const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _plane = new THREE.Plane();

function camera(): THREE.Camera | null {
  try {
    return (ctx as Any).world?.camera?.three as THREE.Camera;
  } catch {
    return null;
  }
}

function controls(): Any | null {
  try {
    return (ctx as Any).world?.camera?.controls ?? null;
  } catch {
    return null;
  }
}

function listClipperItems(): Any[] {
  try {
    const list = (ctx as Any).clipper?.list;
    if (!list) return [];
    const entries: Any[] = list[Symbol.iterator] ? [...list] : Object.values(list);
    return entries.map((e) => (Array.isArray(e) ? e[1] : e)).filter(Boolean);
  } catch {
    return [];
  }
}

function planeOf(item: Any): THREE.Plane | null {
  try {
    const p = item?.three?.plane ?? item?.plane ?? (item?.three?.isPlane ? item.three : null);
    if (p?.normal && typeof p.constant === "number") {
      _plane.normal.copy(p.normal).normalize();
      _plane.constant = p.constant;
      return _plane;
    }
    if (item?.normal && item?.origin) {
      _n.copy(item.normal).normalize();
      _plane.setFromNormalAndCoplanarPoint(_n, item.origin);
      return _plane;
    }
  } catch {
    /* */
  }
  return null;
}

/** World point the camera is "looking at" (controls target, else along view ray). */
function viewFocus(cam: THREE.Camera): THREE.Vector3 {
  const c = controls();
  if (c && readControlsTarget(c, _lookAt)) return _lookAt;
  cam.getWorldDirection(_viewDir);
  return _lookAt.copy(cam.position).addScaledVector(_viewDir, 12);
}

/**
 * Place the handle where the view meets the plane.
 * Prefer: ray from camera through focus ∩ plane.
 * Fallback: project focus onto plane (always defined).
 */
function handlePointOnPlane(cam: THREE.Camera, plane: THREE.Plane): THREE.Vector3 {
  const focus = viewFocus(cam);
  _viewDir.copy(focus).sub(cam.position);
  if (_viewDir.lengthSq() < 1e-10) cam.getWorldDirection(_viewDir);
  else _viewDir.normalize();

  const ray = new THREE.Ray(cam.position, _viewDir);
  if (ray.intersectPlane(plane, _hit)) {
    // If the hit is behind the camera or extremely far, fall back to projection.
    const toHit = _tmp.copy(_hit).sub(cam.position);
    if (toHit.dot(_viewDir) > 0.05 && toHit.length() < 5_000) return _hit;
  }

  // Project the focus point onto the plane (in-plane slide, cut unchanged).
  plane.projectPoint(focus, _proj);
  return _proj;
}

function scaleForDistance(cam: THREE.Camera, point: THREE.Vector3): number {
  const d = cam.position.distanceTo(point);
  // ~constant on-screen size; clamp so it never vanishes or explodes.
  return THREE.MathUtils.clamp(d * 0.04, 0.35, 25);
}

function setHelperPosition(item: Any, pos: THREE.Vector3, scale: number): void {
  const candidates: Any[] = [];
  for (const key of ["helper", "arrow", "controls", "transform", "gizmo", "three", "root", "group"]) {
    const o = item[key];
    if (!o) continue;
    if (o.isObject3D) candidates.push(o);
    if (o.object?.isObject3D) candidates.push(o.object);
    if (o._gizmo?.isObject3D) candidates.push(o._gizmo);
    // TransformControls: object is the controlled target
    if (typeof o.attach === "function" && o.object?.isObject3D) candidates.push(o.object);
  }

  // Prefer the dedicated helper mesh if present
  const helper = candidates.find((o) => /helper|arrow|gizmo/i.test(o.name || "")) ?? candidates[0];
  if (!helper) return;

  try {
    // Only slide in-plane; do not change plane normal/constant.
    if (helper.position) {
      helper.position.copy(pos);
      helper.updateMatrixWorld?.(true);
    }
  } catch {
    /* */
  }

  try {
    if (helper.scale?.setScalar) helper.scale.setScalar(scale);
  } catch {
    /* */
  }

  // Some clippers store a separate arrow mesh under helper
  try {
    helper.traverse?.((ch: Any) => {
      if (ch === helper) return;
      if (ch.isMesh || ch.isLine || ch.isLineSegments) {
        // keep local offsets; scale is inherited from parent
      }
    });
  } catch {
    /* */
  }

  try {
    item.update?.();
  } catch {
    /* */
  }
}

/** Public: run one sync pass (also used after plane create / drag). */
export function syncSectionArrowsToCamera(): void {
  const cam = camera();
  if (!cam) return;
  // Skip while the user is actively dragging a cut arrow (our interaction sets lock).
  try {
    if ((window as Any).__OBS_SECTION_ARROW_LOCK && !(window as Any).__OBS_SECTION_ARROW_HOVER_ONLY) {
      // still allow hover-only; block only during active drag
      if ((window as Any).__OBS_SECTION_ARROW_DRAGGING) return;
    }
  } catch {
    /* */
  }

  const list = listClipperItems();
  if (!list.length) return;

  for (const item of list) {
    const plane = planeOf(item);
    if (!plane) continue;
    const pos = handlePointOnPlane(cam, plane);
    const s = scaleForDistance(cam, pos);
    setHelperPosition(item, pos, s);
  }
}

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  // Throttle to ~30 Hz — enough for smooth follow, cheap while idle.
  if (now - lastSync < 33) return;
  lastSync = now;
  try {
    // Only when section / clipper is active
    const clipper = (ctx as Any).clipper;
    if (!clipper) return;
    if (clipper.enabled === false) return;
    if (!listClipperItems().length) return;
    syncSectionArrowsToCamera();
  } catch {
    /* */
  }
}

export function setupSectionArrowCameraSync(): void {
  if (installed) return;
  installed = true;

  // Flag set by section-cut-interaction while dragging (optional)
  try {
    (window as Any).__OBS_SECTION_ARROW_DRAGGING = false;
  } catch {
    /* */
  }

  rafId = requestAnimationFrame(tick);

  // Also hook controls "update" for immediate response on orbit/zoom
  try {
    const c = controls();
    c?.addEventListener?.("update", () => {
      try {
        syncSectionArrowsToCamera();
      } catch {
        /* */
      }
    });
  } catch {
    /* */
  }

  // After view-cube / home jumps
  try {
    window.addEventListener("obs-viewcube-visibility", () => {
      window.setTimeout(() => syncSectionArrowsToCamera(), 50);
    });
  } catch {
    /* */
  }

  console.log("[section-arrow-sync] cut arrow follows camera on the plane");
}

export function stopSectionArrowCameraSync(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  installed = false;
}
