/**
 * Dockable panel controller.
 *
 * Wraps an absolutely-positioned element with:
 *   • Drag by header (or by whole element if no header given)
 *   • Resize from any of 8 edges/corners
 *   • Dock to left / right / floating — snap when dragged near an edge
 *   • Persists size + position + dock state in localStorage per panel ID
 *
 * Usage:
 *   const dock = makeDockable(panelEl, {
 *     id: "property-palette",
 *     host: ctx.rightHost,
 *     header: panelHeaderEl,
 *     minWidth: 220, minHeight: 200,
 *     defaultDock: "right",
 *   });
 *   dock.toggle(); dock.dock("left"); dock.reset();
 */
import { ctx } from "../core/context";

export type DockSide = "left" | "right" | "float";

export interface DockOptions {
  id: string;
  host?: HTMLElement;
  /** Optional drag handle. When omitted, the whole panel drags. */
  header?: HTMLElement;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  defaultDock?: DockSide;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Gap from the host's edges when docked. */
  margin?: number;
  /** Distance from an edge at which a floating drag snaps to dock. */
  snapThreshold?: number;
  /**
   * Extra min/dock/close chrome injected into the header.
   * Default false — most panels already ship their own close/clear buttons;
   * enabling this stacks a second control row and fights header re-renders.
   */
  windowControls?: boolean | "close";
  /**
   * When true (default), only the header is a drag handle.
   * Whole-panel drag is only used when no header is provided.
   */
  headerDragOnly?: boolean;
}

interface PersistedState {
  dock: DockSide;
  width: number;
  height: number;
  /** Position relative to host (top-left). Only meaningful for "float". */
  x: number;
  y: number;
}

const STORAGE_PREFIX = "obs.dock.";

const RESIZE_CURSOR: Record<string, string> = {
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  nw: "nwse-resize", se: "nwse-resize",
};

export interface DockHandle {
  /** Return the current dock side. */
  side(): DockSide;
  /** Programmatically change dock side. */
  dock(side: DockSide): void;
  /** Show / hide the panel. Does not change dock state. */
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
  /** Reset size + position to defaults and reapply stored dock side. */
  reset(): void;
  /** Cycle docked → floating → right, similar to BIM-style panel management. */
  cycleDock(): void;
  /** Collapse content while keeping the window header/controls visible. */
  minimize(): void;
  /** Update the header used for dragging (e.g. if you rebuild it). */
  setHeader(el: HTMLElement | null): void;
  /** Detach — removes listeners and resize handles. */
  dispose(): void;
}

export function makeDockable(panel: HTMLElement, opts: DockOptions): DockHandle {
  // Bubble-phase only: let target handlers run, then stop the event
  // from reaching legacy host listeners. Capture-phase filtering is
  // handled by input-router (isUiEventTarget).
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.addEventListener("mousedown", (e) => e.stopPropagation());
  panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const id = opts.id;
  const host = opts.host ?? ctx.rightHost;
  const margin = opts.margin ?? 8;
  const snapThreshold = opts.snapThreshold ?? 24;
  const minW = opts.minWidth ?? 200;
  const minH = opts.minHeight ?? 150;

  // If the host isn't positioned, panels will land in the wrong place.
  const hostPosition = getComputedStyle(host).position;
  if (hostPosition === "static") host.style.position = "relative";

  // ── Persisted state ──
  const key = STORAGE_PREFIX + id;
  let state: PersistedState = loadState();
  let minimized = false;
  let restoreHeight = state.height;
  let controlsHost: HTMLElement | null = null;
  let controlsObserver: MutationObserver | null = null;
  let updatingControls = false;

  function loadState(): PersistedState {
    const fallback: PersistedState = {
      dock: opts.defaultDock ?? "right",
      width: opts.defaultWidth ?? 300,
      height: opts.defaultHeight ?? 400,
      x: margin,
      y: margin,
    };
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        dock: parsed.dock ?? fallback.dock,
        width: clamp(Number(parsed.width) || fallback.width, minW, opts.maxWidth ?? 1200),
        height: clamp(Number(parsed.height) || fallback.height, minH, opts.maxHeight ?? 2000),
        x: Number(parsed.x) || fallback.x,
        y: Number(parsed.y) || fallback.y,
      };
    } catch {
      return fallback;
    }
  }

  function saveState(): void {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* */
    }
  }

  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  // ── Apply state to the DOM ──
  function applyLayout(): void {
    const hostRect = host.getBoundingClientRect();
    panel.style.position = "absolute";
    panel.style.boxSizing = "border-box";

    if (state.dock === "left") {
      panel.style.left = `${margin}px`;
      panel.style.right = "auto";
      panel.style.top = `${margin}px`;
      panel.style.width = `${Math.min(state.width, hostRect.width - margin * 2)}px`;
      panel.style.height = `${Math.min(state.height, hostRect.height - margin * 2)}px`;
    } else if (state.dock === "right") {
      panel.style.right = `${margin}px`;
      panel.style.left = "auto";
      panel.style.top = `${margin}px`;
      panel.style.width = `${Math.min(state.width, hostRect.width - margin * 2)}px`;
      panel.style.height = `${Math.min(state.height, hostRect.height - margin * 2)}px`;
    } else {
      // float — position is set by drag
      panel.style.left = `${state.x}px`;
      panel.style.right = "auto";
      panel.style.top = `${state.y}px`;
      panel.style.width = `${state.width}px`;
      panel.style.height = `${state.height}px`;
    }
  }

  // ── Resize handles ──
  const HANDLES: Array<"n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"> =
    ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  
const handleEls: HTMLDivElement[] = [];
  const SIZE = 6;
  for (const h of HANDLES) {
    const el = document.createElement("div");
    el.dataset.resizeHandle = h;
    el.style.cssText =
      `position:absolute;z-index:4;` +
      (h.includes("n") ? `top:0;height:${SIZE}px;` : "") +
      (h.includes("s") ? `bottom:0;height:${SIZE}px;` : "") +
      (h.includes("e") ? `right:0;width:${SIZE}px;` : "") +
      (h.includes("w") ? `left:0;width:${SIZE}px;` : "") +
      (h === "n" || h === "s" ? "left:6px;right:6px;" : "") +
      (h === "e" || h === "w" ? "top:6px;bottom:6px;" : "") +
      `cursor:${RESIZE_CURSOR[h]};` +
      (h.includes("n") && h.includes("w") ? "top:0;left:0;width:12px;height:12px;" : "") +
      (h.includes("n") && h.includes("e") ? "top:0;right:0;width:12px;height:12px;" : "") +
      (h.includes("s") && h.includes("w") ? "bottom:0;left:0;width:12px;height:12px;" : "") +
      (h.includes("s") && h.includes("e") ? "bottom:0;right:0;width:12px;height:12px;" : "");
    el.addEventListener("pointerdown", (e) => startResize(e, h));
    panel.appendChild(el);
    handleEls.push(el);
  }

  let resize: {
    dir: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startL: number;
    startT: number;
    pointerId: number;
  } | null = null;

  function startResize(e: PointerEvent, dir: string): void {
    e.stopPropagation();
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    resize = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
      startL: rect.left - hostRect.left,
      startT: rect.top - hostRect.top,
      pointerId: e.pointerId,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
    document.body.style.cursor = RESIZE_CURSOR[dir];
  }

  function onResizeMove(e: PointerEvent): void {
    if (!resize) return;
    const dx = e.clientX - resize.startX;
    const dy = e.clientY - resize.startY;
    let w = resize.startW;
    let h = resize.startH;
    let l = resize.startL;
    let t = resize.startT;

    if (resize.dir.includes("e")) w = resize.startW + dx;
    if (resize.dir.includes("s")) h = resize.startH + dy;
    if (resize.dir.includes("w")) {
      w = resize.startW - dx;
      l = resize.startL + dx;
    }
    if (resize.dir.includes("n")) {
      h = resize.startH - dy;
      t = resize.startT + dy;
    }
    w = clamp(w, minW, opts.maxWidth ?? 2000);
    h = clamp(h, minH, opts.maxHeight ?? 2000);

    state.width = w;
    state.height = h;
    if (state.dock === "float") {
      state.x = l;
      state.y = t;
    }
    applyLayout();
  }

  function onResizeUp(): void {
    if (!resize) return;
    resize = null;
    document.body.style.cursor = "";
    saveState();
  }

  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeUp);

  // ── Drag ──
  let drag: {
    startX: number;
    startY: number;
    startL: number;
    startT: number;
    pointerId: number;
    moved: boolean;
  } | null = null;

  function onDragDown(e: PointerEvent): void {
    // Only primary button; ignore resize handles and interactive content.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target) return;
    if (target.dataset?.resizeHandle) return;
    if (target.closest(
      "input,select,button,textarea,label,a,option," +
      "[contenteditable=true],[data-no-drag],.obs-no-drag," +
      "[data-obs-window-controls],pre,code",
    )) return;

    // If dragging from header, require the event to originate in the header
    // (not a nested scrollable body that somehow bubbled).
    if (opts.header && !opts.header.contains(target)) return;

    const rect = panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      startL: rect.left - hostRect.left,
      startT: rect.top - hostRect.top,
      pointerId: e.pointerId,
      moved: false,
    };
    // Do NOT capture until the pointer actually moves — otherwise a click
    // or text-selection gesture on the header is stolen.
  }

  function onDragMove(e: PointerEvent): void {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      try {
        const handle = opts.header ?? panel;
        handle.setPointerCapture(drag.pointerId);
      } catch { /* */ }
    }

    // Escape a docked state into float on first drag.
    if (state.dock !== "float") {
      const rect = panel.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      state.dock = "float";
      state.x = rect.left - hostRect.left;
      state.y = rect.top - hostRect.top;
      drag.startL = state.x;
      drag.startT = state.y;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      panel.style.right = "auto";
    }

    state.x = drag.startL + dx;
    state.y = drag.startT + dy;

    // Clamp inside host.
    const hostRect = host.getBoundingClientRect();
    state.x = Math.max(0, Math.min(hostRect.width - state.width, state.x));
    state.y = Math.max(0, Math.min(hostRect.height - 40, state.y));

    applyLayout();
  }

  function onDragUp(e: PointerEvent): void {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;

    // Snap to left / right if within threshold.
    const hostRect = host.getBoundingClientRect();
    const rightEdge = state.x + state.width;
    if (state.x < snapThreshold) {
      state.dock = "left";
    } else if (rightEdge > hostRect.width - snapThreshold) {
      state.dock = "right";
    }
    applyLayout();
    saveState();
  }

  function makeControl(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title;
    b.style.cssText =
      "width:24px;height:22px;padding:0;margin-left:2px;border:1px solid rgba(148,163,184,.25);" +
      "border-radius:4px;background:rgba(15,23,42,.35);color:#cbd5e1;cursor:pointer;font:12px system-ui";
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    b.onmouseenter = () => { b.style.background = "rgba(56,189,248,.14)"; };
    b.onmouseleave = () => { b.style.background = "rgba(15,23,42,.35)"; };
    return b;
  }

  function applyMinimizedLayout(): void {
    if (!minimized) {
      panel.style.height = `${state.height}px`;
      for (const child of Array.from(panel.children)) {
        const el = child as HTMLElement;
        if (el === controlsHost || el === opts.header || el.dataset.resizeHandle) continue;
        el.style.display = el.dataset.obsPrevDisplay ?? "";
      }
      if (opts.header) opts.header.style.display = opts.header.dataset.obsPrevDisplay ?? "";
      return;
    }
    panel.style.height = `${Math.max(34, Math.min(46, restoreHeight))}px`;
    for (const child of Array.from(panel.children)) {
      const el = child as HTMLElement;
      if (el === controlsHost || el === opts.header || el.dataset.resizeHandle) continue;
      if (el.dataset.obsPrevDisplay == null) el.dataset.obsPrevDisplay = el.style.display;
      el.style.display = "none";
    }
  }

  function ensureWindowControls(): void {
    const header = opts.header;
    if (!header || updatingControls) return;

    // Default: no injected chrome. Panels own their header buttons.
    const mode = opts.windowControls ?? false;
    if (!mode) {
      if (controlsHost) {
        controlsHost.remove();
        controlsHost = null;
      }
      return;
    }

    updatingControls = true;
    try {
      if (!controlsHost || controlsHost.parentElement !== header) {
        controlsHost = document.createElement("div");
        controlsHost.style.cssText =
          "display:flex;align-items:center;gap:2px;flex:none;margin-left:auto";
        controlsHost.dataset.obsWindowControls = "1";
        header.appendChild(controlsHost);
      }
      controlsHost.innerHTML = "";
      if (mode === true) {
        const minBtn = makeControl(minimized ? "□" : "—", minimized ? "Restore" : "Minimize", () => {
          if (!minimized) restoreHeight = state.height;
          minimized = !minimized;
          if (!minimized) state.height = Math.max(minH, restoreHeight);
          applyMinimizedLayout(); saveState(); ensureWindowControls();
        });
        const dockBtn = makeControl(
          state.dock === "float" ? "⇲" : "⇱",
          state.dock === "float" ? "Dock right" : "Float window",
          () => { dock(state.dock === "float" ? "right" : "float"); },
        );
        controlsHost.append(minBtn, dockBtn);
      }
      const closeBtn = makeControl("×", "Close", () => hide());
      controlsHost.append(closeBtn);
    } finally {
      updatingControls = false;
    }
  }

  function cycleDock(): void {
    dock(state.dock === "right" ? "float" : state.dock === "float" ? "left" : "right");
  }

  function minimize(): void {
    if (!minimized) restoreHeight = state.height;
    minimized = !minimized;
    if (!minimized) state.height = Math.max(minH, restoreHeight);
    applyMinimizedLayout(); ensureWindowControls(); saveState();
  }

  // Header-based drag if provided; otherwise whole-panel drag.
  const dragTarget = opts.header ?? panel;
  dragTarget.addEventListener("pointerdown", onDragDown);
  dragTarget.addEventListener("pointermove", onDragMove);
  dragTarget.addEventListener("pointerup", onDragUp);

  // Header cursor hint
  if (opts.header) opts.header.style.cursor = "grab";

  // ── Public handle ──
  let visible = panel.style.display !== "none";

  function show(): void {
    visible = true;
    panel.style.display = "flex";
    applyLayout();
    applyMinimizedLayout();
    ensureWindowControls();
  }
  function hide(): void {
    visible = false;
    panel.style.display = "none";
  }
  function toggle(): void {
    visible ? hide() : show();
  }
  function isVisible(): boolean {
    return visible && panel.style.display !== "none";
  }
  function dock(side: DockSide): void {
    state.dock = side;
    if (side === "float" && state.x === 0 && state.y === 0) { state.x = margin + 24; state.y = margin + 24; }
    applyLayout();
    applyMinimizedLayout();
    ensureWindowControls();
    saveState();
    show();
  }
  function reset(): void {
    minimized = false;
    state.width = opts.defaultWidth ?? 300;
    state.height = opts.defaultHeight ?? 400;
    restoreHeight = state.height;
    state.x = margin;
    state.y = margin;
    applyLayout();
    applyMinimizedLayout();
    ensureWindowControls();
    saveState();
  }
  function setHeader(el: HTMLElement | null): void {
    if (opts.header === el) { ensureWindowControls(); return; }
    if (controlsObserver) { controlsObserver.disconnect(); controlsObserver = null; }
    if (opts.header) {
      opts.header.removeEventListener("pointerdown", onDragDown);
      opts.header.removeEventListener("pointermove", onDragMove);
      opts.header.removeEventListener("pointerup", onDragUp);
      opts.header.style.cursor = "";
    }
    opts.header = el ?? undefined;
    const target = opts.header ?? panel;
    target.addEventListener("pointerdown", onDragDown);
    target.addEventListener("pointermove", onDragMove);
    target.addEventListener("pointerup", onDragUp);
    if (opts.header) {
      opts.header.style.cursor = "grab";
      ensureWindowControls();
      if (opts.windowControls ?? false) {
        controlsObserver = new MutationObserver(() => { if (!updatingControls) ensureWindowControls(); });
        controlsObserver.observe(opts.header, { childList: true, subtree: false });
      }
    }
  }
  function dispose(): void {
    if (controlsObserver) { controlsObserver.disconnect(); controlsObserver = null; }
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    for (const h of handleEls) h.remove();
    const target = opts.header ?? panel;
    target.removeEventListener("pointerdown", onDragDown);
    target.removeEventListener("pointermove", onDragMove);
    target.removeEventListener("pointerup", onDragUp);
  }

  // Initial layout. Window chrome is opt-in (windowControls).
  if (visible) { applyLayout(); ensureWindowControls(); applyMinimizedLayout(); }
  else panel.style.display = "none";
  if (opts.header && (opts.windowControls ?? false)) {
    controlsObserver = new MutationObserver(() => { if (!updatingControls) ensureWindowControls(); });
    controlsObserver.observe(opts.header, { childList: true, subtree: false });
  }

  return { side: () => state.dock, dock, cycleDock, minimize, show, hide, toggle, isVisible, reset, setHeader, dispose };
}