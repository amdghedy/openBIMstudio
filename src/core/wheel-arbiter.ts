import * as THREE from "three";
import { ctx } from "./context";

type Any = Record<string, any>;

/**
 * Authoritative mouse-wheel zoom using camera-controls' native
 * dolly-to-cursor implementation.
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

function syncElementRect(controls: Any, rect: DOMRect): void {
  try {
    if (controls._elementRect) {
      controls._elementRect.x = rect.left;
      controls._elementRect.y = rect.top;
      controls._elementRect.width = rect.width;
      controls._elementRect.height = rect.height;
    }
  } catch {
    /* */
  }
  try {
    if (typeof controls.setViewport === "function") {
      controls.setViewport(undefined);
    }
  } catch {
    /* */
  }
}

function cursorNdc(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return { x, y };
}

function nativeCursorZoom(
  controls: Any,
  cam: THREE.Camera,
  deltaY: number,
  clientX: number,
  clientY: number,
  shift: boolean,
): boolean {
  const rect = getViewportRect();
  if (!rect || rect.width < 2 || rect.height < 2) return false;

  syncElementRect(controls, rect);
  const { x, y } = cursorNdc(clientX, clientY, rect);

  const speed = readMultiplier() * (shift ? 2.5 : 1);
  // amount > 0 → zoom in.
  // Default: wheel up (deltaY < 0) → amount > 0 → zoom in.
  // invert flips the mapping.
  const amount = (invert ? deltaY : -deltaY) * speed;

  const wasDollyToCursor = !!controls.dollyToCursor;
  try {
    controls.dollyToCursor = true;

    try {
      if (controls.enabled === false) controls.enabled = true;
    } catch {
      /* */
    }
    try {
      if ("dollySpeed" in controls && !(controls.dollySpeed > 0)) {
        controls.dollySpeed = 1.0;
      }
    } catch {
      /* */
    }

    const ortho = isOrthoCam(cam);

    if (ortho) {
      if (typeof controls._zoomInternal === "function") {
        // Positive amount → zoom in. Library zoom internals typically take
        // negative delta for zoom-in; match by negating.
        controls._zoomInternal(-amount * 0.01, x, y);
      } else if (typeof controls.zoom === "function") {
        const z = Math.max(1e-4, Number((cam as any).zoom) || 1);
        // amount > 0 → factor > 1 → higher ortho.zoom → zoom in
        const factor = Math.exp(amount * 0.0022);
        const newZ = Math.max(0.05, Math.min(8000, z * factor));
        if (typeof controls.zoomTo === "function") {
          const r = controls.zoomTo(newZ, false);
          if (r && typeof r.catch === "function") r.catch(() => { /* */ });
        } else {
          const r = controls.zoom(newZ - z, false);
          if (r && typeof r.catch === "function") r.catch(() => { /* */ });
        }
        truckOrthoToCursor(controls, cam, x, y, z, newZ);
      } else {
        return false;
      }
    } else {
      if (typeof controls._dollyInternal === "function") {
        // Native path: negative delta → dolly in (closer).
        // amount > 0 (zoom in) → pass negative.
        controls._dollyInternal(-amount * 0.01, x, y);
      } else if (typeof controls.dolly === "function") {
        let distance = 10;
        try {
          if (typeof controls.getDistance === "function") {
            distance = Math.max(controls.getDistance(), 0.5);
          } else if (controls._spherical?.radius) {
            distance = Math.max(controls._spherical.radius, 0.5);
          }
        } catch {
          /* */
        }
        // Public dolly: positive distance moves away (zoom out).
        // amount > 0 (zoom in) → negative dolly distance.
        const dollyDist = -amount * 0.0022 * distance;
        const r = controls.dolly(dollyDist, false);
        if (r && typeof r.catch === "function") r.catch(() => { /* */ });
      } else {
        return false;
      }
    }

    try {
      controls.update?.(0);
    } catch {
      /* */
    }
    return true;
  } catch (err) {
    console.warn("[wheel-arbiter] native cursor zoom failed", err);
    return false;
  } finally {
    try {
      controls.dollyToCursor = wasDollyToCursor;
    } catch {
      /* */
    }
  }
}

function truckOrthoToCursor(
  controls: Any,
  cam: THREE.Camera,
  ndcX: number,
  ndcY: number,
  oldZoom: number,
  newZoom: number,
): void {
  if (!isOrthoCam(cam) || !(cam as any).isOrthographicCamera) return;
  if (Math.abs(newZoom - oldZoom) < 1e-9) return;

  try {
    const ortho = cam as THREE.OrthographicCamera;
    const halfW = (ortho.right - ortho.left) / (2 * oldZoom);
    const halfH = (ortho.top - ortho.bottom) / (2 * oldZoom);
    const worldX0 = ndcX * halfW;
    const worldY0 = ndcY * halfH;

    const halfW1 = (ortho.right - ortho.left) / (2 * newZoom);
    const halfH1 = (ortho.top - ortho.bottom) / (2 * newZoom);
    const worldX1 = ndcX * halfW1;
    const worldY1 = ndcY * halfH1;

    const dx = worldX0 - worldX1;
    const dy = worldY0 - worldY1;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return;

    if (typeof controls.truck === "function") {
      const r = controls.truck(dx, dy, false);
      if (r && typeof r.catch === "function") r.catch(() => { /* */ });
    }
  } catch {
    /* */
  }
}

function applyZoom(ndelta: number, shift: boolean, clientX: number, clientY: number): void {
  const controls = getControls();
  const cam = resolveDrivenCamera();
  if (!cam || !controls) return;

  lockControlsWheel();

  const qBefore = cam.quaternion.clone();
  const dirBefore = cam.getWorldDirection(new THREE.Vector3()).clone();

  const ok = nativeCursorZoom(controls, cam, ndelta, clientX, clientY, shift);
  if (!ok) {
    console.warn("[wheel-arbiter] native path unavailable — no zoom applied");
    return;
  }

  try {
    const qAfter = cam.quaternion;
    const dot = Math.abs(
      qBefore.x * qAfter.x +
        qBefore.y * qAfter.y +
        qBefore.z * qAfter.z +
        qBefore.w * qAfter.w,
    );
    if (dot < 0.999) {
      cam.quaternion.copy(qBefore);
      cam.updateMatrixWorld?.(true);
      console.warn("[wheel-arbiter] orientation drift after native dolly (dot=" + dot.toFixed(6) + ")");
    }
    const dirAfter = cam.getWorldDirection(new THREE.Vector3());
    if (dirBefore.dot(dirAfter) < 0.999) {
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
  console.log("[wheel-arbiter] scroll-up zooms in; native dollyToCursor; default speed 10x");
}
