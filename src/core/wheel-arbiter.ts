import * as THREE from "three";
import { ctx } from "./context";
import { syncOrthoZoom } from "./ortho-zoom";
import { axisDistance, targetAhead, type V3 } from "./view-lock";

type Any = Record<string, any>;

/**
 * Wheel zoom for 3D viewport — cursor-centered, orientation-preserving.
 *
 * Contract (BIM / Revit / Navisworks style):
 *   - Scroll zooms toward the world point under the mouse pointer.
 *   - View orientation is NEVER changed by wheel (only orbit may rotate).
 *   - Up vector stays stable.
 *   - Works in both Perspective and Orthographic.
 *
 * Implementation strategy (root-cause fix, not a mask):
 *   camera-controls stores a spherical (theta, phi, radius) and re-applies it
 *   on every update(). Calling setLookAt() can rewrite theta/phi and produce
 *   a visible rotation on the next frame.
 *
 *   We therefore:
 *     1. Snapshot theta / phi / quaternion / up before the step.
 *     2. Dolly ONLY along the current view axis (never change direction).
 *     3. Truck laterally so the cursor's world point stays fixed on screen.
 *     4. Write position + target, then force spherical theta/phi back and
 *        re-assert quaternion/up so the animation loop cannot reintroduce
 *        rotation.
 *
 * Native mouseButtons.wheel is locked to NONE so OrthoPerspectiveCamera
 * cannot re-enable camera-controls' own dolly on projection switches.
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
const _offset = new THREE.Vector3();
const _plane = new THREE.Plane();
const _raycaster = new THREE.Raycaster();
const _hit = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _spherical = new THREE.Spherical();
const _newPos = new THREE.Vector3();
const _newTarget = new THREE.Vector3();

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

/**
 * World point under the cursor.
 * Prefer a nearby mesh hit; otherwise intersect the plane through the
 * current orbit target facing the camera (stable over empty space).
 */
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
 * Commit a pure-translation camera move (dolly along view + optional truck)
 * while freezing orientation for the animation loop.
 *
 * camera-controls keeps spherical (theta, phi, radius). We force theta/phi
 * to the pre-zoom values after writing position/target so the next
 * controls.update(delta) cannot rotate the view.
 */
function commitTranslation(
  controls: Any,
  cam: THREE.Camera,
  newPos: THREE.Vector3,
  newTarget: THREE.Vector3,
  preservedQuat: THREE.Quaternion,
  preservedUp: THREE.Vector3,
  preservedTheta: number,
  preservedPhi: number,
): void {
  // 1) Write through setLookAt when available (keeps controls internal state alive).
  try {
    if (controls && typeof controls.setLookAt === "function") {
      controls.setLookAt(
        newPos.x, newPos.y, newPos.z,
        newTarget.x, newTarget.y, newTarget.z,
        false,
      );
    } else {
      cam.position.copy(newPos);
    }
  } catch {
    cam.position.copy(newPos);
  }

  // 2) Force position + target (authoritative).
  try {
    cam.position.copy(newPos);
    if (controls?.target?.isVector3) controls.target.copy(newTarget);
  } catch {
    /* */
  }

  // 3) Restore spherical theta/phi so the next update() cannot rotate.
  try {
    _offset.subVectors(newPos, newTarget);
    _spherical.setFromVector3(_offset);
    _spherical.theta = preservedTheta;
    _spherical.phi = preservedPhi;
    // If controls exposes spherical, write it directly.
    if (controls?._spherical) {
      controls._spherical.theta = preservedTheta;
      controls._spherical.phi = preservedPhi;
      controls._spherical.radius = _spherical.radius;
    }
    if (controls?.spherical) {
      controls.spherical.theta = preservedTheta;
      controls.spherical.phi = preservedPhi;
      controls.spherical.radius = _spherical.radius;
    }
    // Rebuild position from frozen angles (guarantees direction match).
    _offset.setFromSpherical(_spherical);
    cam.position.copy(newTarget).add(_offset);
    if (controls?.target?.isVector3) controls.target.copy(newTarget);
  } catch {
    /* */
  }

  // 4) Hard-lock orientation.
  try {
    cam.quaternion.copy(preservedQuat);
    cam.up.copy(preservedUp);
    cam.updateMatrixWorld?.(true);
  } catch {
    /* */
  }

  // 5) Tick controls once, then re-assert orientation (update may touch quat).
  try {
    controls?.update?.(0);
  } catch {
    /* */
  }
  try {
    cam.quaternion.copy(preservedQuat);
    cam.up.copy(preservedUp);
    cam.updateMatrixWorld?.(true);
  } catch {
    /* */
  }
}

function snapshotOrientation(cam: THREE.Camera, target: THREE.Vector3): {
  quat: THREE.Quaternion;
  up: THREE.Vector3;
  theta: number;
  phi: number;
  fwd: THREE.Vector3;
  dist: number;
} {
  _quat.copy(cam.quaternion);
  _up.copy(cam.up);
  cam.getWorldDirection(_dir);
  _offset.subVectors(cam.position, target);
  _spherical.setFromVector3(_offset);
  const dist = axisDistance(
    [cam.position.x, cam.position.y, cam.position.z],
    [target.x, target.y, target.z],
    [_dir.x, _dir.y, _dir.z],
    0.5,
  );
  return {
    quat: _quat.clone(),
    up: _up.clone(),
    theta: _spherical.theta,
    phi: _spherical.phi,
    fwd: _dir.clone(),
    dist,
  };
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

  getOrbitTarget(controls, primary, _target);
  const snap = snapshotOrientation(primary, _target);
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

  try {
    controls?.update?.(0);
  } catch {
    /* */
  }

  // Lateral truck: keep the world point under the cursor fixed on screen.
  if (hasFocus && clientToNdc(clientX, clientY, _ndc) && isOrthoCam(primary)) {
    _raycaster.setFromCamera(_ndc, primary);
    primary.getWorldDirection(_dir);
    _plane.setFromNormalAndCoplanarPoint(_dir, focusBefore);
    if (_raycaster.ray.intersectPlane(_plane, _after)) {
      _truck.subVectors(focusBefore, _after);
      if (_truck.lengthSq() > 1e-12) {
        _newPos.copy(primary.position).add(_truck);
        const nt = targetAhead(
          [_newPos.x, _newPos.y, _newPos.z],
          [snap.fwd.x, snap.fwd.y, snap.fwd.z],
          snap.dist,
        );
        _newTarget.set(nt[0], nt[1], nt[2]);
        commitTranslation(
          controls, primary, _newPos, _newTarget,
          snap.quat, snap.up, snap.theta, snap.phi,
        );
        return;
      }
    }
  }

  // No truck — still re-assert orientation after zoom/sync.
  try {
    primary.quaternion.copy(snap.quat);
    primary.up.copy(snap.up);
    primary.updateMatrixWorld?.(true);
  } catch {
    /* */
  }
}

/**
 * Perspective: dolly along the CURRENT view axis only, then truck laterally
 * so the cursor focus stays under the pointer. Orientation never changes.
 */
function applyPerspectiveZoom(
  cam: THREE.Camera,
  controls: Any,
  factor: number,
  clientX: number,
  clientY: number,
): void {
  getOrbitTarget(controls, cam, _target);
  const snap = snapshotOrientation(cam, _target);
  const hasFocus = focusUnderCursor(cam, controls, clientX, clientY, _focus);

  // Dolly along view axis: move eye toward/away from target plane.
  // factor > 1 → zoom in (closer), factor < 1 → zoom out.
  // Our caller passes exp(-delta * speed), so deltaY>0 (scroll down) → factor<1 → zoom out.
  const newDist = Math.max(0.05, snap.dist / factor);
  const dollyDelta = snap.dist - newDist; // positive when zooming in

  // Move eye along forward.
  _newPos.copy(cam.position).addScaledVector(snap.fwd, dollyDelta);
  // Target stays straight ahead at the new distance (pure translation pair).
  _newTarget.copy(_newPos).addScaledVector(snap.fwd, newDist);

  // Lateral truck so the focus point stays under the cursor on screen.
  if (hasFocus && Number.isFinite(_focus.x)) {
    // After the dolly, project the same NDC ray onto the plane through the
    // original focus (facing the camera). The delta is the required truck.
    if (clientToNdc(clientX, clientY, _ndc)) {
      // Temporarily place cam at the dollied position for a correct ray.
      const savedPos = cam.position.clone();
      cam.position.copy(_newPos);
      cam.updateMatrixWorld?.(true);
      _raycaster.setFromCamera(_ndc, cam);
      cam.position.copy(savedPos);
      cam.updateMatrixWorld?.(true);

      _plane.setFromNormalAndCoplanarPoint(snap.fwd, _focus);
      if (_raycaster.ray.intersectPlane(_plane, _after)) {
        _truck.subVectors(_focus, _after);
        if (_truck.lengthSq() > 1e-12) {
          _newPos.add(_truck);
          _newTarget.add(_truck);
        }
      }
    }
  }

  commitTranslation(
    controls, cam, _newPos, _newTarget,
    snap.quat, snap.up, snap.theta, snap.phi,
  );
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
  // factor > 1 = zoom in, factor < 1 = zoom out (matches applyPerspectiveZoom).
  const factor = Math.exp(-signed * speed);
  if (!Number.isFinite(factor) || factor <= 0) return;
  if (Math.abs(factor - 1) < 1e-4) return;

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
  console.log("[wheel-arbiter] cursor-centered zoom; orientation frozen (theta/phi lock)");
}
