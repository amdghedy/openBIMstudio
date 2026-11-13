/**
 * Dockable tool windows – former left "Tools" panel groups, opened from ribbon tabs.
 * Every window uses the shared makeDockable controller so it can be docked to
 * any side (left / right / top / bottom) or floated, with snap, resize, and
 * localStorage persistence.
 */
import { buildToolSection, TOOL_SECTIONS, type ToolWindowId } from "./panel";
import { makeDockable, type DockHandle, type DockSide } from "./dockable";
import { ctx } from "../core/context";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsToolWindows: any;

interface WinEntry {
  el: HTMLDivElement;
  dock: DockHandle;
  head: HTMLDivElement;
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

function btnCss(active = false): string {
  return (
    "background:" + (active ? "rgba(56,189,248,.18)" : "transparent") +
    ";border:1px solid " + (active ? "rgba(56,189,248,.45)" : "transparent") +
    ";color:#c8cdd8;font-size:11px;cursor:pointer;line-height:1;" +
    "padding:3px 5px;border-radius:4px;min-width:22px"
  );
}

function buildDockBar(dock: DockHandle, onChange: () => void): HTMLDivElement {
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:3px;margin-left:auto;margin-right:6px";
  const sides: Array<{ side: DockSide; label: string; title: string }> = [
    { side: "left", label: "Left", title: "Dock left" },
    { side: "right", label: "Right", title: "Dock right" },
    { side: "top", label: "Top", title: "Dock top" },
    { side: "bottom", label: "Bottom", title: "Dock bottom" },
    { side: "float", label: "Float", title: "Float window" },
  ];
  for (const s of sides) {
    const active = dock.side() === s.side;
    const b = document.createElement("button");
    b.textContent = s.label;
    b.title = s.title;
    b.style.cssText =
      "padding:3px 7px;font-size:10px;border-radius:4px;cursor:pointer;" +
      "border:1px solid " + (active ? "rgba(56,189,248,.55)" : "#2a2e3a") + ";" +
      "background:" + (active ? "rgba(56,189,248,.16)" : "transparent") + ";" +
      "color:" + (active ? "#38bdf8" : "#a0a6b5");
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = (e) => {
      e.stopPropagation();
      try {
        dock.dock(s.side);
      } catch (err) {
        console.warn("[tool-windows] dock failed", err);
      }
      onChange();
    };
    bar.appendChild(b);
  }
  return bar;
}

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
    existing.head.style.display = "flex";
    return;
  }

  const sec = TOOL_SECTIONS[id];
  if (!sec) return;

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
    "min-height:0;overflow:hidden;box-sizing:border-box";

  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;gap:6px;" +
    "padding:8px 10px;background:#161a22;border-bottom:1px solid #2a2e3a;" +
    "border-radius:8px 8px 0 0;cursor:grab;user-select:none;touch-action:none;" +
    "flex-shrink:0;min-height:40px;box-sizing:border-box;" +
    "position:sticky;top:0;z-index:5";

  const title = document.createElement("b");
  title.textContent = sec.title;
  title.style.cssText = "font-size:13px;font-weight:600;letter-spacing:.01em;flex:1;min-width:0;" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Close";
  close.style.cssText = btnCss();
  close.onpointerdown = (e) => e.stopPropagation();
  close.onclick = () => closeToolWindow(id);

  const body = document.createElement("div");
  body.style.cssText =
    "overflow:auto;min-height:0;flex:1;background:#0f1117;border-radius:0 0 8px 8px;";
  body.appendChild(buildToolSection(id));

  body.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  body.addEventListener("keydown", (e) => e.stopPropagation());
  win.addEventListener("pointerdown", () => {
    win.style.zIndex = String(++zTop);
  }, true);

  head.append(title, close);
  win.append(head, body);
  host.appendChild(win);

  let dock: DockHandle;
  try {
    dock = makeDockable(win, {
      id: `tool-${id}`,
      host,
      header: head,
      minWidth: 280,
      minHeight: 220,
      defaultDock: "float",
      defaultWidth: DEFAULT_WIDTH[id] ?? 380,
      defaultHeight: DEFAULT_HEIGHT[id] ?? 480,
      margin: 8,
      snapThreshold: 36,
      windowControls: false,
    });
  } catch (err) {
    console.error("[tool-windows] makeDockable failed", id, err);
    win.remove();
    return;
  }

  const refreshHead = () => {
    const old = head.querySelector("[data-dock-bar]");
    if (old) old.remove();
    const bar = buildDockBar(dock, refreshHead);
    bar.dataset.dockBar = "1";
    head.insertBefore(bar, close);
  };
  refreshHead();

  open.set(id, { el: win, dock, head });
  dock.show();
  head.style.display = "flex";

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
  obsToolWindows = {
    open: openToolWindow,
    close: closeToolWindow,
    toggle: toggleToolWindow,
    isOpen: isToolWindowOpen,
  };
}
