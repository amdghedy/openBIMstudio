/**
 * Plugin loader — discovers, validates, and activates runtime plugins.
 *
 * Plugins live in `public/plugins/<plugin-id>/` and are discovered via:
 *
 *   1. Fetch `/plugins/index.json` → `string[]` of plugin ids.
 *   2. For each id, fetch `/plugins/<id>/plugin.json` → `PluginManifest`.
 *   3. Validate manifest (id format, version, capabilities, sdkVersion).
 *   4. Inject `window.__obsRegisterPlugin` bridge.
 *   5. Load `<id>/index.js` (or manifest.entry) as a classic script.
 *   6. Plugin's top-level code calls `window.__obsRegisterPlugin(m, factory)`.
 *   7. Host builds the typed PluginAPI via `buildPluginAPI()` and calls
 *      `factory(api)` → `PluginInstance`.
 *   8. Host calls `instance.activate()`.
 *
 * Plugins are loaded with `<script>` tags (not ES module imports) because:
 *   - Vite serves `/public` files as-is, not via the bundler.
 *   - Classic scripts share `window`, making the `__obsRegisterPlugin`
 *     bridge trivial and bundler-agnostic.
 *   - Future sandboxing via Web Workers or iframe realms can layer on top.
 *
 * The loader is fault-tolerant: a single plugin failure does not break the
 * host or other plugins. All errors are logged via `console.warn`.
 */

import type {
  PluginCapability, PluginFactory, PluginInstance, PluginManifest,
} from "./types";
import { validateManifest, parseSemver, isSemverCompatible } from "./types";
import { buildPluginAPI, releasePluginAPI, SDK_VERSION } from "./api";

interface LoadedPlugin {
  manifest: PluginManifest;
  factory: PluginFactory;
  instance: PluginInstance | null;
  activated: boolean;
}

const loaded = new Map<string, LoadedPlugin>();
const loading = new Set<string>();

/** Hardcoded allowlist of plugins to load (until `/plugins/index.json` exists).
 *
 *  Once `index.json` is published, this fallback is no longer used. The
 *  allowlist is conservative — only well-known plugins ship here.
 */
const FALLBACK_PLUGIN_IDS = [
  "ifc-validator",
  "csv-takeoff",
  "family-from-csv",
  "clash-rule-pack",
  "element-counter",
];

/** Capabilities the host is willing to grant to third-party plugins. */
const GRANTABLE_CAPS: PluginCapability[] = [
  "authoring.read",
  "authoring.write",
  "selection.read",
  "selection.write",
  "camera.read",
  "camera.write",
  "clash.read",
  "clash.write",
  "issues.read",
  "issues.write",
  "schedules.read",
  "schedules.write",
  "cost.read",
  "cost.write",
  "family.read",
  "family.write",
  "ifc.read",
  "ifc.write",
  "ui.panel",
  "ui.command",
  "ui.ribbon",
  "ui.context-menu",
  "ui.notification",
  "fs.local",
  "network.fetch",
  "worker.spawn",
];

/** Discover the plugin index. Falls back to a static allowlist on 404. */
async function discoverPluginIds(): Promise<string[]> {
  try {
    const res = await fetch("/plugins/index.json", { cache: "no-cache" });
    if (!res.ok) return FALLBACK_PLUGIN_IDS;
    const data = await res.json();
    if (!Array.isArray(data)) return FALLBACK_PLUGIN_IDS;
    return data.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return FALLBACK_PLUGIN_IDS;
  }
}

/** Fetch + validate a plugin manifest. Returns null on any failure. */
async function fetchManifest(id: string): Promise<PluginManifest | null> {
  try {
    const res = await fetch(`/plugins/${id}/plugin.json`, { cache: "no-cache" });
    if (!res.ok) {
      console.warn(`[plugins] ${id}: plugin.json returned ${res.status}`);
      return null;
    }
    const manifest = await res.json();
    const err = validateManifest(manifest);
    if (err) {
      console.warn(`[plugins] ${id}: invalid manifest — ${err}`);
      return null;
    }
    // SDK version compatibility check
    const m = manifest as PluginManifest;
    if (m.sdkVersion !== SDK_VERSION.major) {
      console.warn(
        `[plugins] ${id}: requires SDK v${m.sdkVersion} but host is v${SDK_VERSION.major}. ` +
        `Skipping — major version mismatch.`,
      );
      return null;
    }
    return m;
  } catch (e) {
    console.warn(`[plugins] ${id}: failed to fetch plugin.json`, e);
    return null;
  }
}

/** Compute the granted capability set for a plugin (intersection of requested × grantable). */
function grantCapabilities(manifest: PluginManifest): PluginCapability[] {
  const grantable = new Set<PluginCapability>(GRANTABLE_CAPS);
  const granted: PluginCapability[] = [];
  for (const cap of manifest.capabilities) {
    if (cap === "*") {
      // Wildcard: grant everything grantable. Reserved for trusted plugins;
      // third-party plugins should request specific capabilities.
      console.warn(
        `[plugins] ${manifest.id}: requested wildcard capability — ` +
        `granting all. Use specific capabilities for third-party plugins.`,
      );
      return [...grantable];
    }
    if (grantable.has(cap)) {
      granted.push(cap);
    } else {
      console.warn(`[plugins] ${manifest.id}: capability "${cap}" is not grantable — ignored.`);
    }
  }
  return granted;
}

/** Load a plugin's entry script via a classic <script> tag. */
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.dataset.obsPlugin = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load plugin script: ${url}`));
    document.head.appendChild(s);
  });
}

/** Install the `window.__obsRegisterPlugin` bridge for a specific plugin id. */
function installRegistrationBridge(pluginId: string): void {
  if (!window.__obsPluginRegistry) {
    window.__obsPluginRegistry = new Map();
  }
  window.__obsRegisterPlugin = (manifest: PluginManifest, factory: PluginFactory) => {
    // Defensively re-validate the manifest the plugin declares.
    const err = validateManifest(manifest);
    if (err) {
      console.warn(`[plugins:${pluginId}] registered invalid manifest — ${err}. Skipping.`);
      return;
    }
    // Ensure the registered id matches the directory name to prevent spoofing.
    if (manifest.id !== pluginId) {
      console.warn(
        `[plugins:${pluginId}] registered with id "${manifest.id}" ` +
        `which does not match directory name. Skipping.`,
      );
      return;
    }
    window.__obsPluginRegistry!.set(pluginId, { manifest, factory });
  };
}

/** Activate a single plugin. Returns true on success. */
async function loadAndActivatePlugin(id: string): Promise<boolean> {
  if (loaded.has(id) || loading.has(id)) return loaded.has(id);
  loading.add(id);

  try {
    const manifest = await fetchManifest(id);
    if (!manifest) return false;

    // Check dependencies
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!loaded.has(dep)) {
          console.warn(
            `[plugins:${id}] dependency "${dep}" not loaded. ` +
            `Loading it first…`,
          );
          await loadAndActivatePlugin(dep);
          if (!loaded.has(dep)) {
            console.warn(`[plugins:${id}] dependency "${dep}" failed to load. Skipping.`);
            return false;
          }
        }
      }
    }

    // Install bridge and load script
    installRegistrationBridge(id);
    const entry = manifest.entry ?? "index.js";
    const scriptUrl = `/plugins/${id}/${entry}`;
    try {
      await loadScript(scriptUrl);
    } catch (e) {
      console.warn(`[plugins:${id}] script load failed:`, e);
      return false;
    }

    // Plugin should have called __obsRegisterPlugin synchronously
    const registered = window.__obsPluginRegistry?.get(id);
    if (!registered) {
      console.warn(
        `[plugins:${id}] loaded script but did not call ` +
        `window.__obsRegisterPlugin(manifest, factory). Skipping.`,
      );
      return false;
    }

    // Use the manifest the plugin registered (with its own version / capabilities),
    // not the one we fetched — the plugin's own manifest is authoritative.
    const finalManifest = registered.manifest;
    const factory = registered.factory;

    const grantedCaps = grantCapabilities(finalManifest);
    const api = buildPluginAPI(finalManifest, grantedCaps);

    let instance: PluginInstance;
    try {
      const result = await factory(api);
      instance = result;
    } catch (e) {
      console.warn(`[plugins:${id}] factory() threw:`, e);
      releasePluginAPI(id);
      return false;
    }

    try {
      await instance.activate();
    } catch (e) {
      console.warn(`[plugins:${id}] activate() threw:`, e);
      releasePluginAPI(id);
      return false;
    }

    loaded.set(id, { manifest: finalManifest, factory, instance, activated: true });
    console.log(`[plugins] ✓ loaded ${id} v${finalManifest.version} (${grantedCaps.length} caps)`);
    return true;
  } catch (e) {
    console.warn(`[plugins:${id}] unexpected failure:`, e);
    return false;
  } finally {
    loading.delete(id);
  }
}

/**
 * Discover and activate all plugins. Idempotent — calling twice will not
 * re-activate already-loaded plugins.
 */
export async function loadPlugins(): Promise<void> {
  const ids = await discoverPluginIds();
  if (ids.length === 0) {
    console.log("[plugins] no plugins discovered");
    return;
  }
  console.log(`[plugins] discovering ${ids.length} plugin(s): ${ids.join(", ")}`);

  let ok = 0;
  for (const id of ids) {
    const success = await loadAndActivatePlugin(id);
    if (success) ok++;
  }
  console.log(`[plugins] ${ok}/${ids.length} plugin(s) active`);
}

/** Deactivate all loaded plugins (called on host teardown / project switch). */
export async function unloadAllPlugins(): Promise<void> {
  for (const [id, plugin] of loaded.entries()) {
    try {
      if (plugin.instance && plugin.activated) {
        await plugin.instance.deactivate();
      }
    } catch (e) {
      console.warn(`[plugins:${id}] deactivate() threw:`, e);
    }
    releasePluginAPI(id);
  }
  loaded.clear();
}

/** List currently loaded plugins (for debugging / status UI). */
export function listLoadedPlugins(): Array<{ id: string; version: string; capabilities: string[] }> {
  return [...loaded.values()].map(p => ({
    id: p.manifest.id,
    version: p.manifest.version,
    capabilities: p.manifest.capabilities,
  }));
}

/** Programmatic load of a single plugin (e.g. from a marketplace install flow). */
export async function loadPlugin(id: string): Promise<boolean> {
  return loadAndActivatePlugin(id);
}

/** Programmatic unload of a single plugin. */
export async function unloadPlugin(id: string): Promise<boolean> {
  const plugin = loaded.get(id);
  if (!plugin) return false;
  try {
    if (plugin.instance && plugin.activated) {
      await plugin.instance.deactivate();
    }
  } catch (e) {
    console.warn(`[plugins:${id}] deactivate() threw:`, e);
  }
  releasePluginAPI(id);
  loaded.delete(id);
  return true;
}

/** Back-compat: legacy alias for `loadPlugins()`. */
export const setupPlugins = loadPlugins;
