# openBIMstudio Plugin SDK

> Build browser-native extensions that run inside openBIMstudio without recompiling the host.

The Plugin SDK lets third-party developers extend the platform with custom commands, panels, clash rules, family generators, and more. Plugins are discovered at runtime from `public/plugins/<id>/`, validated against a typed manifest, and granted only the capabilities they declare.

## Quick Start

### 1. Create the plugin directory

```
public/plugins/my-plugin/
├── plugin.json     ← manifest
└── index.js         ← entry script
```

### 2. Write the manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "sdkVersion": 1,
  "capabilities": ["authoring.read", "ui.command", "ui.notification"],
  "description": "Does something useful.",
  "author": "Your Name",
  "license": "MIT"
}
```

### 3. Write the entry script

```js
(function () {
  if (!window.__obsRegisterPlugin) return;

  window.__obsRegisterPlugin(
    {
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      sdkVersion: 1,
      capabilities: ["authoring.read", "ui.command", "ui.notification"],
    },
    function (api) {
      const { obs, log } = api;

      return {
        activate() {
          log.info("Activated");
          obs.ui.registerCommand({
            id: "my-plugin.run",
            label: "Run My Plugin",
            run: () => {
              const elements = obs.authoring.getElements();
              obs.notify.success(`Found ${elements.length} element(s).`);
            },
          });
        },
        deactivate() {
          obs.ui.unregisterCommand("my-plugin.run");
        },
      };
    }
  );
})();
```

### 4. Register the plugin in the index

Edit `public/plugins/index.json` and add `"my-plugin"` to the array. On next boot, the host will discover and load your plugin.

## Manifest Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Lowercase kebab-case unique id. Must match the directory name. |
| `name` | string | yes | Human-readable display name. |
| `version` | string | yes | Semantic version (`MAJOR.MINOR.PATCH`). |
| `sdkVersion` | number | yes | Plugin SDK major version (currently `1`). |
| `capabilities` | `PluginCapability[]` | yes | List of capabilities requested. Deny-by-default. |
| `description` | string | no | Short description, max ~140 chars. |
| `author` | string | no | Author or maintainer. |
| `license` | string | no | SPDX identifier (e.g. `MIT`). |
| `homepage` | string | no | URL of help / docs page. |
| `dependencies` | `string[]` | no | Other plugin ids this plugin depends on. |
| `entry` | string | no | Entry script, defaults to `index.js`. |

## Capabilities

Capabilities are deny-by-default. The host grants only the capabilities declared in the manifest. Calling an API method without the matching capability throws an `Error` with a clear message.

| Capability | Grants access to |
|---|---|
| `authoring.read` | `obs.authoring.getElements()`, `getElementById()`, `onChange()` |
| `authoring.write` | `obs.authoring.createElement()`, `updateElement()`, `deleteElement()` |
| `selection.read` | `obs.selection.snapshot()`, `size()`, `onChange()` |
| `selection.write` | `obs.selection.replace()`, `clear()` |
| `camera.read` | (currently informational; reserved for future camera-state reads) |
| `camera.write` | `obs.camera.fitAll()`, `focusOnBox()`, `screenshot()`, `setProjection()` |
| `clash.read` | `obs.clash.getScenarios()`, `getResults()` |
| `clash.write` | `obs.clash.runScenario()` |
| `issues.read` | `obs.issues.list()`, `exportBCF()` |
| `issues.write` | `obs.issues.create()`, `update()` |
| `schedules.read` | `obs.schedules.list()`, `getRows()`, `exportCSV()` |
| `schedules.write` | `obs.schedules.create()` |
| `cost.read` | `obs.cost.getItems()`, `getQuantities()`, `exportTakeoff()` |
| `cost.write` | (reserved for future cost mutations) |
| `family.read` | `obs.family.list()`, `get()`, `buildGeometry()` |
| `family.write` | `obs.family.create()` |
| `ifc.read` | `obs.ifc.getModels()`, `getEntities()` |
| `ifc.write` | `obs.ifc.exportIFC()` |
| `ui.panel` | `obs.ui.registerPanel()`, `unregisterPanel()` |
| `ui.command` | `obs.ui.registerCommand()`, `unregisterCommand()` |
| `ui.ribbon` | `obs.ui.registerRibbonTab()`, `unregisterRibbonTab()` |
| `ui.context-menu` | `obs.ui.registerContextMenuAction()`, `unregisterContextMenuAction()` |
| `ui.notification` | `obs.notify.info()`, `success()`, `warn()`, `error()` |
| `fs.local` | `obs.storage.get()`, `set()`, `remove()`, `keys()` |
| `network.fetch` | `obs.fetch()` (browser `fetch` passthrough; CORS still applies) |
| `worker.spawn` | `obs.spawnWorker(scriptUrl)` |
| `*` | Wildcard — grants all of the above. Reserved for trusted built-in plugins. |

## Plugin Lifecycle

```
Host boot
  │
  ├── Services register (selection, authoring, camera, clash, …)
  ├── Viewport ready
  └── setupPluginSystem() called
        │
        ├── fetch /plugins/index.json → ["ifc-validator", "csv-takeoff", …]
        ├── For each id:
        │     ├── fetch <id>/plugin.json → manifest
        │     ├── Validate manifest (id format, semver, sdkVersion, capabilities)
        │     ├── Inject window.__obsRegisterPlugin bridge
        │     ├── Load <id>/index.js as a <script> tag
        │     ├── Plugin calls window.__obsRegisterPlugin(manifest, factory)
        │     ├── Host calls factory(api) → PluginInstance
        │     ├── Host calls instance.activate()
        │     └── Plugin registers UI, commands, listeners
        │
        └── On beforeunload: instance.deactivate() for each plugin
```

## Plugin Instance Contract

```ts
interface PluginInstance {
  activate(): void | Promise<void>;
  deactivate(): void | Promise<void>;
  onProjectChange?(projectId: string | null): void;
}
```

- `activate()` is called once after registration. Register UI elements, attach listeners, spawn workers here.
- `deactivate()` is called on host teardown or plugin unload. Clean up DOM nodes, listeners, workers.
- `onProjectChange()` is optional; called when the user switches projects.

## Plugin API Surface

The `api` object passed to the factory:

```ts
interface PluginAPI {
  manifest: PluginManifest;       // The plugin's own manifest
  capabilities: PluginCapability[]; // Capabilities granted by host (subset of requested)
  obs: PluginSDK;                 // The stable SDK namespace
  log: {                          // Plugin-scoped logger
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}
```

The `obs` namespace is versioned (currently `1.0.0`) and forward-compatible within a major version.

## Example Plugins

Five real plugins ship with the host, demonstrating the SDK contract:

| Plugin | Capabilities | What it demonstrates |
|---|---|---|
| `hello` | `ui.command`, `ui.notification` | Minimum-viable lifecycle. Adds a "Hello from Plugin" command. |
| `ifc-validator` | `ifc.read`, `ui.command`, `ui.notification` | Reads IFC entities, scans for missing GlobalIds, duplicates, unit inconsistencies. |
| `csv-takeoff` | `cost.read`, `authoring.read`, `ifc.read`, `ui.command` | Aggregates quantities across authored + IFC entities, exports CSV via browser download. |
| `family-from-csv` | `family.read`, `family.write`, `ui.command` | Builds a parametric family from a CSV type catalog; mirrors BIM's type-catalog pattern. |
| `clash-rule-pack` | `clash.read`, `clash.write`, `authoring.read`, `ifc.read` | Registers three custom clash scenarios: hard clearance, soft clearance, duplicate detection. |
| `element-counter` | `authoring.read`, `selection.read`, `ui.panel` | Dockable panel that live-updates as the user authors elements. |

## SDK Versioning

The SDK follows semver:

- **Major** (`sdkVersion` in manifest): breaking API changes. Plugins requiring a different major version are refused.
- **Minor**: backwards-compatible API additions. Plugins work across minor versions.
- **Patch**: bug fixes.

The current SDK version is `1.0.0`. The host refuses to load plugins whose `sdkVersion` does not match the host's major.

## Capabilities Audit

The host prints the granted capabilities for each plugin on boot:

```
[plugins] ✓ loaded ifc-validator v1.0.0 (4 caps)
[plugins] ✓ loaded csv-takeoff v1.0.0 (6 caps)
[plugins] ✓ loaded family-from-csv v1.0.0 (5 caps)
[plugins] ✓ loaded clash-rule-pack v1.0.0 (6 caps)
[plugins] ✓ loaded element-counter v1.0.0 (4 caps)
[plugins] ✓ loaded hello v1.0.0 (2 caps)
[plugins] 6/6 plugin(s) active
```

Capability failures are visible in the console:

```
[plugins:csv-takeoff] capability "issues.write" not granted.
Add it to your plugin.json capabilities array.
```

## Security Notes

This is **not** a security sandbox. Plugins run as classic `<script>` tags in the host page and share the DOM. The capability system is a permission contract that:

1. Makes the plugin's intended scope explicit (audit-friendly).
2. Lets the host refuse capabilities the manifest didn't declare.
3. Surfaces unintended access in the console for review.

Future hardening (WASM sandbox, iframe realm, CSP) will layer on top without changing the manifest contract.

## Debugging

- Set `localStorage.debug = "plugins:*"` to enable verbose loader logs.
- Call `window.__obsPluginRegistry?.entries()` from the console to inspect registered factories.
- Check `window.__obsPlugins` (Map) for registered UI elements (panels, commands, ribbon tabs, context-menu actions).

## Roadmap

The Plugin SDK v1.0 is the foundation. Planned additions:

- **Marketplace registry**: `/plugins/marketplace/<id>` discovery + install.
- **WASM sandbox**: plugins compiled to WASM with capability-enforced host calls.
- **Hot-reload**: file-watch based re-activation during development.
- **Plugin settings UI**: typed settings schema + auto-generated panel.

## Contributing

Contributions to the SDK itself (types, loader, API surface) should follow the existing `modules/families/` pattern: types in `types.ts`, host adapter in `api.ts`, lifecycle in `loader.ts` + `boot.ts`, documentation in this file.
