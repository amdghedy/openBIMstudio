/**
 * Desktop-app behaviour: installable, offline, opens .obsproj / .ifc / .frag files from the OS.
 * The service worker is only registered in production builds so the dev server keeps hot reload.
 */
import { notify } from "./notify";

let installEvent: any = null;
const listeners = new Set<() => void>();

export function canInstallApp(): boolean { return !!installEvent; }
export function isRunningAsApp(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: window-controls-overlay)").matches ||
      (navigator as any).standalone === true;
  } catch { return false; }
}
export function onInstallStateChange(cb: () => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }

/** Show the browser's install prompt. Returns true when the user accepted. */
export async function installApp(): Promise<boolean> {
  if (isRunningAsApp()) { notify("info", "Already running as an installed app"); return false; }
  if (!installEvent) {
    notify("info", "Use your browser's menu: Install Open BIM Studio (Chrome / Edge: the install icon in the address bar).");
    return false;
  }
  installEvent.prompt();
  const choice = await installEvent.userChoice.catch(() => null);
  installEvent = null;
  listeners.forEach((f) => f());
  return choice?.outcome === "accepted";
}

async function openLaunchedFiles(handles: any[]): Promise<void> {
  for (const h of handles) {
    try {
      const file: File = await h.getFile();
      const name = file.name.toLowerCase();
      if (name.endsWith(".obsproj")) {
        const m = await import("../modules/projects/project-file-io");
        await m.importProjectFile(file, h);
      } else if (name.endsWith(".ifc")) {
        (await import("../features/importer")).loadIfcFiles([file]);
      } else if (name.endsWith(".frag")) {
        await (await import("../features/importer")).loadFragFiles([file]);
      } else {
        notify("info", `Don't know how to open ${file.name}`);
      }
    } catch (e) {
      console.warn("[pwa] could not open launched file", e);
      notify("error", "Could not open that file");
    }
  }
}

export function setupPwa(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    notify("info", "Installed. Open BIM Studio now runs like a desktop app and works offline.");
    listeners.forEach((f) => f());
  });

  // files double-clicked in the OS file manager
  const lq = (window as any).launchQueue;
  if (lq?.setConsumer) lq.setConsumer((params: any) => { if (params?.files?.length) void openLaunchedFiles(params.files); });

  // keep project data safe from automatic browser cleanup
  try { void navigator.storage?.persist?.(); } catch { /* */ }

  if (!("serviceWorker" in navigator) || !(import.meta as any).env?.PROD) return;
  // A published page is a static snapshot hosted anywhere: it carries no
  // sw.js and must not register the app's service worker (which would
  // 404 and spam the console on every load).
  if ((window as any).__OBS_PUBLISHED__) return;
  // The boot steps run long after window load on a cold start, so a bare
  // load listener misses its event and the worker never registers (proven
  // 2026-11-21: no registration 20 s after load in the production preview).
  // Register immediately when the document is already complete.
  const register = () => {
    // updateViaCache:"none" — /sw.js must never be resolved from the browser HTTP
    // cache, otherwise a new deploy can ship while the old worker keeps serving
    // stale (mismatched) assets like the web-ifc WASM.
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            notify("info", "A new version is ready. Reload the app to use it.");
          }
        });
      });
      // The browser's automatic update check on navigation is throttled (up
      // to 24 h between checks), so a redeploy can sit unnoticed for a day
      // in an installed PWA — proven 2026-11-21: a rebuilt sw.js was served
      // for minutes with no automatic install, while an explicit update()
      // installed it at once. Check on every return to the tab, and once at
      // boot so the next visit after a deploy picks it up immediately.
      const checkForUpdate = () => { reg.update().catch(() => { /* offline: keep the current worker */ }); };
      checkForUpdate();
      document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
      window.addEventListener("focus", checkForUpdate);
    }).catch((e) => console.warn("[pwa] service worker not registered", e));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
}
