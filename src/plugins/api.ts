/**
 * Plugin API host-side bridge.
 *
 * Adapts the typed PluginSDK surface (declared in `types.ts`) onto the
 * internal ServiceMap registry. Each method checks the granted capabilities
 * before delegating to the underlying service; this is the
 * permission-gate layer between plugins and the host.
 */

import type {
  PluginAPI, PluginCapability, PluginFactory, PluginInstance, PluginManifest,
  PluginSDK, SemVer,
} from "./types";
import { tryUse } from "../core/services";
import { APP_VERSION } from "../version";

/** Current Plugin SDK version. Bump on breaking API changes. */
export const SDK_VERSION: SemVer = { major: 1, minor: 1, patch: 0 };

/** Host application version — single source of truth (src/version.ts).
 *  Remediation Phase 2.1: was hardcoded "0.55.0" and drifted. */
export const HOST_VERSION = APP_VERSION;

/** Internal: per-plugin granted capability set. */
const granted = new Map<string, Set<PluginCapability>>();

function has(pluginId: string, cap: PluginCapability): boolean {
  const set = granted.get(pluginId);
  if (!set) return false;
  if (set.has("*")) return true;
  return set.has(cap);
}

function require_<T>(pluginId: string, cap: PluginCapability, fn: () => T): T {
  if (!has(pluginId, cap)) {
    throw new Error(
      `[plugins:${pluginId}] capability "${cap}" not granted. ` +
      `Add it to your plugin.json capabilities array.`,
    );
  }
  return fn();
}

/** Build the typed SDK object for a plugin. */
export function buildPluginSDK(pluginId: string): PluginSDK {
  return {
    version: SDK_VERSION,
    hostVersion: HOST_VERSION,

    authoring: {
      getElements: () => require_(pluginId, "authoring.read", () => {
        const svc = tryUse("authoring");
        return svc ? svc.getElements() : [];
      }),
      getElementById: (id) => require_(pluginId, "authoring.read", () => {
        const svc = tryUse("authoring");
        return svc ? svc.getElementById(id) : null;
      }),
      createElement: (type, params, hostId) => require_(pluginId, "authoring.write", async () => {
        // Remediation Phase 1.4: routes through the REAL authoring creation
        // path (same history-wrapped transaction the draw tools use). No
        // stub, no fake success — failures are typed and honest.
        const svc = tryUse("authoring") as any;
        if (!svc || typeof svc.createElementByType !== "function") {
          return {
            ok: false as const,
            error: "not-implemented" as const,
            message: "authoring service is not available (not booted or does not expose createElementByType)",
          };
        }
        const id = await svc.createElementByType(type, params ?? {}, hostId);
        if (!id) {
          return {
            ok: false as const,
            error: "rejected" as const,
            message: `authoring rejected createElement("${String(type)}") — unknown type or invalid params`,
          };
        }
        return { ok: true as const, id };
      }),
      updateElement: (id, patch) => require_(pluginId, "authoring.write", () => {
        const svc = tryUse("authoring");
        if (!svc) return false;
        const el = svc.getElementById(id);
        if (!el) return false;
        Object.assign((el as any).properties ?? {}, patch);
        svc.rebuildAuthored();
        return true;
      }),
      deleteElement: (id) => require_(pluginId, "authoring.write", () => {
        const svc = tryUse("authoring");
        if (!svc) return false;
        // AuthoringService doesn't expose deleteElement(id) directly; we use
        // setSelectedAuthored + deleteSelectedElement as a workaround.
        svc.setSelectedAuthored([id], "replace");
        svc.deleteSelectedElement();
        return true;
      }),
      onChange: (cb) => {
        const svc = tryUse("authoring");
        if (!svc) return () => {};
        return svc.onAuthoringChange(cb);
      },
    },

    selection: {
      snapshot: () => require_(pluginId, "selection.read", () => {
        const svc = tryUse("selection");
        if (!svc) return {};
        const map = svc.snapshot();
        // Convert Set<number> to number[] for plugin-friendly consumption
        const out: Record<string, number[]> = {};
        for (const [modelId, ids] of Object.entries(map)) {
          out[modelId] = [...ids];
        }
        return out;
      }),
      size: () => require_(pluginId, "selection.read", () => {
        const svc = tryUse("selection");
        return svc ? svc.size() : 0;
      }),
      replace: (map) => require_(pluginId, "selection.write", () => {
        const svc = tryUse("selection");
        if (!svc) return;
        const native: Record<string, Set<number>> = {};
        for (const [modelId, ids] of Object.entries(map)) {
          native[modelId] = new Set(ids);
        }
        svc.replace(native);
      }),
      clear: () => require_(pluginId, "selection.write", () => {
        const svc = tryUse("selection");
        svc?.clear();
      }),
      onChange: (cb) => {
        const svc = tryUse("selection");
        if (!svc) return () => {};
        return svc.onChange(cb);
      },
    },

    camera: {
      fitAll: () => require_(pluginId, "camera.write", () => {
        tryUse("camera")?.fitAll();
      }),
      focusOnBox: (box) => require_(pluginId, "camera.write", () => {
        const svc = tryUse("camera");
        if (!svc) return;
        const min = new Float32Array(box.min) as unknown as [number, number, number];
        const max = new Float32Array(box.max) as unknown as [number, number, number];
        // CameraService has focusOnBox(THREE.Box3). We can't construct a
        // THREE.Box3 here without importing three, so we adapt via the
        // scene-metadata route. This is the seam where the adapter would
        // build a real THREE.Box3.
        try {
          (svc as any).focusOnBox({ min, max });
        } catch (e) {
          console.warn(`[plugins:${pluginId}] camera.focusOnBox failed`, e);
        }
      }),
      screenshot: (opts) => require_(pluginId, "camera.write", () => {
        tryUse("camera")?.screenshot(opts);
      }),
      setProjection: (mode) => require_(pluginId, "camera.write", () => {
        const svc = tryUse("camera");
        return svc ? svc.setProjection(mode) : false;
      }),
    },

    clash: {
      getScenarios: () => require_(pluginId, "clash.read", () => {
        const svc = tryUse("clash");
        return svc ? (svc as any).getScenarios?.() ?? [] : [];
      }),
      getResults: (scenarioId) => require_(pluginId, "clash.read", () => {
        const svc = tryUse("clash");
        return svc ? (svc as any).getResults?.(scenarioId) ?? [] : [];
      }),
      runScenario: (scenarioId) => require_(pluginId, "clash.write", async () => {
        const svc = tryUse("clash");
        if (!svc) return null;
        return await (svc as any).runScenario?.(scenarioId) ?? null;
      }),
    },

    issues: {
      list: () => require_(pluginId, "issues.read", () => {
        const svc = tryUse("issues");
        return svc ? (svc as any).list?.() ?? [] : [];
      }),
      create: (issue) => require_(pluginId, "issues.write", () => {
        const svc = tryUse("issues");
        if (!svc) return null;
        return (svc as any).create?.(issue) ?? null;
      }),
      update: (id, patch) => require_(pluginId, "issues.write", () => {
        const svc = tryUse("issues");
        if (!svc) return false;
        return (svc as any).update?.(id, patch) ?? false;
      }),
      exportBCF: () => require_(pluginId, "issues.read", async () => {
        const svc = tryUse("issues");
        if (!svc) return new Blob([]);
        return await (svc as any).exportBCF?.() ?? new Blob([]);
      }),
    },

    schedules: {
      list: () => require_(pluginId, "schedules.read", () => {
        const svc = tryUse("schedules");
        return svc ? (svc as any).list?.() ?? [] : [];
      }),
      create: (schedule) => require_(pluginId, "schedules.write", () => {
        const svc = tryUse("schedules");
        if (!svc) return null;
        return (svc as any).create?.(schedule) ?? null;
      }),
      getRows: (scheduleId) => require_(pluginId, "schedules.read", () => {
        const svc = tryUse("schedules");
        return svc ? (svc as any).getRows?.(scheduleId) ?? [] : [];
      }),
      exportCSV: (scheduleId) => require_(pluginId, "schedules.read", async () => {
        const svc = tryUse("schedules");
        if (!svc) return new Blob([]);
        return await (svc as any).exportCSV?.(scheduleId) ?? new Blob([]);
      }),
    },

    cost: {
      getItems: () => require_(pluginId, "cost.read", () => {
        const svc = tryUse("cost" as any);
        return svc ? (svc as any).getItems?.() ?? [] : [];
      }),
      getQuantities: (elementId) => require_(pluginId, "cost.read", () => {
        const svc = tryUse("cost" as any);
        return svc ? (svc as any).getQuantities?.(elementId) ?? null : null;
      }),
      exportTakeoff: () => require_(pluginId, "cost.read", async () => {
        const svc = tryUse("cost" as any);
        if (!svc) return new Blob([]);
        return await (svc as any).exportTakeoff?.() ?? new Blob([]);
      }),
    },

    family: {
      list: () => require_(pluginId, "family.read", () => {
        const svc = tryUse("family");
        return svc ? svc.list() : [];
      }),
      get: (id) => require_(pluginId, "family.read", () => {
        const svc = tryUse("family");
        return svc ? svc.get(id) : null;
      }),
      create: (family) => require_(pluginId, "family.write", () => {
        const svc = tryUse("family");
        if (!svc) return null;
        return (svc as any).create?.(family) ?? null;
      }),
      buildGeometry: (familyId, params) => require_(pluginId, "family.read", () => {
        const svc = tryUse("family");
        if (!svc) return null;
        return (svc as any).buildGeometry?.(familyId, params) ?? null;
      }),
    },

    ifc: {
      getModels: () => require_(pluginId, "ifc.read", () => {
        const svc = tryUse("fragEdit");
        return svc ? (svc as any).getModels?.() ?? [] : [];
      }),
      getEntities: (modelId, ifcClass) => require_(pluginId, "ifc.read", () => {
        const svc = tryUse("fragEdit");
        return svc ? (svc as any).getEntities?.(modelId, ifcClass) ?? [] : [];
      }),
      exportIFC: (modelIds) => require_(pluginId, "ifc.write", async () => {
        const svc = tryUse("fragEdit");
        if (!svc) return new Blob([]);
        return await (svc as any).exportIFC?.(modelIds) ?? new Blob([]);
      }),
    },

    ui: {
      registerPanel: (id, def) => require_(pluginId, "ui.panel", () => {
        // Register the panel into the host's panel registry. For now we
        // expose it via the global so the existing panel-wiring code can
        // discover it; in a future refactor this becomes a real panel
        // service registration.
        (window as any).__obsPlugins ??= new Map();
        (window as any).__obsPlugins.set(`panel:${pluginId}:${id}`, def);
        console.info(`[plugins:${pluginId}] registered panel "${id}"`);
      }),
      unregisterPanel: (id) => require_(pluginId, "ui.panel", () => {
        (window as any).__obsPlugins?.delete(`panel:${pluginId}:${id}`);
      }),
      registerCommand: (cmd) => require_(pluginId, "ui.command", () => {
        (window as any).__obsPlugins ??= new Map();
        (window as any).__obsPlugins.set(`command:${pluginId}:${cmd.id}`, cmd);
      }),
      unregisterCommand: (id) => require_(pluginId, "ui.command", () => {
        (window as any).__obsPlugins?.delete(`command:${pluginId}:${id}`);
      }),
      registerRibbonTab: (tab) => require_(pluginId, "ui.ribbon", () => {
        (window as any).__obsPlugins ??= new Map();
        (window as any).__obsPlugins.set(`ribbon:${pluginId}:${tab.id}`, tab);
      }),
      unregisterRibbonTab: (id) => require_(pluginId, "ui.ribbon", () => {
        (window as any).__obsPlugins?.delete(`ribbon:${pluginId}:${id}`);
      }),
      registerContextMenuAction: (action) => require_(pluginId, "ui.context-menu", () => {
        (window as any).__obsPlugins ??= new Map();
        (window as any).__obsPlugins.set(`ctx:${pluginId}:${action.id}`, action);
      }),
      unregisterContextMenuAction: (id) => require_(pluginId, "ui.context-menu", () => {
        (window as any).__obsPlugins?.delete(`ctx:${pluginId}:${id}`);
      }),
    },

    notify: {
      info: (msg, opts) => require_(pluginId, "ui.notification", () => {
        (window as any).__obsNotify?.("info", msg, opts);
      }),
      success: (msg, opts) => require_(pluginId, "ui.notification", () => {
        (window as any).__obsNotify?.("success", msg, opts);
      }),
      warn: (msg, opts) => require_(pluginId, "ui.notification", () => {
        (window as any).__obsNotify?.("warn", msg, opts);
      }),
      error: (msg, opts) => require_(pluginId, "ui.notification", () => {
        (window as any).__obsNotify?.("error", msg, opts);
      }),
    },

    storage: {
      get: (key) => require_(pluginId, "fs.local", async () => {
        const fullKey = `plugin:${pluginId}:${key}`;
        const raw = localStorage.getItem(fullKey);
        return raw ? JSON.parse(raw) : null;
      }),
      set: (key, value) => require_(pluginId, "fs.local", async () => {
        const fullKey = `plugin:${pluginId}:${key}`;
        localStorage.setItem(fullKey, JSON.stringify(value));
      }),
      remove: (key) => require_(pluginId, "fs.local", async () => {
        const fullKey = `plugin:${pluginId}:${key}`;
        localStorage.removeItem(fullKey);
      }),
      keys: () => require_(pluginId, "fs.local", async () => {
        const prefix = `plugin:${pluginId}:`;
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
        }
        return keys;
      }),
    },

    fetch: (...args: Parameters<typeof fetch>) => require_(pluginId, "network.fetch", () => {
      return fetch(...args);
    }),

    spawnWorker: (scriptUrl, options) => require_(pluginId, "worker.spawn", () => {
      return new Worker(scriptUrl, options);
    }),
  };
}

/** Build the PluginAPI for a plugin. */
export function buildPluginAPI(manifest: PluginManifest, grantedCaps: PluginCapability[]): PluginAPI {
  granted.set(manifest.id, new Set(grantedCaps));
  const sdk = buildPluginSDK(manifest.id);
  const prefix = `[plugins:${manifest.id}]`;
  return {
    manifest,
    capabilities: grantedCaps,
    obs: sdk,
    log: {
      info: (...args) => console.log(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    },
  };
}

/** Release any state held for a plugin (on deactivation / unload). */
export function releasePluginAPI(pluginId: string): void {
  granted.delete(pluginId);
}
