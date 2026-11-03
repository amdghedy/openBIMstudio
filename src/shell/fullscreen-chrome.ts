/**
 * Full-screen focus mode.
 *
 * Whenever anything on the page goes full screen — the browser's F11, the CAD
 * viewer's full-screen button, or any future command — all command chrome (the
 * ribbon with its tabs and command strip, and the status bar) is hidden so the
 * model view window gets the entire screen. Leaving full screen restores
 * everything exactly as it was, including the ribbon's own minimize state,
 * because the hiding is done purely with a body-scoped CSS class.
 *
 * The class also triggers viewer refits: hiding the chrome changes the layout
 * without a window resize, so we re-dispatch the same resize events the ribbon
 * minimize uses (viewers listen to those to re-fit their canvases).
 */
import { fullscreenChromeActive } from "./ribbon-collapse";

export const FULLSCREEN_CLASS = "obs-fullscreen";

function applyFullscreenChrome(): void {
  const fs =
    (document as any).fullscreenElement ??
    (document as any).webkitFullscreenElement ??
    null;
  document.body.classList.toggle(FULLSCREEN_CLASS, fullscreenChromeActive(fs));
  // the layout changed without a window resize — tell the viewers to refit
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new CustomEvent("obs-ribbon-resize"));
}

export function setupFullscreenChrome(): void {
  document.addEventListener("fullscreenchange", applyFullscreenChrome);
  // legacy WebKit (Safari < 16.4)
  document.addEventListener("webkitfullscreenchange", applyFullscreenChrome as EventListener);
}
