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
  const on = fullscreenChromeActive(fs);
  document.body.classList.toggle(FULLSCREEN_CLASS, on);
  if (!fs) document.body.classList.remove("obs-fullscreen-peek");
  // the layout changed without a window resize — tell the viewers to refit
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new CustomEvent("obs-ribbon-resize"));
  // let UI (e.g. the View ▸ Full Screen button) re-read isAppFullScreen()
  window.dispatchEvent(new CustomEvent("obs-fullscreen-toggle", { detail: { on } }));
}

export function setupFullscreenChrome(): void {
  document.addEventListener("fullscreenchange", applyFullscreenChrome);
  // legacy WebKit (Safari < 16.4)
  document.addEventListener("webkitfullscreenchange", applyFullscreenChrome as EventListener);
  setupEnterFullScreen();
}

/* ═════════════════════════════════════════════════════════════════════
   Entering full screen from the main app.

   The browser's own F11 fullscreen does NOT fire fullscreenchange on
   Chromium (document.fullscreenElement stays null), so the chrome hiding
   above would never trigger. We therefore intercept F11, preventDefault
   it, and drive the standard Fullscreen API on <html> instead — that way
   every path (F11, the View ▸ Full Screen button, Esc) goes through
   fullscreenchange and hides the command bars reliably.

   While full screen, a 12 px hover zone at the very top edge temporarily
   reveals the ribbon (peek); moving the mouse back down hides it again.
   ═════════════════════════════════════════════════════════════════════ */

/** Current main-app fullscreen state (drives the View ▸ Full Screen button). */
let appFullScreenOn = false;

export function isAppFullScreen(): boolean {
  return appFullScreenOn;
}

/** Toggle browser fullscreen on the app root; the fullscreenchange listener above hides the chrome. */
export function toggleAppFullScreen(): void {
  const doc = document as any;
  if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
    try { void doc.exitFullscreen?.()?.catch?.(() => { /* ignore */ }); } catch { try { doc.webkitExitFullscreen?.(); } catch { /* ignore */ } }
    return;
  }
  const el: any = doc.documentElement;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (typeof req === "function") {
    try {
      const p = req.call(el);
      if (p && typeof p.then === "function") p.catch(() => { /* blocked (sandboxed iframe) — chrome stays, no crash */ });
    } catch { /* ignore */ }
  }
}

function setupEnterFullScreen(): void {
  // Track state for the ribbon button highlight (any fullscreen element counts).
  const sync = () => { appFullScreenOn = !!(document.fullscreenElement ?? (document as any).webkitFullscreenElement); };
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync as EventListener);

  // F11 → in-app fullscreen via the Fullscreen API (fires fullscreenchange).
  window.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      e.preventDefault();
      toggleAppFullScreen();
    }
  }, true);

  // Top-edge peek zone: hover the very top of the screen to reveal the ribbon.
  const peek = document.createElement("div");
  peek.id = "obs-fullscreen-peek";
  peek.style.cssText =
    "position:fixed;top:0;left:0;right:0;height:12px;z-index:2147483000;display:none;";
  peek.addEventListener("mouseenter", () => {
    if (document.body.classList.contains(FULLSCREEN_CLASS)) {
      document.body.classList.add("obs-fullscreen-peek");
    }
  });
  document.body.appendChild(peek);
  document.addEventListener("mousemove", (e) => {
    if (document.body.classList.contains("obs-fullscreen-peek") && e.clientY > 140) {
      document.body.classList.remove("obs-fullscreen-peek");
    }
  });
  // show/hide the peek zone with the chrome itself
  const syncPeek = () => { peek.style.display = document.body.classList.contains(FULLSCREEN_CLASS) ? "block" : "none"; };
  document.addEventListener("fullscreenchange", syncPeek);
  document.addEventListener("webkitfullscreenchange", syncPeek as EventListener);
}
