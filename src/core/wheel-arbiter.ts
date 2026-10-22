import * as THREE from "three";
import { ctx } from "./context";
import { syncOrthoZoom } from "./ortho-zoom";

type Any = Record<string, any>;

/**
 * Wheel zoom for 3D viewport.
 * Ortho: zoom on controls.camera (ThatOpen-safe) + wide near/far.
 * Perspective: dolly toward cursor.
 * Locks mouseButtons.wheel so Ortho toggle cannot re-enable native dolly.
 */

let installed = false;
let enabled = true;
let invert = false;
let multiplier = 1;

const UI_BLOCK =
  ".obs-panel,[data-obs-panel],#obs-ai-chat,#obs-bim-toolbox,.obs-ribbon," +
  ".obs-property,.obs-dialog,.obs-adv-toolbar,.obs-plan-view,#plan-svg," +
  "input,textarea,select,button,label,a,[contenteditable=true]";

const _ndc = new THREE.Vector2();
const _target = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _after = new THREE.Vector3();
const _truck = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _plane = new THREE.Plane();
const _raycaster = new THREE.Raycaster();
const _hit = new THREE.Vector3();

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

/** Camera CameraControls is driving — required for visible Ortho zoom. */
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

function isOrthoCam(cam: THREE.Camera | null | undefined): boolean {
  return !!(cam as any)?.isOrthographicCamera;
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

function applyLookAt(
  controls: Any,
  cam: THREE.Camera,
  pos: THREE.Vector3,
  target: THREE.Vector3,
): void {
  try {
    if (controls && typeof controls.setLookAt === "function") {
      controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);
      controls.update?.(0);
      return;
    }
  } catch {
    /* */
  }
  cam.position.copy(pos);
  try {
    cam.lookAt(target);
  } catch {
    /* */
  }
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

  const hasFocus = focusUnderCursor(primary, controls, clientX, clientY, _focus);
  getOrbitTarget(controls, primary, _target);
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

  try {
    if (controls && typeof controls.update === "function") controls.update(0);
  } catch {
    /* */
  }

  if (hasFocus && clientToNdc(clientX, clientY, _ndc) && isOrthoCam(primary)) {
    _raycaster.setFromCamera(_ndc, primary);
    primary.getWorldDirection(_dir);
    _plane.setFromNormalAndCoplanarPoint(_dir, focusBefore);
    if (_raycaster.ray.intersectPlane(_plane, _after)) {
      _truck.subVectors(focusBefore, _after);
      if (_truck.lengthSq() > 1e-12) {
        applyLookAt(
          controls,
          primary,
          primary.position.clone().add(_truck),
          _target.clone().add(_truck),
        );
      }
    }
  }
}

function applyPerspectiveZoom(
  cam: THREE.Camera,
  controls: Any,
  factor: number,
  clientX: number,
  clientY: number,
): void {
  const hasFocus = focusUnderCursor(cam, controls, clientX, clientY, _focus);
  getOrbitTarget(controls, cam, _target);
  const offset = new THREE.Vector3().subVectors(cam.position, _target);
  const dist = offset.length();
  if (dist < 1e-6) return;
  const viewDir = offset.clone().multiplyScalar(1 / dist);
  const newDist = Math.max(0.05, dist / factor);
  let newPos = _target.clone().add(viewDir.clone().multiplyScalar(newDist));
  let newTarget = _target.clone();

  if (hasFocus && Number.isFinite(_focus.x)) {
    const toFocus = _focus.clone().sub(_target);
    const along = toFocus.dot(viewDir);
    const focusOnPlane = _focus.clone().sub(viewDir.clone().multiplyScalar(along));
    const lateral = focusOnPlane.clone().sub(_target);
    const truck = lateral.multiplyScalar(1 - newDist / dist);
    newPos.add(truck);
    newTarget.add(truck);
  }
  applyLookAt(controls, cam, newPos, newTarget);
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

  const speed = 0.0022 * readMultiplier() * (shift ? 3 : 1);
  const signed = invert ? -ndelta : ndelta;
  const factor = Math.exp(-signed * speed);
  if (!Number.isFinite(factor) || factor <= 0) return;

  let modeOrtho = isOrthoCam(cam);
  if (!modeOrtho) {
    try {
      const wrap = (ctx as Any).world?.camera;
      const t = wrap?.cameraType ?? wrap?.projection?.current ?? wrap?.projection;
      if (typeof t === "string" && /ortho|plan/i.test(String(t))) modeOrtho = true;
    } catch {
      /* */
    }
  }
  if (!modeOrtho && collectOrthoCameras().length > 0) modeOrtho = true;

  if (modeOrtho) {
    applyOrthoZoom(factor, controls, clientX, clientY);
  } else {
    applyPerspectiveZoom(cam, controls, factor, clientX, clientY);
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

/** Re-lock wheel after Ortho/Persp toggle (ThatOpen reassigns mouseButtons). */
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
  console.log("[wheel-arbiter] Ortho zoom on controls.camera + wheel lock");
}
