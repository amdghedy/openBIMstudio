import { ctx } from "./context";

type Any = Record<string, any>;

/*
 * Input arbiter.
 *
 * This module does NOT install its own pan/orbit/zoom behaviour and does NOT
 * mutate CameraControls mouse buttons (navigation.ts already forces those OFF
 * and is the single driver). Instead it maintains a few WINDOW-LEVEL FLAGS that
 * navigation.ts and the rest of the app read, plus a couple of capture-phase
 * guards that are safe regardless of listener registration order:
 *
 *   __OBS_MMB_HELD   : true while middle button is down
 *   __OBS_MMB_MOVED  : true once the MMB drag exceeded a few pixels
 *   __OBS_MMB_DOWN_T : timestamp of MMB down (watchdog)
 *   __OBS_BLOCK_MMB_CLICK : swallow the synthetic click after a dragged MMB
 *
 * Why flags instead of stopPropagation? Because navigation.ts / selection.ts
 * register their window capture listeners during app boot, i.e. BEFORE this
 * arbiter is imported by critical-gaps-boot. A later capture listener cannot
 * cancel an earlier one. Flags, however, are simply *read* by the earlier
 * handlers at the moment they run, so coordination works in any order.
 *
 * The only things we actively suppress at capture phase are:
 *   - wheel events while __OBS_MMB_HELD (no zoom-out during a pan)
 *   - the click that the browser synthesises after a DRAGGED MMB (so a pan
 *     never also selects / focuses / fits)
 * Both are safe to suppress because they are never legitimate during those
 * states under the documented Revit map.
 */

let installed = false;

const MMB_MOVE_THRESHOLD = 3;     // px before a press becomes a drag
const MMB_CLICK_WINDOW = 380;     // ms for a genuine double-MMB (kept for fit)
const WATCHDOG_MS = 8000;         // clear stuck HELD if no up arrived

function w(): Any { return window as Any; }

function clearMMB(): void {
  const W = w();
  W.__OBS_MMB_HELD = false;
  W.__OBS_MMB_MOVED = false;
  W.__OBS_MMB_DOWN_T = 0;
}

function isTextInput(target: EventTarget | null): boolean {
  const el = target as Any;
  if (!el) return false;
  const tag = String(el.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" &&
      el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return false;
}

function activeAuthoringTool(): string | null {
  const c = ctx as Any;
  const a = (c.features as Any)?.authoring as Any;
  const t =
    a?.getActiveTool?.() ?? a?.activeTool ?? a?.currentTool ?? null;
  if (typeof t === "string" && t && t !== "select") return t;
  return null;
}

function cancelActiveOperation(): boolean {
  let canceled = false;
  const W = w();

  // 1) drafting overlay (left-mouse tool)
  const d = W.__obsDrafting2D;
  if (d && typeof d.getTool === "function" && d.getTool()) {
    d.setTool(null);
    canceled = true;
  }

  // 2) authoring placement tool
  const c = ctx as Any;
  const a = (c.features as Any)?.authoring as Any;
  if (activeAuthoringTool()) {
    if (typeof a?.setAuthoringTool === "function") {
      a.setAuthoringTool(null);
      canceled = true;
    }
  }

  // 3) measure / section / walk (best effort through known globals)
  const m = W.__obsMeasure;
  if (m && (typeof m.isEnabled === "function" ? m.isEnabled() : m.enabled)) {
    m.setMeasureEnabled?.(false); m.disable?.(); canceled = true;
  }
  const s = W.__obsSection;
  if (s && (typeof s.isSectionOn === "function" ? s.isSectionOn() : s.enabled)) {
    s.setSectionOn?.(false); s.disable?.(); canceled = true;
  }
  const wk = W.__obsWalkMode;
  if (wk && (typeof wk.isActive === "function" ? wk.isActive() : wk.enabled)) {
    wk.disable?.(); wk.setActive?.(false); canceled = true;
  }

  // 4) always drop MMB arbitration state on a cancel
  clearMMB();

  if (canceled) {
    try { window.dispatchEvent(new CustomEvent("obs:operation-cancelled")); } catch { /* */ }
  }
  return canceled;
}

function installArbiter(): void {
  const W = w();

  // ---- pointer tracking (capture; we never stopPropagation on down/move so
  //      navigation.ts still receives the gesture and can pan/orbit) ----
  window.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 1) return;            // middle only
    W.__OBS_MMB_HELD = true;
    W.__OBS_MMB_MOVED = false;
    W.__OBS_MMB_DOWN_T = performance.now();
    W.__OBS_MMB_START_X = e.clientX;
    W.__OBS_MMB_START_Y = e.clientY;
  }, true);

  window.addEventListener("pointermove", (e: PointerEvent) => {
    if (!W.__OBS_MMB_HELD) return;
    const dx = e.clientX - (W.__OBS_MMB_START_X ?? e.clientX);
    const dy = e.clientY - (W.__OBS_MMB_START_Y ?? e.clientY);
    if (Math.hypot(dx, dy) > MMB_MOVE_THRESHOLD) {
      W.__OBS_MMB_MOVED = true;
    }
  }, true);

  const onUp = (e: PointerEvent | MouseEvent) => {
    const be = e as PointerEvent;
    if (typeof be.button === "number" && be.button !== 1) return;
    const moved = !!W.__OBS_MMB_MOVED;
    const downT = Number(W.__OBS_MMB_DOWN_T || 0);
    clearMMB();
    // A dragged MMB must not also produce a select / focus / fit click.
    if (moved) {
      W.__OBS_BLOCK_MMB_CLICK = true;
      window.setTimeout(() => { W.__OBS_BLOCK_MMB_CLICK = false; }, 0);
    }
    // remember a clean (no-move) MMB click time for genuine double-MMB fit
    if (!moved && downT > 0) {
      W.__OBS_LAST_MMB_CLICK_T = performance.now();
    }
  };
  window.addEventListener("pointerup", onUp as any, true);
  window.addEventListener("pointercancel", onUp as any, true);
  window.addEventListener("mouseup", onUp as any, true);   // backup
  window.addEventListener("blur", () => clearMMB(), true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearMMB();
  });

  // ---- wheel guard: no zoom while panning (capture; safe to suppress) ----
  window.addEventListener("wheel", (e: WheelEvent) => {
    if (W.__OBS_MMB_HELD) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true, passive: false });

  // ---- swallow the synthetic click after a dragged MMB ----
  window.addEventListener("click", (e: MouseEvent) => {
    if (e.button === 1 && W.__OBS_BLOCK_MMB_CLICK) {
      e.preventDefault();
      e.stopPropagation();
      W.__OBS_BLOCK_MMB_CLICK = false;
    }
  }, true);

  // ---- watchdog: never leave HELD stuck if an up was missed ----
  window.setInterval(() => {
    if (W.__OBS_MMB_HELD && W.__OBS_MMB_DOWN_T &&
        performance.now() - Number(W.__OBS_MMB_DOWN_T) > WATCHDOG_MS) {
      clearMMB();
    }
  }, 1000);

  // ---- keyboard / right-click cancel (Revit behaviour) ----
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    if (e.key === "Escape") {
      if (cancelActiveOperation()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }, true);

  window.addEventListener("contextmenu", (e: MouseEvent) => {
    // Only cancel when an operation is actually active; otherwise let
    // navigation.ts open its right-click context menu untouched.
    if (cancelActiveOperation()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  W.__obsRevitMousePolicy = {
    cancelOperation: cancelActiveOperation,
    isMMBHeld: () => !!w().__OBS_MMB_HELD,
    isMMBMoved: () => !!w().__OBS_MMB_MOVED,
    clearMMB,
  };
}

export function setupRevitMousePolicy(): void {
  if (installed) return;
  installed = true;

  // NOTE: we deliberately do NOT call any disableNativeCameraMouse() here.
  // navigation.ts already forces CameraControls mouse/touch OFF and re-asserts
  // it via forceResumeCameraControls(); a second writer raced with it and was a
  // source of the rotate/zoom-on-release artefact.

  installArbiter();

  console.log(
    "[revit-mouse-policy] arbiter ready: flags-only coordination; " +
    "wheel blocked while MMB held; dragged-MMB click suppressed; " +
    "Esc / RMB cancel active tool; navigation.ts remains sole MMB/wheel owner",
  );
}