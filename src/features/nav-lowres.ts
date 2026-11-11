/**
 * Smooth navigation: while the camera is being moved (orbit / pan / zoom) the 3D view is drawn at a lower pixel ratio,
 * then restored shortly after the last movement. This is the usual adaptive-resolution trick: it cuts the per-frame
 * fragment work on large models / high-DPI screens at no cost to the still image.
 *
 * On by default; toggle with the command "View: Smooth navigation (lower resolution while moving)". Persisted in
 * localStorage (best-effort).
 */
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";

const KEY = "obs.smoothNav";
const RESTORE_MS = 220;

export function lowResRatio(devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(1, Math.max(0.5, dpr * 0.5));
}

let enabled = true;
let held = false;          // a pointer button is down on the viewport
let moving = false;        // low-res currently applied
let fullRatio = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const renderer = (): any => (ctx as any).world?.renderer?.three;

function begin(): void {
  if (!enabled || moving) return;
  const r = renderer();
  if (!r?.setPixelRatio) return;
  fullRatio = r.getPixelRatio();
  const low = lowResRatio(window.devicePixelRatio);
  if (low >= fullRatio) return;          // nothing to gain
  r.setPixelRatio(low);
  moving = true;
}

function end(): void {
  if (!moving) return;
  const r = renderer();
  try { r?.setPixelRatio?.(fullRatio); } catch { /* */ }
  moving = false;
}

function scheduleEnd(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; if (!held) end(); }, RESTORE_MS);
}

export function isSmoothNavEnabled(): boolean { return enabled; }
export function setSmoothNavEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* */ }
  if (!on) end();
}

export function setupNavLowRes(): void {
  try { enabled = localStorage.getItem(KEY) !== "0"; } catch { /* default on */ }
  // The viewport host may not exist yet when this runs, so listen on the document and filter on the WebGL canvas.
  const r0 = () => renderer()?.domElement as HTMLElement | undefined;
  const onCanvas = (e: Event) => { const c = r0(); return !!c && (e.target === c || (e.target instanceof Node && c.contains(e.target))); };
  document.addEventListener("pointerdown", (e) => { if (onCanvas(e)) { held = true; begin(); } }, true);
  const up = () => { if (held) { held = false; scheduleEnd(); } };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  document.addEventListener("wheel", (e) => { if (onCanvas(e)) { begin(); scheduleEnd(); } }, { passive: true, capture: true });
  registerCommand({
    id: "view.smooth_nav",
    label: "View: Smooth navigation (lower resolution while moving)",
    category: "View",
    hint: "Draw the 3D view at lower resolution while orbiting / panning / zooming, sharp again when you stop",
    run: () => { setSmoothNavEnabled(!enabled); },
  });
}
