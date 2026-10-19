/**
 * Plugin boot wiring — entry point for the plugin subsystem.
 *
 * Imported once from `main.ts` (or `critical-gaps-boot.ts`) via:
 *
 *   import { setupPluginSystem } from "./plugins/boot";
 *   await step("plugins", () => setupPluginSystem());
 *
 * Defer plugin loading until the viewport and all services are ready.
 * Plugins depend on `selection`, `authoring`, `camera`, etc. — if we load
 * them too early, capabilities like `services.tryUse("authoring")` return
 * null and plugins silently degrade.
 */

import { loadPlugins, unloadAllPlugins } from "./loader";

/** One-shot guard so repeated calls don't try to load plugins twice. */
let booted = false;

/**
 * Wire the plugin system into the host. Safe to call multiple times —
 * the first call performs the work; subsequent calls are no-ops.
 *
 * @param opts.delay - optional ms to wait before loading (default 500ms,
 *   lets the viewport finish its initial render).
 */
export async function setupPluginSystem(opts?: { delay?: number }): Promise<void> {
  if (booted) return;
  booted = true;

  const delay = opts?.delay ?? 500;
  setTimeout(async () => {
    try {
      await loadPlugins();
    } catch (e) {
      console.warn("[plugins:boot] loadPlugins failed:", e);
    }
  }, delay);

  // Wire teardown on page unload (so plugins can clean up workers, listeners).
  window.addEventListener("beforeunload", () => {
    void unloadAllPlugins();
  });
}

/** Re-trigger plugin discovery + load (e.g. after a marketplace install). */
export async function reloadPlugins(): Promise<void> {
  await unloadAllPlugins();
  await loadPlugins();
}
