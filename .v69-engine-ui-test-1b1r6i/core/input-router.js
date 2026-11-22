"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inputRouter = void 0;
exports.setupInputRouter = setupInputRouter;
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
const context_1 = require("./context");
const camera_gate_1 = require("./camera-gate");
/** True when the event originated on a floating panel / form control — not the canvas. */
function isUiEventTarget(t) {
    const el = t;
    if (!el || !el.closest)
        return false;
    if (el.closest("input,textarea,select,button,label,a," +
        "[contenteditable=true],[data-obs-window-controls]"))
        return true;
    // Any dockable / floating panel shell
    if (el.closest('#obs-ai-chat,#obs-bim-toolbox,[id^="obs-"],[data-obs-panel],.obs-panel,.obs-toast-host')) {
        // Still allow canvas-like surfaces inside panels (e.g. plan view)
        if (el.closest("canvas"))
            return false;
        return true;
    }
    return false;
}
const DRAG_THRESHOLD = 4;
const DBLCLICK_MS = 320;
const DBLCLICK_PX = 6;
class InputRouterImpl {
    host = null;
    subs = [];
    hoverHandlers = [];
    cancelHandlers = [];
    orderCounter = 0;
    down = null;
    owner = null;
    releaseCamera = null;
    lastClick = null;
    hoverPending = false;
    lastHoverEvent = null;
    /* ── Lifecycle ─────────────────────────────────────────────────── */
    attach(host) {
        if (this.host === host)
            return;
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
    detach() {
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
    subscribe(h, priority = 0) {
        const sub = { fn: h, priority, order: this.orderCounter++ };
        this.subs.push(sub);
        this.subs.sort((a, b) => b.priority - a.priority || a.order - b.order);
        return () => {
            const i = this.subs.indexOf(sub);
            if (i >= 0)
                this.subs.splice(i, 1);
        };
    }
    subscribeHover(h) {
        this.hoverHandlers.push(h);
        return () => {
            const i = this.hoverHandlers.indexOf(h);
            if (i >= 0)
                this.hoverHandlers.splice(i, 1);
        };
    }
    registerCancel(h) {
        this.cancelHandlers.push(h);
        return () => {
            const i = this.cancelHandlers.indexOf(h);
            if (i >= 0)
                this.cancelHandlers.splice(i, 1);
        };
    }
    /** escape-all support: run EVERY cancel handler (unlike the Escape path,
     *  which stops at the first handler that returns true) and report how many
     *  actually canceled something. */
    cancelAll() {
        let n = 0;
        for (let i = this.cancelHandlers.length - 1; i >= 0; i--) {
            try {
                if (this.cancelHandlers[i]())
                    n++;
            }
            catch (err) {
                console.error("[input-router] cancel handler threw", err);
            }
        }
        return n;
    }
    /** Drop any claimed gesture and release the camera pause (escape-all uses
     *  this after a cancel sweep so a stuck drag can never survive ESC). */
    releaseGesture() {
        this.releaseOwner();
    }
    hasOwner() { return this.owner !== null; }
    /* ── Internals ─────────────────────────────────────────────────── */
    mods(e) {
        return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    }
    dispatch(g) {
        for (const s of this.subs) {
            try {
                if (s.fn(g))
                    return s.fn;
            }
            catch (err) {
                console.error("[input-router] handler threw", err);
            }
        }
        return null;
    }
    releaseOwner() {
        this.owner = null;
        if (this.releaseCamera) {
            try {
                this.releaseCamera();
            }
            catch { /* */ }
            this.releaseCamera = null;
        }
    }
    scheduleHover(e) {
        this.lastHoverEvent = e;
        if (this.hoverPending)
            return;
        this.hoverPending = true;
        requestAnimationFrame(() => {
            this.hoverPending = false;
            const ev = this.lastHoverEvent;
            if (!ev)
                return;
            for (const h of this.hoverHandlers) {
                try {
                    h(ev);
                }
                catch (err) {
                    console.error("[input-router] hover threw", err);
                }
            }
        });
    }
    /* ── Pointer events ────────────────────────────────────────────── */
    onDown = (e) => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2)
            return;
        if (isUiEventTarget(e.target))
            return;
        // A second finger of a multi-touch gesture is ignored, but a new primary
        // press always replaces a stale gesture whose pointerup was never seen
        // (e.g. released outside the window) so input can never get stuck.
        if (this.down && this.down.id !== e.pointerId && !e.isPrimary)
            return;
        // Release any camera pause left behind by a gesture that never ended.
        if (this.owner || this.releaseCamera)
            this.releaseOwner();
        this.down = {
            x: e.clientX, y: e.clientY,
            button: e.button,
            mods: this.mods(e),
            moved: false,
            id: e.pointerId,
        };
        this.owner = null;
    };
    onMove = (e) => {
        if (!this.down) {
            this.scheduleHover(e);
            return;
        }
        if (this.down.id !== e.pointerId)
            return;
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
                this.releaseCamera = (0, camera_gate_1.pauseCameraControls)();
                // Keep receiving move/up even if the cursor leaves the viewport.
                try {
                    this.host?.setPointerCapture(e.pointerId);
                }
                catch { /* */ }
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
            }
            catch (err) {
                console.error("[input-router] owner drag-move threw", err);
            }
            e.preventDefault();
            e.stopPropagation();
        }
    };
    onUp = (e) => {
        if (!this.down || this.down.id !== e.pointerId)
            return;
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
            }
            catch (err) {
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
        const g = isDbl
            ? { kind: "dblclick", button: d.button, mods: this.mods(e), event: e }
            : { kind: "click", button: d.button, mods: this.mods(e), event: e };
        if (this.dispatch(g)) {
            e.preventDefault();
            e.stopPropagation();
        }
        this.lastClick = { t: now, x: e.clientX, y: e.clientY, button: d.button };
    };
    onWheel = (e) => {
        if (isUiEventTarget(e.target))
            return;
        if (this.dispatch({ kind: "wheel", event: e, mods: this.mods(e) })) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    onContextMenu = (e) => {
        // The application owns the menu. Never let the browser default leak
        // through over the viewport.
        e.preventDefault();
    };
    onKeyDown = (e) => {
        if (e.key !== "Escape")
            return;
        // Keystrokes aimed at editable UI (text inputs, textareas, …) belong to
        // that field — e.g. Esc must cancel an open temporary-dimension editor,
        // not trigger tool cancellation and swallow the key (stopImmediatePropagation).
        if (isUiEventTarget(e.target))
            return;
        for (let i = this.cancelHandlers.length - 1; i >= 0; i--) {
            try {
                if (this.cancelHandlers[i]()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    // Always clear a stuck camera pause after cancel.
                    (0, camera_gate_1.forceResumeCameraControls)();
                    this.releaseOwner();
                    return;
                }
            }
            catch (err) {
                console.error("[input-router] cancel handler threw", err);
            }
        }
        // Escape with no cancel handler: still unstick camera if a drag left it paused.
        (0, camera_gate_1.forceResumeCameraControls)();
        this.releaseOwner();
    };
}
exports.inputRouter = new InputRouterImpl();
function setupInputRouter() {
    if (!context_1.ctx.rightHost) {
        console.warn("[input-router] rightHost not ready");
        return () => { };
    }
    exports.inputRouter.attach(context_1.ctx.rightHost);
    context_1.ctx.features.inputRouter = exports.inputRouter;
    console.log("[input-router] attached");
    return () => exports.inputRouter.detach();
}
