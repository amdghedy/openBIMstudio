/** Floating tool windows - the former left "Tools" panel groups, opened from their ribbon tab.
 *  Non-blocking (the viewport stays usable), draggable by the title bar, one instance per id. */
import { buildToolSection, TOOL_SECTIONS, type ToolWindowId } from "./panel";

const open = new Map<ToolWindowId, HTMLDivElement>();
const lastPos = new Map<ToolWindowId, { left: number; top: number }>();
let zTop = 9400;
const OFFSET: Record<ToolWindowId, number> = { import: 0, models: 1, properties: 2, view: 3, modeling: 4, clash: 5, crop: 6, measure: 7, scene: 8, controls: 9 };
const WIDTH: Partial<Record<ToolWindowId, number>> = { clash: 440, import: 400, properties: 420, models: 360 };

export function isToolWindowOpen(id: ToolWindowId): boolean { return open.has(id); }

export function closeToolWindow(id: ToolWindowId): void {
  const w = open.get(id);
  if (!w) return;
  const r = w.getBoundingClientRect();
  lastPos.set(id, { left: r.left, top: r.top });
  w.remove();
  open.delete(id);
  try { window.dispatchEvent(new CustomEvent("obs-tool-window", { detail: { id, open: false } })); } catch { /* */ }
}

export function openToolWindow(id: ToolWindowId): void {
  const existing = open.get(id);
  if (existing) { existing.style.zIndex = String(++zTop); return; }
  const sec = TOOL_SECTIONS[id];
  if (!sec) return;

  const win = document.createElement("div");
  win.dataset.toolWindow = id;
  const pos = lastPos.get(id) ?? { left: Math.max(12, window.innerWidth - (WIDTH[id] ?? 380) - 24 - OFFSET[id] * 18), top: 96 + OFFSET[id] * 18 };
  win.style.cssText =
    `position:fixed;left:${pos.left}px;top:${pos.top}px;width:${WIDTH[id] ?? 380}px;max-width:94vw;` +
    `max-height:calc(100vh - ${pos.top + 24}px);display:flex;flex-direction:column;z-index:${++zTop};` +
    "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;color:#e8eaf0;" +
    "font:13px system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5);";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#161a22;border-bottom:1px solid #2a2e3a;border-radius:8px 8px 0 0;cursor:move;user-select:none;touch-action:none;";
  const title = document.createElement("b");
  title.textContent = sec.title;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Close";
  close.style.cssText = "background:transparent;border:none;color:#8b949e;font-size:16px;cursor:pointer;line-height:1;";
  close.onpointerdown = (e) => e.stopPropagation();
  close.onclick = () => closeToolWindow(id);
  head.append(title, close);

  const body = document.createElement("div");
  body.style.cssText = "overflow:auto;min-height:0;flex:1;background:#0f1117;border-radius:0 0 8px 8px;";
  body.appendChild(buildToolSection(id));
  // keep wheel / keys inside the window (never zoom the 3D view or trigger tool shortcuts)
  body.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  body.addEventListener("keydown", (e) => e.stopPropagation());

  // drag by the title bar
  head.onpointerdown = (e) => {
    if (e.button !== 0) return;
    win.style.zIndex = String(++zTop);
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const left = Math.min(Math.max(-r.width + 80, ev.clientX - dx), window.innerWidth - 80);
      const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
      win.style.left = `${left}px`; win.style.top = `${top}px`;
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    e.preventDefault();
  };
  win.addEventListener("pointerdown", () => { win.style.zIndex = String(++zTop); }, true);

  win.append(head, body);
  document.body.appendChild(win);
  open.set(id, win);
  try { window.dispatchEvent(new CustomEvent("obs-tool-window", { detail: { id, open: true } })); } catch { /* */ }
}

export function toggleToolWindow(id: ToolWindowId): void {
  if (open.has(id)) closeToolWindow(id); else openToolWindow(id);
}

export function setupToolWindows(): void {
  (window as any).__obsToolWindows = { open: openToolWindow, close: closeToolWindow, toggle: toggleToolWindow, isOpen: isToolWindowOpen };
}
