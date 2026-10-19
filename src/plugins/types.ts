/**
 * Plugin SDK — typed contracts for openBIMstudio plugins.
 *
 * A plugin is a runtime-loaded JavaScript module that extends the platform
 * without recompiling the host. Plugins live in `public/plugins/<name>/`
 * and are discovered by `loader.ts` via a `plugin.json` manifest.
 *
 * ## Lifecycle
 *
 *   1. Host boots, services register, viewport ready.
 *   2. Host fetches `/plugins/index.json` → list of plugin names.
 *   3. For each plugin: fetch `<name>/plugin.json` → `PluginManifest`.
 *   4. Validate manifest (schema version, capabilities, dependencies).
 *   5. Load `<name>/index.js` as a classic script (not ES module — keeps
 *      the plugin runtime sandbox-friendly and bundler-agnostic).
 *   6. Plugin registers itself via `window.__obsRegisterPlugin(manifest, factory)`.
 *   7. Host calls `factory(api)` → plugin receives `obs.*` API handle.
 *   8. Plugin runs `activate()`, registers UI / commands / hooks.
 *   9. On host teardown or plugin disable, `deactivate()` is called.
 *
 * ## Capabilities
 *
 * Plugins declare capabilities in the manifest. The host grants only the
 * capabilities declared — deny-by-default. This is not a security sandbox
 * (classic scripts share the DOM), but it is a permission contract that
 * makes audit and review tractable.
 *
 * ## Versioning
 *
 * `sdkVersion` follows semver. Plugins must declare the major version they
 * were authored against; host refuses to load plugins requiring an incompatible
 * major version. Minor/patch are forward-compatible.
 */

/** Semantic version triple. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Capabilities a plugin may request. Deny-by-default. */
export type PluginCapability =
  | "authoring.read"       // read authored elements (walls, doors, etc.)
  | "authoring.write"      // create / modify / delete authored elements
  | "selection.read"       // observe current selection
  | "selection.write"      // modify selection
  | "camera.read"          // read camera state
  | "camera.write"         // move camera, fit, screenshot
  | "clash.read"           // read clash results
  | "clash.write"          // run clash detection, modify scenarios
  | "issues.read"          // read BCF issues
  | "issues.write"         // create / modify / export BCF issues
  | "schedules.read"       // read schedule definitions and rows
  | "schedules.write"      // create / modify schedules
  | "cost.read"            // read cost items and quantities
  | "cost.write"           // modify cost data
  | "family.read"          // list / inspect families
  | "family.write"         // register / modify families
  | "ifc.read"             // read IFC entities (fragments)
  | "ifc.write"            // export / mutate IFC
  | "ui.panel"             // register dockable panels
  | "ui.command"           // register commands in palette
  | "ui.ribbon"            // register ribbon tabs / buttons
  | "ui.context-menu"      // register viewport context-menu actions
  | "ui.notification"      // show toast / status notifications
  | "fs.local"             // read / write IndexedDB / OPFS (sandboxed to plugin namespace)
  | "network.fetch"         // make outbound HTTP requests (CORS still applies)
  | "worker.spawn"          // spawn Web Workers
  | "*";                   // wildcard — only for trusted / built-in plugins

/** Manifest declaring plugin identity, capabilities, and entry point. */
export interface PluginManifest {
  /** Globally unique plugin id, lowercase kebab-case. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semantic version of the plugin itself. */
  version: string;
  /** Author / maintainer. */
  author?: string;
  /** Short description, max ~140 chars. */
  description?: string;
  /** Plugin SDK major version this plugin was authored against. */
  sdkVersion: number;
  /** Capabilities requested. Host grants only these. */
  capabilities: PluginCapability[];
  /** Other plugin ids this plugin depends on, if any. */
  dependencies?: string[];
  /** Optional URL of a help / docs page. */
  homepage?: string;
  /** Optional license SPDX identifier, e.g. "MIT". */
  license?: string;
  /**
   * Entry-point script, relative to the plugin directory. Defaults to
   * `index.js`. The script must call `window.__obsRegisterPlugin(...)`
   * synchronously or within the same tick.
   */
  entry?: string;
}

/** Plugin factory — receives the SDK API and returns a plugin instance. */
export type PluginFactory = (api: PluginAPI) => PluginInstance | Promise<PluginInstance>;

/** Plugin instance returned by the factory. */
export interface PluginInstance {
  /** Called once after registration; safe to register UI / commands here. */
  activate(): void | Promise<void>;
  /** Called on host teardown or plugin disable; cleanup listeners, panels, workers. */
  deactivate(): void | Promise<void>;
  /** Optional handler for project open / switch events. */
  onProjectChange?(projectId: string | null): void;
}

/** Subset of services exposed to plugins, gated by declared capabilities. */
export interface PluginAPI {
  /** Plugin's own manifest, as validated by the host. */
  manifest: PluginManifest;
  /** Capabilities granted by the host (subset of requested). */
  capabilities: PluginCapability[];

  /** Stable `obs.*` namespace — see PluginSDK interface. */
  obs: PluginSDK;

  /** Logger scoped to this plugin. */
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

/** The stable SDK surface plugins consume. Versioned via sdkVersion. */
export interface PluginSDK {
  /** SDK version triple. */
  readonly version: SemVer;

  /** Host application version string, e.g. "0.55.0". */
  readonly hostVersion: string;

  /** Authoring service — gated by `authoring.read` / `authoring.write`. */
  authoring: PluginAuthoringAPI;

  /** Selection service — gated by `selection.read` / `selection.write`. */
  selection: PluginSelectionAPI;

  /** Camera service — gated by `camera.read` / `camera.write`. */
  camera: PluginCameraAPI;

  /** Clash service — gated by `clash.read` / `clash.write`. */
  clash: PluginClashAPI;

  /** Issues (BCF) service — gated by `issues.read` / `issues.write`. */
  issues: PluginIssuesAPI;

  /** Schedules service — gated by `schedules.read` / `schedules.write`. */
  schedules: PluginSchedulesAPI;

  /** Cost / quantity service — gated by `cost.read` / `cost.write`. */
  cost: PluginCostAPI;

  /** Family library — gated by `family.read` / `family.write`. */
  family: PluginFamilyAPI;

  /** IFC fragments — gated by `ifc.read` / `ifc.write`. */
  ifc: PluginIfcAPI;

  /** UI registration — gated by `ui.panel` / `ui.command` / `ui.ribbon` / `ui.context-menu`. */
  ui: PluginUIAPI;

  /** Notifications — gated by `ui.notification`. */
  notify: PluginNotifyAPI;

  /** Local storage — gated by `fs.local`. */
  storage: PluginStorageAPI;

  /** Network — gated by `network.fetch`. */
  fetch: typeof fetch;

  /** Spawn a Web Worker — gated by `worker.spawn`. */
  spawnWorker(scriptUrl: string, options?: { name?: string }): Worker;
}

// ─── Per-service plugin API surfaces (deliberately smaller than the
//     internal ServiceMap — only what third-party plugins need) ──────────

export interface PluginAuthoringAPI {
  getElements(): unknown[];
  getElementById(id: string): unknown | null;
  createElement(type: string, params: Record<string, unknown>, hostId?: string): string | null;
  updateElement(id: string, patch: Record<string, unknown>): boolean;
  deleteElement(id: string): boolean;
  onChange(cb: () => void): () => void;
}

export interface PluginSelectionAPI {
  snapshot(): Record<string, number[]>;
  size(): number;
  replace(map: Record<string, number[]>): void;
  clear(): void;
  onChange(cb: () => void): () => void;
}

export interface PluginCameraAPI {
  fitAll(): void;
  focusOnBox(box: { min: [number, number, number]; max: [number, number, number] }): void;
  screenshot(opts?: { width?: number; height?: number; format?: "png" | "jpeg" }): void;
  setProjection(mode: "perspective" | "orthographic"): boolean;
}

export interface PluginClashAPI {
  getScenarios(): unknown[];
  getResults(scenarioId: string): unknown[];
  runScenario(scenarioId: string): Promise<unknown>;
}

export interface PluginIssuesAPI {
  list(): unknown[];
  create(issue: Record<string, unknown>): string | null;
  update(id: string, patch: Record<string, unknown>): boolean;
  exportBCF(): Promise<Blob>;
}

export interface PluginSchedulesAPI {
  list(): unknown[];
  create(schedule: Record<string, unknown>): string | null;
  getRows(scheduleId: string): unknown[];
  exportCSV(scheduleId: string): Promise<Blob>;
}

export interface PluginCostAPI {
  getItems(): unknown[];
  getQuantities(elementId?: string): unknown;
  exportTakeoff(): Promise<Blob>;
}

export interface PluginFamilyAPI {
  list(): unknown[];
  get(id: string): unknown | null;
  create(family: Record<string, unknown>): string | null;
  buildGeometry(familyId: string, params: Record<string, unknown>): unknown;
}

export interface PluginIfcAPI {
  getModels(): unknown[];
  getEntities(modelId: string, ifcClass?: string): unknown[];
  exportIFC(modelIds?: string[]): Promise<Blob>;
}

export interface PluginUIAPI {
  registerPanel(id: string, definition: PluginPanelDefinition): void;
  unregisterPanel(id: string): void;
  registerCommand(command: PluginCommand): void;
  unregisterCommand(id: string): void;
  registerRibbonTab(tab: PluginRibbonTab): void;
  unregisterRibbonTab(id: string): void;
  registerContextMenuAction(action: PluginContextMenuAction): void;
  unregisterContextMenuAction(id: string): void;
}

export interface PluginPanelDefinition {
  id: string;
  title: string;
  icon?: string;
  render(container: HTMLElement): void;
  destroy?(): void;
}

export interface PluginCommand {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  hint?: string;
  run(): void | Promise<void>;
}

export interface PluginRibbonTab {
  id: string;
  label: string;
  order?: number;
  buttons: Array<{
    id: string;
    label: string;
    icon?: string;
    run(): void | Promise<void>;
  }>;
}

export interface PluginContextMenuAction {
  id: string;
  label: string;
  /** Return true to show this action for the current context. */
  available?(context: { elementType?: string; selectionSize: number }): boolean;
  run(): void | Promise<void>;
}

export interface PluginNotifyAPI {
  info(message: string, opts?: { duration?: number }): void;
  success(message: string, opts?: { duration?: number }): void;
  warn(message: string, opts?: { duration?: number }): void;
  error(message: string, opts?: { duration?: number }): void;
}

export interface PluginStorageAPI {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// ─── Registration bridge ────────────────────────────────────────────────

/**
 * Bridge function injected by the host before each plugin's script loads.
 * Plugins call this to register their factory; the host then activates them.
 *
 *   window.__obsRegisterPlugin(manifest, factory)
 */
export type PluginRegisterFn = (
  manifest: PluginManifest,
  factory: PluginFactory,
) => void;

declare global {
  interface Window {
    __obsRegisterPlugin?: PluginRegisterFn;
    __obsPluginRegistry?: Map<string, { manifest: PluginManifest; factory: PluginFactory }>;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Parse a semver string like "1.2.3" into a SemVer triple. */
export function parseSemver(s: string): SemVer | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** True if `host` semver is compatible with `required` (same major, >= minor). */
export function isSemverCompatible(host: SemVer, required: SemVer): boolean {
  if (host.major !== required.major) return false;
  if (host.minor < required.minor) return false;
  return true;
}

/** Validate a manifest object; returns `null` if valid, error message otherwise. */
export function validateManifest(m: unknown): string | null {
  if (!m || typeof m !== "object") return "manifest must be an object";
  const o = m as Partial<PluginManifest>;
  if (!o.id || typeof o.id !== "string") return "manifest.id must be a non-empty string";
  if (!/^[a-z][a-z0-9-]*$/.test(o.id)) return "manifest.id must be lowercase kebab-case";
  if (!o.name || typeof o.name !== "string") return "manifest.name must be a non-empty string";
  if (!o.version || typeof o.version !== "string") return "manifest.version must be a string";
  if (!parseSemver(o.version)) return "manifest.version must be semver (e.g. 1.0.0)";
  if (typeof o.sdkVersion !== "number" || o.sdkVersion < 1) return "manifest.sdkVersion must be a positive integer";
  if (!Array.isArray(o.capabilities)) return "manifest.capabilities must be an array";
  return null;
}
