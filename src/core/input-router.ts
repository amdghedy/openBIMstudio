/**
 * Single authoritative pointer / wheel / Escape router for the 3D viewport.
 *
 * Key properties:
 *   • Gesture ownership — the first handler to accept a `drag-start` owns
 *     that gesture. Only the owner sees `drag-move` and `drag-end`.
 *   • Priority ordering — higher priority runs first. Gizmo (100) beats
 *     box-select (50) beats context-menu (20) beats authoring (10).
 *   • Cancel registration — Escape handlers run in reverse registration
 *     order; the first to return true consumes the key.
 *   • Camera auto-pause — the router pauses CameraControls for the duration
 *     of any claimed drag and releases it on drag-end.
 *   • Hover — throttled to one dispatch per frame; all subscribers receive it.
 *
 * The router attaches capture-phase listeners to the host so it sees events
 * before anything else, but only calls preventDefault / stopPropagation when
 * a handler claims the gesture. Unclaimed input falls through to the camera
 * controls and any legacy listeners still present.
 */
import { ctx } from "./context";
import { pauseCameraControls, forceResumeCameraControls } from "./camera-gate";

export type PointerButton = 0 | 1 | 2;

export interface Mods {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type Gesture =
  | { kind: "click"; button: PointerButton; mods: Mods; event: PointerEvent }
  | { kind: "dblclick"; button: PointerButton; mods: Mods; event: PointerEvent }
  | { kind: "drag-start"; button: PointerButton; mods: Mods; event: PointerEvent }
  | { kind: "drag-move"; button: PointerButton; mods: Mods; dx: number; dy: number; event: PointerEvent }
  | { kind: "drag-end"; button: PointerButton; mods: Mods; dx: number; dy: number; moved: boolean; event: PointerEvent }
  | { kind: "rmb-click"; mods: Mods; event: PointerEvent }
  | { kind: "wheel"; event: WheelEvent; mods: Mods };

export type GestureHandler = (g: Gesture) => boolean;
export type HoverHandler = (e: PointerEvent) => void;
export type CancelHandler = () => boolean;


/** True when the event originated on a floating panel / form control — not the canvas. */
function isUiEventTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.closest(
    "input,textarea,select,button,label,a," +
    "[contenteditable=true],[data-obs-window-controls]",
  )) return true;
  // Any dockable / floating panel shell
  if (el.closest(
    '#obs-ai-chat,#obs-bim-toolbox,[id^="obs-"],[data-obs-panel],.obs-panel,.obs-toast-host',
  )) {
    // Still allow canvas-like surfaces inside panels (e.g. plan view)
    if (el.closest("canvas")) return false;
    return true;
  }
  return false;
}

const DRAG_THRESHOLD = 4;
const DBLCLICK_MS = 320;
const DBLCLICK_PX = 6;

interface Sub { fn: GestureHandler; priority: number; order: number; }

class InputRouterImpl {
  private host: HTMLElement | null = null;
  private subs: Sub[] = [];
  private hoverHandlers: HoverHandler[] = [];
  private cancelHandlers: CancelHandler[] = [];
  private orderCounter = 0;

  private down: {
    x: number; y: number;
    button: PointerButton;
    mods: Mods;
    moved: boolean;
    id: number;
  } | null = null;

  private owner: GestureHandler | null = null;
  private releaseCamera: (() => void) | null = null;

  private lastClick: { t: number; x: number; y: number; button: PointerButton } | null = null;

  private hoverPending = false;
  private lastHoverEvent: PointerEvent | null = null;

  /* ── Lifecycle ─────────────────────────────────────────────────── */
  attach(host: HTMLElement): void {
    if (this.host === host) return;
    this.detach();
    this.host = host;
    host.addEventListener("pointerdown", this.onDown, { capture: true });
    host.addEventListener("pointermove", this.onMove, { capture: true });
    host.addEventListener("pointerup", this.onUp, { capture: true });
    host.addEventListener("pointercancel", this.onUp, { capture: true });
    host.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    host.addEventListener("contextmenu", this.onContextMenu, { capture: true });
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
  }

  detach(): void {
    const host = this.host;
    if (host) {
      host.removeEventListener("pointerdown", this.onDown, true);
      host.removeEventListener("pointermove", this.onMove, true);
      host.removeEventListener("pointerup", this.onUp, true);
      host.removeEventListener("pointercancel", this.onUp, true);
      host.removeEventListener("wheel", this.onWheel, true);
      host.removeEventListener("contextmenu", this.onContextMenu, true);
    }
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.host = null;
    this.down = null;
    this.releaseOwner();
  }

  /* ── Subscription ──────────────────────────────────────────────── */
  subscribe(h: GestureHandler, priority = 0): () => void {
    const sub: Sub = { fn: h, priority, order: this.orderCounter++ };
    this.subs.push(sub);
    this.subs.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return () => {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  subscribeHover(h: HoverHandler): () => void {
    this.hoverHandlers.push(h);
    return () => {
      const i = this.hoverHandlers.indexOf(h);
      if (i >= 0) this.hoverHandlers.splice(i, 1);
    };
  }

  registerCancel(h: CancelHandler): () => void {
    this.cancelHandlers.push(h);
    return () => {
      const i = this.cancelHandlers.indexOf(h);
      if (i >= 0) this.cancelHandlers.splice(i, 1);
    };
  }

  hasOwner(): boolean { return this.owner !== null; }

  /* ── Internals ─────────────────────────────────────────────────── */
  private mods(e: MouseEvent | WheelEvent | PointerEvent): Mods {
    return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
  }

  private dispatch(g: Gesture): GestureHandler | null {
    for (const s of this.subs) {
      try {
        if (s.fn(g)) return s.fn;
      } catch (err) {
        console.error("[input-router] handler threw", err);
      }
    }
    return null;
  }

  private releaseOwner(): void {
    this.owner = null;
    if (this.releaseCamera) {
      try { this.releaseCamera(); } catch { /* */ }
      this.releaseCamera = null;
    }
  }

  private scheduleHover(e: PointerEvent): void {
    this.lastHoverEvent = e;
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      const ev = this.lastHoverEvent;
      if (!ev) return;
      for (const h of this.hoverHandlers) {
        try { h(ev); } catch (err) { console.error("[input-router] hover threw", err); }
      }
    });
  }

  /* ── Pointer events ────────────────────────────────────────────── */
  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    if (isUiEventTarget(e.target)) return;
    if (this.down && this.down.id !== e.pointerId) return;
    this.down = {
      x: e.clientX, y: e.clientY,
      button: e.button as PointerButton,
      mods: this.mods(e),
      moved: false,
      id: e.pointerId,
    };
    this.owner = null;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.down) { this.scheduleHover(e); return; }
    if (this.down.id !== e.pointerId) return;

    const dx = e.clientX - this.down.x;
    const dy = e.clientY - this.down.y;
    const dist = Math.hypot(dx, dy);

    if (!this.down.moved && dist >= DRAG_THRESHOLD) {
      this.down.moved = true;
      const owner = this.dispatch({
        kind: "drag-start",
        button: this.down.button,
        mods: this.mods(e),
        event: e,
      });
      if (owner) {
        this.owner = owner;
        this.releaseCamera = pauseCameraControls();
        e.preventDefault();
        e.stopPropagation();
      }
    }

    if (this.owner) {
      try {
        this.owner({
          kind: "drag-move",
          button: this.down.button,
          mods: this.mods(e),
          dx, dy,
          event: e,
        });
      } catch (err) {
        console.error("[input-router] owner drag-move threw", err);
      }
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.down || this.down.id !== e.pointerId) return;
    const d = this.down;
    this.down = null;

    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const moved = d.moved || Math.hypot(dx, dy) >= DRAG_THRESHOLD;

    if (this.owner) {
      try {
        this.owner({
          kind: "drag-end",
          button: d.button,
          mods: this.mods(e),
          dx, dy,
          moved: true,
          event: e,
        });
      } catch (err) {
        console.error("[input-router] owner drag-end threw", err);
      }
      e.preventDefault();
      e.stopPropagation();
      this.releaseOwner();
      return;
    }

    if (moved) {
      // Drag completed but nothing claimed it — reset double-click timing.
      this.lastClick = null;
      return;
    }

    if (d.button === 2) {
      if (this.dispatch({ kind: "rmb-click", mods: this.mods(e), event: e })) {
        e.preventDefault();
        e.stopPropagation();
      }
      this.lastClick = null;
      return;
    }

    const now = performance.now();
    const isDbl = !!this.lastClick
      && now - this.lastClick.t < DBLCLICK_MS
      && Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < DBLCLICK_PX
      && this.lastClick.button === d.button;

    const g: Gesture = isDbl
      ? { kind: "dblclick", button: d.button, mods: this.mods(e), event: e }
      : { kind: "click", button: d.button, mods: this.mods(e), event: e };

    if (this.dispatch(g)) {
      e.preventDefault();
      e.stopPropagation();
    }
    this.lastClick = { t: now, x: e.clientX, y: e.clientY, button: d.button };
  };

  private onWheel = (e: WheelEvent): void => {
    if (isUiEventTarget(e.target)) return;
    if (this.dispatch({ kind: "wheel", event: e, mods: this.mods(e) })) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    // The application owns the menu. Never let the browser default leak
    // through over the viewport.
    e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    for (let i = this.cancelHandlers.length - 1; i >= 0; i--) {
      try {
        if (this.cancelHandlers[i]()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // Always clear a stuck camera pause after cancel.
          forceResumeCameraControls();
          this.releaseOwner();
          return;
        }
      } catch (err) {
        console.error("[input-router] cancel handler threw", err);
      }
    }
    // Escape with no cancel handler: still unstick camera if a drag left it paused.
    forceResumeCameraControls();
    this.releaseOwner();
  };
}

export const inputRouter = new InputRouterImpl();

export function setupInputRouter(): () => void {
  if (!ctx.rightHost) {
    console.warn("[input-router] rightHost not ready");
    return () => {};
  }
  inputRouter.attach(ctx.rightHost);
  (ctx.features as any).inputRouter = inputRouter;
  console.log("[input-router] attached");
  return () => inputRouter.detach();
}
