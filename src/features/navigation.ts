// openbim-fix:v3:applied -- do not re-apply the earlier fix scripts
/**
 * Industry-standard 3D Navigation (reset / hardened)
 *
 * Canonical BIM mouse map:
 *   MMB drag              Pan
 *   Shift + MMB drag      Orbit (around target)
 *   Ctrl + MMB drag       Orbit around selection
 *   Wheel                 Zoom to cursor
 *   Shift + Wheel         Zoom x3
 *   Double-click MMB      Zoom to fit
 *   LMB click             Select
 *   LMB drag L->R         Window select
 *   LMB drag R->L         Crossing select
 *   RMB                   Context menu
 *
 * CameraControls mouse/touch are forced OFF so only this module drives the view.
 * Every gesture ends with forceResumeCameraControls to prevent 3D hang-ups.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture, type Mods } from "../core/input-router";
import { fitAll, zoomBy, pickWorldPointUnderCursor } from "./camera-tools";
import { forceResumeCameraControls } from "../core/camera-gate";

type NavState =
  | { kind: "idle" }
  | {
      kind: "pan";
      startX: number;
      startY: number;
      startTarget: THREE.Vector3;
      startCam: THREE.Vector3;
      right: THREE.Vector3;
      up: THREE.Vector3;
      worldPerPx: number;
    }
  | {
      kind: "orbit";
      startX: number;
      startY: number;
      pivot: THREE.Vector3;
      startSpherical: THREE.Spherical;
      pixelsToRadians: number;
    }
  | {
      kind: "box-select";
      startX: number;
      startY: number;
      mode: "window" | "crossing";
    };

let state: NavState = { kind: "idle" };
let shiftHeld = false;
let ctrlHeld = false;

const blockers: Array<() => boolean> = [];

export function whenNavigationBlocked(fn: () => boolean): () => void {
  blockers.push(fn);
  return () => {
    const i = blockers.indexOf(fn);
    if (i >= 0) blockers.splice(i, 1);
  };
}

function blocked(): boolean {
  for (const b of blockers) {
    try {
      if (b()) return true;
    } catch {
      /* */
    }
  }
  try {
    if ((window as any).__obsPlanVisible?.()) return true;
    if (ctx.features?.drawing?.isActive?.()) return true;
    if (ctx.features?.walkMode?.isEnabled?.()) return true;
  } catch {
    /* */
  }
  return false;
}

export type ClickDelegate = (m: Mods, e: PointerEvent) => boolean;
export type DragDelegate = (g: Extract<Gesture, { kind: "drag-move" }>) => boolean;

const clickDelegates: ClickDelegate[] = [];
const dragDelegates: DragDelegate[] = [];

export function onNavClick(fn: ClickDelegate): () => void {
  clickDelegates.push(fn);
  return () => {
    const i = clickDelegates.indexOf(fn);
    if (i >= 0) clickDelegates.splice(i, 1);
  };
}

export function onNavDrag(fn: DragDelegate): () => void {
  dragDelegates.push(fn);
  return () => {
    const i = dragDelegates.indexOf(fn);
    if (i >= 0) dragDelegates.splice(i, 1);
  };
}

function controls(): any {
  return ctx.world.camera.controls;
}

function camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  return ctx.world.camera.three as any;
}

function getTarget(out = new THREE.Vector3()): THREE.Vector3 {
  const c = controls();
  if (c?.target?.isVector3) return out.copy(c.target);
  return out.set(0, 0, 0);
}

let cachedSelectionCenter: THREE.Vector3 | null = null;
let selectionCenterToken = 0;

async function refreshSelectionCenterCache(): Promise<void> {
  const myToken = ++selectionCenterToken;
  try {
    const box = await (ctx.features as any)?.selection?.boundingBox?.();
    if (myToken !== selectionCenterToken) return;
    if (box && !box.isEmpty()) {
      cachedSelectionCenter = box.getCenter(new THREE.Vector3());
      return;
    }
  } catch { /* */ }
  if (myToken !== selectionCenterToken) return;
  cachedSelectionCenter = null;
}

function getOrbitPivot(): THREE.Vector3 {
  if (cachedSelectionCenter) return cachedSelectionCenter.clone();
  return getTarget();
}

function beginPan(e: PointerEvent): void {
  const cam = camera();
  const rect = ctx.rightHost.getBoundingClientRect();
  if (rect.height < 1) return;

  const target = getTarget();
  const dist = cam.position.distanceTo(target);
  const isOrtho = (cam as any).isOrthographicCamera;
  let worldPerPx: number;
  if (isOrtho) {
    // In ortho, world-per-pixel depends on the frustum height and the
    // current zoom factor: (top - bottom) / zoom / viewportHeight.
    const o = cam as THREE.OrthographicCamera;
    const z = Math.max(1e-3, o.zoom || 1);
    worldPerPx = ((o.top - o.bottom) / z) / rect.height;
  } else {
    const vFov = THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov ?? 60);
    worldPerPx = (2 * Math.tan(vFov / 2) * Math.max(dist, 0.01)) / rect.height;
  }

  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);

  state = {
    kind: "pan",
    startX: e.clientX,
    startY: e.clientY,
    startTarget: target.clone(),
    startCam: cam.position.clone(),
    right,
    up,
    worldPerPx,
  };
}

function applyPan(dxTotal: number, dyTotal: number): void {
  if (state.kind !== "pan") return;
  const cam = camera();
  const c = controls();

  const offset = state.right
    .clone()
    .multiplyScalar(-dxTotal * state.worldPerPx)
    .add(state.up.clone().multiplyScalar(dyTotal * state.worldPerPx));

  const newPos = state.startCam.clone().add(offset);
  const newTarget = state.startTarget.clone().add(offset);

  try {
    if (c && c.enabled === false) c.enabled = true;
  } catch { /* */ }

  try {
    c.setLookAt(newPos.x, newPos.y, newPos.z, newTarget.x, newTarget.y, newTarget.z, false);
    try { c.update?.(0); } catch { /* */ }
  } catch {
    cam.position.copy(newPos);
    try { cam.lookAt(newTarget); } catch { /* */ }
  }
  try { ctx.cam.updateClipping(); } catch { /* */ }
}

function beginOrbitSync(e: PointerEvent, pivot: THREE.Vector3): void {
  const cam = camera();
  const camToPivot = cam.position.clone().sub(pivot);
  const spherical = new THREE.Spherical().setFromVector3(camToPivot);
  const rect = ctx.rightHost.getBoundingClientRect();
  const pixelsToRadians = (Math.PI * 2) / Math.max(rect.height, 400);

  state = {
    kind: "orbit",
    startX: e.clientX,
    startY: e.clientY,
    pivot,
    startSpherical: spherical,
    pixelsToRadians,
  };
}

async function selectionCenter(): Promise<THREE.Vector3> {
  try {
    const box = await (ctx.features as any)?.selection?.boundingBox?.();
    if (box && !box.isEmpty()) return box.getCenter(new THREE.Vector3());
  } catch {
    /* */
  }
  const auth = (ctx.features as any)?.authoring;
  if (auth?.getSelectedIds?.()?.length) {
    const ids = auth.getSelectedIds() as string[];
    const b = new THREE.Box3();
    for (const id of ids) {
      const el = auth.getElementById?.(id);
      if (!el) continue;
      const wb = auth.getElementWorldBox?.(el);
      if (wb && !wb.isEmpty()) b.union(wb);
    }
    if (!b.isEmpty()) return b.getCenter(new THREE.Vector3());
  }
  return getTarget();
}

function applyOrbit(dxTotal: number, dyTotal: number): void {
  if (state.kind !== "orbit") return;
  const cam = camera();
  const c = controls();

  const sph = state.startSpherical.clone();
  sph.theta -= dxTotal * state.pixelsToRadians * 1.4;
  sph.phi -= dyTotal * state.pixelsToRadians * 1.4;
  sph.phi = THREE.MathUtils.clamp(sph.phi, 0.02, Math.PI - 0.02);

  // In ortho, the visible size is controlled by zoom, so any radius
  // works — but keep it close for stable near/far clipping.
  const isOrtho = (cam as any).isOrthographicCamera;
  if (isOrtho) {
    sph.radius = Math.max(sph.radius, __obsGetSceneRadiusFallback() * 1.5);
  }

  const newPos = state.pivot.clone().add(new THREE.Vector3().setFromSpherical(sph));

  try { if (c && c.enabled === false) c.enabled = true; } catch { /* */ }

  try {
    c.setLookAt(newPos.x, newPos.y, newPos.z, state.pivot.x, state.pivot.y, state.pivot.z, false);
    try { c.update?.(0); } catch { /* */ }
  } catch {
    cam.position.copy(newPos);
    cam.lookAt(state.pivot);
  }
  try { ctx.cam.updateClipping(); } catch { /* */ }
}

export function zoomAtCursor(deltaY: number, mods: Mods, focus: THREE.Vector3 | null): void {
  const multiplier = mods.shift ? 2.5 : 1;
  const discrete = mods.ctrl || mods.meta ? Math.sign(deltaY || 1) * 0.2 : 0;
  const raw = (deltaY || 0) * 0.0012 * multiplier;
  let factor = Math.exp(raw + discrete);
  if (!Number.isFinite(factor) || factor <= 0) return;
  if (Math.abs(factor - 1) < 0.002) return;
  zoomBy(factor, focus ?? undefined);
}

let overlay: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "obs-nav-box";
  overlay.style.cssText =
    "position:absolute;pointer-events:none;z-index:70;display:none;" +
    "box-sizing:border-box;border-radius:1px";
  ctx.rightHost.appendChild(overlay);
  return overlay;
}

function renderBox(
  mode: "window" | "crossing",
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  const el = ensureOverlay();
  const x1 = Math.min(ax, bx);
  const y1 = Math.min(ay, by);
  const x2 = Math.max(ax, bx);
  const y2 = Math.max(ay, by);
  el.style.left = `${x1}px`;
  el.style.top = `${y1}px`;
  el.style.width = `${Math.max(1, x2 - x1)}px`;
  el.style.height = `${Math.max(1, y2 - y1)}px`;
  el.style.display = "block";
  if (mode === "window") {
    el.style.background = "rgba(56,189,248,0.14)";
    el.style.border = "1px solid #38bdf8";
  } else {
    el.style.background = "rgba(34,197,94,0.14)";
    el.style.border = "1px dashed #22c55e";
  }
}

function hideBox(): void {
  if (overlay) overlay.style.display = "none";
}

function attachModifierTracking(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Shift") shiftHeld = true;
      else if (e.key === "Control" || e.key === "Meta") ctrlHeld = true;
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Shift") shiftHeld = false;
      else if (e.key === "Control" || e.key === "Meta") ctrlHeld = false;
    },
    true,
  );
  window.addEventListener("blur", () => {
    shiftHeld = false;
    ctrlHeld = false;
  });
}

function isUiTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return false;
  if (t.tagName === "CANVAS") return false;
  return !!t.closest(
    "input,select,textarea,button,label,a,[contenteditable]," +
      ".obs-revit-options,.obs-revit-contextual,.obs-revit-viewbar," +
      ".obs-plan-overlay,#obs-ai-chat,#obs-command-palette," +
      "[data-obs-panel],.obs-panel,.bb-status,.obs-toast-host",
  );
}

export function setupNavigation(): void {
  ensureOverlay();
  attachModifierTracking();
  disableNativeCameraMouse();
  try { forceResumeCameraControls(); } catch { /* */ }

  try {
    const sel: any = (ctx.features as any).selection;
    sel?.onChange?.(() => { void refreshSelectionCenterCache(); });
    void refreshSelectionCenterCache();
  } catch { /* */ }

  const safetyEnd = () => {
    endNavGesture();
  };
  window.addEventListener("pointercancel", safetyEnd, true);
  window.addEventListener("blur", safetyEnd);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) safetyEnd();
  });

  inputRouter.registerCancel(() => {
    if (state.kind === "idle") return false;
    endNavGesture();
    return true;
  });

  inputRouter.subscribe((g) => {
    if (g.kind === "drag-start" && g.button === 1) {
      if (blocked() || isUiTarget(g.event)) return false;
      disableNativeCameraMouse();
      try { forceResumeCameraControls(); } catch { /* */ }
      const wantOrbit = shiftHeld || ctrlHeld || g.mods.shift || g.mods.ctrl || g.mods.meta;
      if (wantOrbit) {
        const pivot = getOrbitPivot();
        beginOrbitSync(g.event, pivot);
        ctx.rightHost.style.cursor = "grabbing";
        if (!cachedSelectionCenter) {
          void selectionCenter().then((p) => {
            if (state.kind !== "orbit") return;
            if (p.distanceTo(state.pivot) < 1e-3) return;
            beginOrbitSync(g.event, p);
          });
        }
      } else {
        beginPan(g.event);
        ctx.rightHost.style.cursor = "move";
      }
      return true;
    }

    if (g.kind === "drag-move" && g.button === 1) {
      const wantOrbit = shiftHeld || g.mods.shift || ctrlHeld || g.mods.ctrl || g.mods.meta;
      if (wantOrbit && state.kind === "pan") {
        beginOrbitSync(g.event, getOrbitPivot());
        ctx.rightHost.style.cursor = "grabbing";
      }
      if (state.kind === "pan") {
        applyPan(g.dx, g.dy);
        return true;
      }
      if (state.kind === "orbit") {
        applyOrbit(g.dx, g.dy);
        return true;
      }
      return false;
    }

    if (g.kind === "drag-end" && g.button === 1) {
      if (state.kind === "pan" || state.kind === "orbit") {
        endNavGesture();
        return true;
      }
      try { forceResumeCameraControls(); } catch { /* */ }
      return false;
    }

    if (g.kind === "drag-start" && g.button === 0) {
      if (blocked() || isUiTarget(g.event)) return false;
      const probe: Extract<Gesture, { kind: "drag-move" }> = {
        kind: "drag-move",
        button: 0,
        mods: g.mods,
        dx: 0,
        dy: 0,
        event: g.event,
      };
      for (const d of dragDelegates) {
        try {
          if (d(probe)) return false;
        } catch (err) {
          console.error("[navigation] drag delegate threw", err);
        }
      }
      state = {
        kind: "box-select",
        startX: g.event.clientX,
        startY: g.event.clientY,
        mode: "window",
      };
      ctx.rightHost.style.cursor = "crosshair";
      return true;
    }

    if (g.kind === "drag-move" && state.kind === "box-select") {
      for (const d of dragDelegates) {
        try {
          if (d(g)) {
            hideBox();
            state = { kind: "idle" };
            ctx.rightHost.style.cursor = "";
            return false;
          }
        } catch (err) {
          console.error("[navigation] drag delegate threw", err);
        }
      }
      const rect = ctx.rightHost.getBoundingClientRect();
      const mode: "window" | "crossing" =
        g.event.clientX >= (state as any).startX ? "window" : "crossing";
      (state as any).mode = mode;
      renderBox(
        mode,
        (state as any).startX - rect.left,
        (state as any).startY - rect.top,
        g.event.clientX - rect.left,
        g.event.clientY - rect.top,
      );
      return true;
    }

    if (g.kind === "drag-end" && g.button === 0 && state.kind === "box-select") {
      const rect = ctx.rightHost.getBoundingClientRect();
      const x1 = state.startX - rect.left;
      const y1 = state.startY - rect.top;
      const x2 = g.event.clientX - rect.left;
      const y2 = g.event.clientY - rect.top;
      hideBox();
      state = { kind: "idle" };
      try { ctx.rightHost.style.cursor = ""; } catch { /* */ }
      try { forceResumeCameraControls(); } catch { /* */ }

      if (Math.abs(x2 - x1) < 3 && Math.abs(y2 - y1) < 3) return false;

      const mode: "window" | "crossing" = x2 >= x1 ? "window" : "crossing";
      void (ctx.features as any).boxSelection?.commit?.(
        {
          x1: Math.min(x1, x2),
          y1: Math.min(y1, y2),
          x2: Math.max(x1, x2),
          y2: Math.max(y1, y2),
        },
        mode,
      );
      return true;
    }

    if (g.kind === "click" && g.button === 0) {
      if (blocked()) return false;
      for (const d of clickDelegates) {
        try {
          if (d(g.mods, g.event)) return true;
        } catch (err) {
          console.error("[navigation] click delegate threw", err);
        }
      }
      return false;
    }

    if (g.kind === "wheel") {
      if ((window as any).__OBS_MMB_HELD) return true;
      if (blocked() || isUiTarget(g.event)) return false;
      const mods: Mods = g.mods ?? {
        ctrl: g.event.ctrlKey,
        shift: g.event.shiftKey,
        alt: g.event.altKey,
        meta: g.event.metaKey,
      };
      // openbim-fix: navigation.ts -- check wheel authority before raycasting
      if ((window as any).__OBS_WHEEL_AUTHORITY) return false;
      const focus = pickWorldPointUnderCursor(g.event.clientX, g.event.clientY);
      zoomAtCursor(g.event.deltaY, mods, focus);
      return true;
    }

    if (g.kind === "dblclick" && g.button === 1) {
      if (blocked() || isUiTarget(g.event)) return false;
      fitAll();
      return true;
    }

    return false;
  }, 30);

  ctx.rightHost.addEventListener(
    "wheel",
    (e) => {
      if (!isUiTarget(e)) e.preventDefault();
    },
    { passive: false },
  );

  (ctx.features as any).navigation = {
    getState: () => state,
    whenBlocked: whenNavigationBlocked,
    onNavClick,
    onNavDrag,
  };

  console.log("[navigation] BIM-style navigation active");
}

export function getNavigationState(): NavState {
  return state;
}

export function cancelNavigationGesture(): void {
  state = { kind: "idle" };
  hideBox();
  try { ctx.rightHost.style.cursor = ""; } catch { /* */ }
  try { forceResumeCameraControls(); } catch { /* */ }
}

function disableNativeCameraMouse(): void {
  try {
    const c: any = controls();
    if (!c) return;
    const ACTION = c.constructor?.ACTION || (window as any).CameraControls?.ACTION;
    if (c.mouseButtons && ACTION) {
      c.mouseButtons.left = ACTION.NONE ?? 0;
      c.mouseButtons.middle = ACTION.NONE ?? 0;
      c.mouseButtons.right = ACTION.NONE ?? 0;
      c.mouseButtons.wheel = ACTION.NONE ?? 0;
    }
    if (c.touches && ACTION) {
      try {
        c.touches.one = ACTION.NONE ?? 0;
        c.touches.two = ACTION.NONE ?? 0;
        c.touches.three = ACTION.NONE ?? 0;
      } catch { /* */ }
    }
    /* dampingFactor deprecated; smoothTime is used instead */
    try { if ("draggingSmoothTime" in c) c.draggingSmoothTime = 0; } catch { /* */ }
    try { if ("azimuthRotateSpeed" in c) c.azimuthRotateSpeed = 1; } catch { /* */ }
    try { if ("polarRotateSpeed" in c) c.polarRotateSpeed = 1; } catch { /* */ }
  } catch (e) {
    console.warn("[navigation] disableNativeCameraMouse", e);
  }
}

function endNavGesture(resetCursor = true): void {
  state = { kind: "idle" };
  hideBox();
  if (resetCursor) {
    try { ctx.rightHost.style.cursor = ""; } catch { /* */ }
  }
  try { forceResumeCameraControls(); } catch { /* */ }
}

function __obsGetSceneRadiusFallback(): number {
  try {
    const c: any = (window as any).__OBS_CTX__;
    const box = c?.scene?.box;

    if (box && typeof box.isEmpty === "function" && !box.isEmpty()) {
      const min = box.min;
      const max = box.max;

      if (min && max) {
        const dx = Number(max.x) - Number(min.x);
        const dy = Number(max.y) - Number(min.y);
        const dz = Number(max.z) - Number(min.z);

        const r = Math.hypot(dx, dy, dz);

        if (Number.isFinite(r) && r > 0) {
          return r;
        }
      }
    }
  } catch {
    // Ignore and use fallback radius.
  }

  return 100;
}
