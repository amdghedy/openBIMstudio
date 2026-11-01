/**
 * Dockable tool windows – former left "Tools" panel groups, opened from ribbon tabs.
 * Every window uses the shared makeDockable controller so it can be docked to
 * any side (left / right / top / bottom) or floated, with snap, resize, and
 * localStorage persistence.
 */
import { buildToolSection, TOOL_SECTIONS, type ToolWindowId } from "./panel";
import { makeDockable, type DockHandle } from "./dockable";
import { ctx } from "../core/context";

interface WinEntry {
  el: HTMLDivElement;
  dock: DockHandle;
}

const open = new Map<ToolWindowId, WinEntry>();
let zTop = 9400;

const DEFAULT_WIDTH: Partial<Record<ToolWindowId, number>> = {
  clash: 440,
  import: 400,
  properties: 420,
  models: 360,
  modeling: 380,
  view: 360,
  crop: 340,
  measure: 340,
  scene: 360,
  controls: 360,
};

const DEFAULT_HEIGHT: Partial<Record<ToolWindowId, number>> = {
  clash: 620,
  import: 520,
  properties: 560,
  modeling: 480,
};

export function isToolWindowOpen(id: ToolWindowId): boolean {
  return open.has(id);
}

export function closeToolWindow(id: ToolWindowId): void {
  const entry = open.get(id);
  if (!entry) return;
  try {
    entry.dock.hide();
  } catch {
    /* */
  }
  entry.el.remove();
  open.delete(id);
  try {
    window.dispatchEvent(new CustomEvent("obs-tool-window", { detail: { id, open: false } }));
  } catch {
    /* */
  }
}

export function openToolWindow(id: ToolWindowId): void {
  const existing = open.get(id);
  if (existing) {
    existing.el.style.zIndex = String(++zTop);
    existing.dock.show();
    return;
  }

  const sec = TOOL_SECTIONS[id];
  if (!sec) return;

  // Host must be the viewport (same as AI panel) so docking coordinates are correct.
  const host = ctx.rightHost;
  if (!host) {
    console.error("[tool-windows] ctx.rightHost is not ready");
    return;
  }

  const win = document.createElement("div");
  win.dataset.toolWindow = id;
  win.style.cssText =
    "display:none;flex-direction:column;z-index:" + (++zTop) + ";" +
    "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;color:#e8eaf0;" +
    "font:13px system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5);" +
    "min-height:0;overflow:hidden;";

  // Header = drag handle + dock menu target
  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;" +
    "padding:8px 12px;background:#161a22;border-bottom:1px solid #2a2e3a;" +
    "border-radius:8px 8px 0 0;cursor:grab;user-select:none;touch-action:none;" +
    "flex-shrink:0;min-height:36px";

  const title = document.createElement("b");
  title.textContent = sec.title;
  title.style.cssText = "font-size:13px;font-weight:600;letter-spacing:.01em";

  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Close";
  close.style.cssText =
    "background:transparent;border:none;color:#8b949e;font-size:16px;" +
    "cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px";
  close.onpointerdown = (e) => e.stopPropagation();
  close.onclick = () => closeToolWindow(id);
  head.append(title, close);

  const body = document.createElement("div");
  body.style.cssText =
    "overflow:auto;min-height:0;flex:1;background:#0f1117;border-radius:0 0 8px 8px;";
  body.appendChild(buildToolSection(id));

  // Keep wheel / keys inside the window
  body.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  body.addEventListener("keydown", (e) => e.stopPropagation());
  win.addEventListener("pointerdown", () => {
    win.style.zIndex = String(++zTop);
  }, true);

  win.append(head, body);
  host.appendChild(win);

  const dock = makeDockable(win, {
    id: `tool-${id}`,
    host,
    header: head,
    minWidth: 280,
    minHeight: 220,
    defaultDock: "float",          // start floating; user can dock to any side
    defaultWidth: DEFAULT_WIDTH[id] ?? 380,
    defaultHeight: DEFAULT_HEIGHT[id] ?? 480,
    margin: 8,
    snapThreshold: 36,
    windowControls: false,         // we already have our own close button
  });

  open.set(id, { el: win, dock });
  dock.show();

  try {
    window.dispatchEvent(new CustomEvent("obs-tool-window", { detail: { id, open: true } }));
  } catch {
    /* */
  }
}

export function toggleToolWindow(id: ToolWindowId): void {
  if (open.has(id)) closeToolWindow(id);
  else openToolWindow(id);
}

export function setupToolWindows(): void {
  (window as any).__obsToolWindows = {
    open: openToolWindow,
    close: closeToolWindow,
    toggle: toggleToolWindow,
    isOpen: isToolWindowOpen,
  };
}
