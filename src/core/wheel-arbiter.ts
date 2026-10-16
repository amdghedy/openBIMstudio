import * as THREE from "three";
import { ctx } from "./context";

type Any = Record<string, any>;

/*
 * Single authoritative wheel-zoom owner for the 3D viewport.
 *
 * Why this exists:
 *   navigation.ts (router wheel branch) AND a secondary ortho/plan handler
 *   both consumed wheel events, producing double-zoom / jitter, and the raw
 *   deltaY sign was not normalized across deltaMode (pixel/line/page), so
 *   "up" vs "down" felt inverted on some devices. Middle-mouse pan also let
 *   wheel leak through.
 *
 * This module:
 *   - normalizes deltaY (deltaMode + clamp) and applies Revit convention
 *     (wheel up = zoom in). setInvert(true) flips it for reversed devices.
 *   - Shift = x3, plus the registered nav.wheelZoomMultiplier option.
 *   - ignores wheel while __OBS_MMB_HELD (no zoom during pan).
 *   - ignores wheel over panels / ribbon / property palette / plan SVG /
 *     text inputs, so 2D plan zoom and UI scrolling are not stolen.
 *   - stopImmediatePropagation() so no secondary module double-zooms.
 *   - sets window.__OBS_WHEEL_AUTHORITY = true permanently after install,
 *     which navigation.ts reads to no-op its router wheel branch (this is
 *     order-independent: the flag is set once at boot, not per-event).
 *
 * It does NOT touch CameraControls mouse mapping (navigation owns that).
 */

let installed = false;
let enabled = true;
let invert = false;
let multiplier = 1;

const UI_BLOCK =
  ".obs-panel,[data-obs-panel],#obs-ai-chat,#obs-bim-toolbox,.obs-ribbon," +
  ".obs-property,.obs-dialog,.obs-adv-toolbar,.obs-plan-view,#plan-svg," +
  "input,textarea,select,button,label,a,[contenteditable=true]";

function w(): Any { return window as Any; }

function readMultiplier(): number {
  try {
    const reg: Any = (w().__obsOptionsRegistry ?? null);
    const v = reg?.get?.("nav.wheelZoomMultiplier");
    if (typeof v === "number" && v > 0) return v;
  } catch { /* registry optional */ }
  return multiplier;
}

function normalizeDelta(e: WheelEvent): number {
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;        // DOM_DELTA_LINE
  else if (e.deltaMode === 2) d *= 100;  // DOM_DELTA_PAGE
  // clamp trackpad momentum spikes
  if (d > 600) d = 600;
  if (d < -600) d = -600;
  return d;
}

function isOverViewport(target: EventTarget | null): boolean {
  const el = target as Any;
  if (!el) return false;
  if (typeof el.closest === "function" && el.closest(UI_BLOCK)) return false;
  // must be inside the 3D host / canvas, not a side panel
  const c = ctx as Any;
  const host: Any = c.rightHost;
  if (host && host.contains && !host.contains(el)) {
    // allow the canvas itself even if rightHost ref is stale
    const tag = String(el.tagName ?? "").toUpperCase();
    if (tag !== "CANVAS") return false;
  }
  return true;
}

function applyZoom(ndelta: number, shift: boolean): void {
  const c = ctx as Any;
  const cam: Any = c.world?.camera?.three;
  const controls: Any = c.world?.camera?.controls;
  if (!cam) return;

  const speed = 0.0016 * readMultiplier() * (shift ? 3 : 1);
  // Revit: wheel up (ndelta < 0) => zoom in => factor > 1
  const signed = invert ? -ndelta : ndelta;
  const factor = Math.exp(-signed * speed);
  if (!Number.isFinite(factor) || factor <= 0) return;

  const isOrtho = cam.isOrthographicCamera === true;

  if (isOrtho) {
    cam.zoom = Math.max(1e-4, cam.zoom * factor);
    cam.updateProjectionMatrix();
  } else {
    const target = new THREE.Vector3();
    let got = false;
    try { if (typeof controls?.getTarget === "function") { controls.getTarget(target); got = true; } } catch { /* */ }
    if (!got) {
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      target.copy(cam.position).addScaledVector(fwd, 10);
    }
    const dir = new THREE.Vector3().subVectors(cam.position, target);
    const dist = dir.length();
    if (dist < 1e-6) return;
    const newDist = Math.max(1e-4, dist / factor);
    dir.normalize().multiplyScalar(newDist);
    const np = new THREE.Vector3().addVectors(target, dir);
    try {
      controls.setLookAt(np.x, np.y, np.z, target.x, target.y, target.z, false);
      controls.update?.(0);
    } catch {
      cam.position.copy(np);
    }
  }

  try { window.dispatchEvent(new CustomEvent("obs:camera-changed")); } catch { /* */ }
}

function onWheel(e: WheelEvent): void {
  if (!enabled) return;
  if ((w() as Any).__OBS_MMB_HELD) return;          // panning: no zoom
  if (!isOverViewport(e.target)) return;            // panels / UI / plan svg
  const nd = normalizeDelta(e);
  if (nd === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  applyZoom(nd, !!e.shiftKey);
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
export function isWheelEnabled(): boolean { return enabled; }

export function setupWheelArbiter(): void {
  if (installed) return;
  installed = true;

  // Permanent flag read by navigation.ts router-wheel branch (order-independent).
  (w() as Any).__OBS_WHEEL_AUTHORITY = true;

  window.addEventListener("wheel", onWheel, { capture: true, passive: false });

  (w() as Any).__obsWheelFix = {
    setInvert: setWheelInvert,
    setMultiplier: setWheelMultiplier,
    setEnabled: setWheelEnabled,
    isEnabled: isWheelEnabled,
    getState: () => ({ enabled, invert, multiplier: readMultiplier() }),
  };

  console.log(
    "[wheel-arbiter] single owner ready: Revit direction (up=zoom-in), " +
    "deltaMode normalized, Shift=x3, ignored while MMB held / over panels. " +
    "Flip direction with __obsWheelFix.setInvert(true) if your device is reversed.",
  );
}