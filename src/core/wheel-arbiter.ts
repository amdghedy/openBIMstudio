import * as THREE from "three";
import { ctx } from "./context";
import { syncOrthoZoom } from "./ortho-zoom";

type Any = Record<string, any>;

/**
 * Authoritative mouse-wheel zoom for the 3D viewport.
 *
 * HARD INVARIANT: wheel must never change camera orientation.
 *   - Do NOT call setLookAt / lookAt / rotate / orbit during wheel.
 *   - Only translate camera.position and controls.target together.
 *   - Snapshot quaternion + up before the step; re-assert after any
 *     controls.update() because camera-controls.update() calls lookAt
 *     internally and will otherwise rewrite orientation.
 *
 * Cursor anchoring:
 *   Perspective — dolly along view axis, then truck in the image plane
 *     so the world point under the cursor stays fixed on screen.
 *   Orthographic — scale cam.zoom, then truck the same way.
 *
 * Competing handlers (nav-cog-force, navigation.ts) must yield when
 * __OBS_WHEEL_AUTHORITY is true.
 */

let installed = false;
let enabled = true;
let invert = false;
let multiplier = 1;

const UI_BLOCK =
  ".obs-panel,[data-obs-panel],#obs-ai-chat,#obs-bim-toolbox,.obs-ribbon," +
  ".obs-property,.obs-dialog,.obs-adv-toolbar,.obs-plan-view,#plan-svg," +
  "input,textarea,select,button,label,a,[contenteditable=true],#obs-cad-viewer,[data-obs-own-wheel]";

const _ndc = new THREE.Vector2();
const _target = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _after = new THREE.Vector3();
const _truck = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _plane = new THREE.Plane();
const _raycaster = new THREE.Raycaster();
const _hit = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _pos0 = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function w(): Any {
  return window as Any;
}

function readMultiplier(): number {
  try {
    const reg: Any = w().__obsOptionsRegistry ?? null;
    const v = reg?.get?.("nav.wheelZoomMultiplier");
    if (typeof v === "number" && v > 0) return v;
  } catch {
    /* */
  }
  return multiplier;
}

function normalizeDelta(e: WheelEvent): number {
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;
  else if (e.deltaMode === 2) d *= 100;
  if (d > 600) d = 600;
  if (d < -600) d = -600;
  return d;
}

function isOverViewport(target: EventTarget | null): boolean {
  const el = target as Any;
  if (!el) return false;
  if (typeof el.closest === "function" && el.closest(UI_BLOCK)) return false;
  const host: Any = (ctx as Any).rightHost;
  if (host && host.contains && !host.contains(el)) {
    const tag = String(el.tagName ?? "").toUpperCase();
    if (tag !== "CANVAS") return false;
  }
  return true;
}

function getViewportRect(): DOMRect | null {
  try {
    const host = (ctx as Any).rightHost as HTMLElement | undefined;
    if (host) return host.getBoundingClientRect();
    const canvas = document.querySelector("canvas");
    if (canvas) return canvas.getBoundingClientRect();
  } catch {
    /* */
  }
  return null;
}

function clientToNdc(clientX: number, clientY: number, out: THREE.Vector2): boolean {
  const rect = getViewportRect();
  if (!rect || rect.width < 1 || rect.height < 1) return false;
  out.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return true;
}

function getControls(): Any {
  return (ctx as Any).world?.camera?.controls ?? null;
}

function resolveDrivenCamera(): THREE.Camera | null {
  const controls = getControls();
  try {
    const cc = controls?.camera;
    if (cc?.isCamera) return cc as THREE.Camera;
  } catch {
    /* */
  }
  const three = (ctx as Any).world?.camera?.three;
  return three?.isCamera ? (three as THREE.Camera) : null;
}

function isOrthoCam(cam: THREE.Camera | null | undefined): boolean {
  return !!(cam as any)?.isOrthographicCamera;
}

function collectOrthoCameras(): THREE.OrthographicCamera[] {
  const out: THREE.OrthographicCamera[] = [];
  const push = (x: any) => {
    if (!x) return;
    const c = x.isCamera ? x : x.three;
    if (c?.isOrthographicCamera) out.push(c as THREE.OrthographicCamera);
  };
  const wrapper = (ctx as Any).world?.camera;
  if (!wrapper) return out;
  push(wrapper.three);
  push(wrapper.orthographicCamera);
  push(wrapper.orthoCamera);
  push(getControls()?.camera);
  return Array.from(new Set(out));
}

function getOrbitTarget(controls: Any, cam: THREE.Camera, out: THREE.Vector3): void {
  let got = false;
  try {
    if (typeof controls?.getTarget === "function") {
      controls.getTarget(out);
      got = Number.isFinite(out.x);
    }
  } catch {
    /* */
  }
  if (!got) {
    try {
      if (controls?.target?.isVector3) {
        out.copy(controls.target);
        got = true;
      }
    } catch {
      /* */
    }
  }
  if (!got) {
    cam.getWorldDirection(_dir);
    out.copy(cam.position).addScaledVector(_dir, 10);
  }
}

/** World point under cursor: mesh hit preferred, else plane at orbit-target depth. */
function focusUnderCursor(
  cam: THREE.Camera,
  controls: Any,
  clientX: number,
  clientY: number,
  out: THREE.Vector3,
): boolean {
  if (!clientToNdc(clientX, clientY, _ndc)) return false;
  getOrbitTarget(controls, cam, _target);
  _raycaster.setFromCamera(_ndc, cam);
  try {
    const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
    if (scene) {
      const hits = _raycaster.intersectObjects(scene.children, true);
      const camPos = cam.position;
      const targetDist = Math.max(camPos.distanceTo(_target), 0.5);
      for (const h of hits) {
        if (!h.point || !Number.isFinite(h.point.x)) continue;
        if (String((h.object as any)?.name ?? "") === "groundPlane") continue;
        const d = camPos.distanceTo(h.point);
        if (d < 0.01) continue;
        if (d < targetDist * 4 + 80) {
          out.copy(h.point);
          return true;
        }
      }
    }
  } catch {
    /* */
  }
  cam.getWorldDirection(_dir);
  _plane.setFromNormalAndCoplanarPoint(_dir, _target);
  if (_raycaster.ray.intersectPlane(_plane, _hit)) {
    out.copy(_hit);
    return true;
  }
  out.copy(_target);
  return true;
}

/**
 * Write position + target by PURE TRANSLATION only.
 * Never calls setLookAt / lookAt — those re-derive orientation from world-up
 * and are the root cause of wheel-induced rotation.
 */
function applyPureTranslation(
  controls: Any,
  cam: THREE.Camera,
  newPos: THREE.Vector3,
  newTarget: THREE.Vector3,
  preservedQuat: THREE.Quaternion,
  preservedUp: THREE.Vector3,
): void {
  cam.position.copy(newPos);
  try {
    if (controls?.target?.isVector3) controls.target.copy(newTarget);
  } catch {
    /* */
  }

  // Keep camera-controls internal END state in sync so the animation
  // loop does not lerp back toward a stale spherical (apparent rotation).
  try {
    const offset = new THREE.Vector3().subVectors(newPos, newTarget);
    const sph = new THREE.Spherical().setFromVector3(offset);
    for (const key of ["_spherical", "spherical", "_sphericalEnd", "sphericalEnd"] as const) {
      const s = controls?.[key];
      if (s && typeof s.theta === "number") {
        s.theta = sph.theta;
        s.phi = sph.phi;
        s.radius = sph.radius;
      }
    }
    for (const key of ["_targetEnd", "targetEnd", "_target", "target"] as const) {
      const t = controls?.[key];
      if (t?.isVector3) t.copy(newTarget);
    }
    for (const key of ["_positionEnd", "positionEnd"] as const) {
      const p = controls?.[key];
      if (p?.isVector3) p.copy(newPos);
    }
  } catch {
    /* */
  }

  try {
    if (typeof controls?.setTarget === "function") {
      const r = controls.setTarget(newTarget.x, newTarget.y, newTarget.z, false);
      if (r && typeof r.catch === "function") r.catch(() => { /* */ });
    }
  } catch {
    /* */
  }
  try {
    if (typeof controls?.setPosition === "function") {
      const r = controls.setPosition(newPos.x, newPos.y, newPos.z, false);
      if (r && typeof r.catch === "function") r.catch(() => { /* */ });
    }
  } catch {
    /* */
  }

  cam.quaternion.copy(preservedQuat);
  cam.up.copy(preservedUp);
  cam.updateMatrixWorld?.(true);

  try {
    controls?.update?.(0);
  } catch {
    /* */
  }

  cam.position.copy(newPos);
  cam.quaternion.copy(preservedQuat);
  cam.up.copy(preservedUp);
  try {
    if (controls?.target?.isVector3) controls.target.copy(newTarget);
  } catch {
    /* */
  }
  cam.updateMatrixWorld?.(true);
}

function applyOrthoZoom(
  factor: number,
  controls: Any,
  clientX: number,
  clientY: number,
): void {
  const driven = resolveDrivenCamera();
  const orthos = collectOrthoCameras();
  if (!orthos.length && driven && isOrthoCam(driven)) {
    orthos.push(driven as THREE.OrthographicCamera);
  }
  if (!orthos.length) {
    if (driven) applyPerspectiveZoom(driven, controls, factor, clientX, clientY);
    return;
  }

  const primary =
    (driven && isOrthoCam(driven) ? (driven as THREE.OrthographicCamera) : null) ??
    orthos[0];

  _quat.copy(primary.quaternion);
  _up.copy(primary.up);
  _pos0.copy(primary.position);
  getOrbitTarget(controls, primary, _target);
  const target0 = _target.clone();
  const hasFocus = focusUnderCursor(primary, controls, clientX, clientY, _focus);
  const focusBefore = _focus.clone();

  for (const ortho of orthos) {
    const oldZoom = Math.max(1e-4, ortho.zoom || 1);
    const newZoom = Math.max(0.05, Math.min(8000, oldZoom * factor));
    ortho.zoom = newZoom;
    syncOrthoZoom(ortho);
    const span = Math.max(
      Math.abs(ortho.right - ortho.left),
      Math.abs(ortho.top - ortho.bottom),
      10,
    );
    const worldSpan = span / Math.max(ortho.zoom || 1, 0.05);
    const far = Math.max(5000, worldSpan * 80);
    ortho.near = -far;
    ortho.far = far;
    ortho.updateProjectionMatrix();
  }

  primary.quaternion.copy(_quat);
  primary.up.copy(_up);

  if (hasFocus && clientToNdc(clientX, clientY, _ndc)) {
    _raycaster.setFromCamera(_ndc, primary);
    primary.getWorldDirection(_dir);
    _plane.setFromNormalAndCoplanarPoint(_dir, focusBefore);
    if (_raycaster.ray.intersectPlane(_plane, _after)) {
      _truck.subVectors(focusBefore, _after);
      if (_truck.lengthSq() > 1e-12) {
        const newPos = _pos0.clone().add(_truck);
        const newTarget = target0.clone().add(_truck);
        applyPureTranslation(controls, primary, newPos, newTarget, _quat, _up);
        return;
      }
    }
  }

  primary.quaternion.copy(_quat);
  primary.up.copy(_up);
  primary.updateMatrixWorld?.(true);
}

function applyPerspectiveZoom(
  cam: THREE.Camera,
  controls: Any,
  factor: number,
  clientX: number,
  clientY: number,
): void {
  _quat.copy(cam.quaternion);
  _up.copy(cam.up);
  _pos0.copy(cam.position);
  getOrbitTarget(controls, cam, _target);
  const target0 = _target.clone();
  cam.getWorldDirection(_dir);
  const fwd = _dir.clone();

  const dist = Math.max(target0.clone().sub(_pos0).dot(fwd), 0.5);
  const newDist = Math.max(0.05, dist / factor);
  const along = dist - newDist;

  const newPos = _pos0.clone().addScaledVector(fwd, along);
  const newTarget = target0.clone().addScaledVector(fwd, along);

  const hasFocus = focusUnderCursor(cam, controls, clientX, clientY, _focus);
  if (hasFocus && Number.isFinite(_focus.x) && clientToNdc(clientX, clientY, _ndc)) {
    const savedPos = cam.position.clone();
    cam.position.copy(newPos);
    cam.quaternion.copy(_quat);
    cam.updateMatrixWorld?.(true);
    _raycaster.setFromCamera(_ndc, cam);
    cam.position.copy(savedPos);
    cam.quaternion.copy(_quat);
    cam.updateMatrixWorld?.(true);

    _plane.setFromNormalAndCoplanarPoint(fwd, _focus);
    if (_raycaster.ray.intersectPlane(_plane, _after)) {
      _truck.subVectors(_focus, _after);
      if (_truck.lengthSq() > 1e-12) {
        newPos.add(_truck);
        newTarget.add(_truck);
      }
    }
  }

  applyPureTranslation(controls, cam, newPos, newTarget, _quat, _up);
}

function applyZoom(ndelta: number, shift: boolean, clientX: number, clientY: number): void {
  const controls = getControls();
  const cam = resolveDrivenCamera();
  if (!cam) return;

  try {
    if (controls && controls.enabled === false) controls.enabled = true;
  } catch {
    /* */
  }

  lockControlsWheel();

  const speed = 0.0022 * readMultiplier() * (shift ? 3 : 1);
  const signed = invert ? -ndelta : ndelta;
  const factor = Math.exp(-signed * speed);
  if (!Number.isFinite(factor) || factor <= 0) return;
  if (Math.abs(factor - 1) < 1e-4) return;

  // ONLY trust the driven camera. ThatOpen keeps both perspective and
  // orthographic camera objects alive; collecting either must NOT force
  // the ortho zoom path while the user is in perspective.
  let modeOrtho = isOrthoCam(cam);
  if (!modeOrtho) {
    try {
      const wrap = (ctx as Any).world?.camera;
      const t = wrap?.cameraType ?? wrap?.projection?.current ?? wrap?.projection;
      if (typeof t === "string" && /ortho|plan/i.test(String(t)) && !/persp/i.test(String(t))) {
        modeOrtho = true;
      }
    } catch {
      /* */
    }
  }

  const qBefore = cam.quaternion.clone();
  const dirBefore = cam.getWorldDirection(new THREE.Vector3()).clone();

  if (modeOrtho) {
    applyOrthoZoom(factor, controls, clientX, clientY);
  } else {
    applyPerspectiveZoom(cam, controls, factor, clientX, clientY);
  }

  try {
    const qAfter = cam.quaternion;
    const dot = Math.abs(
      qBefore.x * qAfter.x +
        qBefore.y * qAfter.y +
        qBefore.z * qAfter.z +
        qBefore.w * qAfter.w,
    );
    if (dot < 0.9995) {
      cam.quaternion.copy(qBefore);
      cam.updateMatrixWorld?.(true);
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[wheel-arbiter] orientation drift corrected (dot=" + dot.toFixed(6) + ")");
      }
    }
    const dirAfter = cam.getWorldDirection(_tmp);
    if (dirBefore.dot(dirAfter) < 0.9995) {
      cam.quaternion.copy(qBefore);
      cam.updateMatrixWorld?.(true);
    }
  } catch {
    /* */
  }

  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* */
  }
}

function onWheel(e: WheelEvent): void {
  if (!enabled) return;
  if ((w() as Any).__OBS_MMB_HELD) return;
  if (!isOverViewport(e.target)) return;
  const nd = normalizeDelta(e);
  if (nd === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  applyZoom(nd, !!e.shiftKey, e.clientX, e.clientY);
}

export function lockControlsWheel(): void {
  try {
    const controls = getControls();
    const ACTION = (controls?.constructor as any)?.ACTION || (w() as Any).CameraControls?.ACTION;
    const NONE = ACTION?.NONE ?? 0;
    const mb = controls?.mouseButtons;
    if (!mb) return;
    try {
      mb.wheel = NONE;
    } catch {
      /* */
    }
    try {
      Object.defineProperty(mb, "wheel", {
        get: () => NONE,
        set: () => {
          /* wheel-arbiter owns wheel */
        },
        configurable: true,
      });
    } catch {
      /* */
    }
    try {
      if ("dollySpeed" in controls) controls.dollySpeed = 0;
    } catch {
      /* */
    }
    try {
      if ("dollyToCursor" in controls) controls.dollyToCursor = false;
    } catch {
      /* */
    }
  } catch {
    /* */
  }
}

export function setWheelInvert(next: boolean): boolean {
  invert = !!next;
  return invert;
}
export function setWheelMultiplier(next: number): number {
  multiplier = Number.isFinite(next) && next > 0 ? next : 1;
  return multiplier;
}
export function setWheelEnabled(next: boolean): boolean {
  enabled = !!next;
  return enabled;
}
export function isWheelEnabled(): boolean {
  return enabled;
}

export function setupWheelArbiter(): void {
  if (installed) return;
  installed = true;
  (w() as Any).__OBS_WHEEL_AUTHORITY = true;
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  lockControlsWheel();
  window.addEventListener("obs:camera-changed", () => {
    try {
      lockControlsWheel();
    } catch {
      /* */
    }
  });
  (w() as Any).__obsWheelFix = {
    setInvert: setWheelInvert,
    setMultiplier: setWheelMultiplier,
    setEnabled: setWheelEnabled,
    isEnabled: isWheelEnabled,
    lockControlsWheel,
    getState: () => ({ enabled, invert, multiplier: readMultiplier() }),
  };
  console.log("[wheel-arbiter] pure-translation zoom; perspective path fixed; sphericalEnd synced");
}
