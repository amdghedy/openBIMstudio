import * as THREE from "three";
import { ctx } from "./context";
import { pointerNdc, wheelDistanceFactor } from "./cursor-zoom";
import { zoomBy, pickWorldPointUnderCursor } from "../features/camera-tools";

type Any = Record<string, any>;

/**
 * Authoritative mouse-wheel zoom (cursor-anchored, see core/cursor-zoom.ts).
 *
 * Wheel direction (default):
 *   scroll up   → zoom in
 *   scroll down → zoom out
 *
 * Contract:
 *   - Wheel never rotates (azimuth/polar unchanged; only radius or zoom).
 *   - Zoom aims at the world point under the cursor.
 *   - Perspective: dolly (camera moves).
 *   - Orthographic: zoom (frustum scale) with the same cursor anchor.
 */

let installed = false;
let enabled = true;
let invert = false;
let multiplier = 10;

const UI_BLOCK =
  ".obs-panel,[data-obs-panel],#obs-ai-chat,#obs-bim-toolbox,.obs-ribbon," +
  ".obs-property,.obs-dialog,.obs-adv-toolbar,.obs-plan-view,#plan-svg," +
  "input,textarea,select,button,label,a,[contenteditable=true],#obs-cad-viewer,[data-obs-own-wheel]";

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
  if (d > 100) d = 100;
  if (d < -100) d = -100;
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

/** Last anchor, reused while the pointer rests: the anchor keeps its pixel, so reusing it is exact. */
let lastAnchor: { p: THREE.Vector3; x: number; y: number; t: number } | null = null;

function anchorFor(clientX: number, clientY: number): THREE.Vector3 | null {
  const now = performance.now();
  const a = lastAnchor;
  if (a && now - a.t < 250 && Math.hypot(clientX - a.x, clientY - a.y) < 3) { a.t = now; return a.p; }
  const p = pickWorldPointUnderCursor(clientX, clientY);
  lastAnchor = p ? { p, x: clientX, y: clientY, t: now } : null;
  return p;
}

/**
 * One wheel notch = one zoomBy(). Zoom is anchored on the world point under the pointer
 * (raycast, else the camera-facing plane through the orbit target). Camera orientation is never
 * touched: zoomBy only moves position/target along the same view direction (or ortho zoom).
 */
function applyZoom(e: WheelEvent): boolean {
  const controls = getControls();
  const cam = resolveDrivenCamera();
  if (!cam || !controls) return false;
  const rect = getViewportRect();
  if (!rect || !pointerNdc(e.clientX, e.clientY, rect)) return false; // outside the viewport
  lockControlsWheel(); // the library's own wheel action must never also zoom
  const qBefore = cam.quaternion.clone();
  const dy = invert ? -e.deltaY : e.deltaY;
  const factor = wheelDistanceFactor(dy, e.deltaMode, readMultiplier(), e.shiftKey);
  if (factor === 1) return true;
  zoomBy(factor, anchorFor(e.clientX, e.clientY) ?? undefined);
  const dot = Math.abs(qBefore.dot(cam.quaternion));
  if (dot < 0.999999) console.warn("[wheel-arbiter] camera orientation changed during wheel zoom (dot=" + dot.toFixed(7) + ")");
  try { window.dispatchEvent(new CustomEvent("obs:camera-changed")); } catch { /* */ }
  return true;
}

function onWheel(e: WheelEvent): void {
  if (!enabled) return;
  if ((w() as Any).__OBS_MMB_HELD) return;
  if (!isOverViewport(e.target)) return;
  if (normalizeDelta(e) === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  applyZoom(e);
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
  console.log("[wheel-arbiter] scroll-up zooms in; cursor-anchored zoomBy; default speed 10x");
}
