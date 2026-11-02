# openBIM NWC Bridge

Converts Autodesk Navisworks files (`.nwc` / `.nwd` / `.nwf`) into **IFC** on
your own PC so openBIMstudio can link them — no cloud upload, no APS
credentials, no manual re-exporting.

## Why a bridge is needed

`.nwc`/`.nwd` are closed binary formats that no browser engine can decode, and
**Navisworks has no built-in IFC export** (Autodesk confirms this in their
support knowledge base). The conversion is therefore performed by the **free,
MIT-licensed [BIMCamel IFC exporter](https://github.com/mrshoma99-rgb/bimcamel-ifc-exporter)
plug-in running inside your installed Navisworks Manage or Simulate
(2024–2027)**. The bridge automates the file hand-off around that plug-in.

```
openBIMstudio (browser) ── 127.0.0.1:8424 ──► bridge ──► Navisworks + BIMCamel
        ▲                                          │
        └──────────── IFC back to the app ◄────────┘
```

## One-time setup

1. **Navisworks Manage or Simulate 2024–2027** — already installed (required).
2. **BIMCamel IFC exporter** (free, MIT):
   download `BIMCamelSetup.exe` from the project's releases page and install
   it (a `/silent` switch is available). It installs per-user under
   `%AppData%\Autodesk\ApplicationPlugins`.
3. **Node.js 18+** — already needed by openBIMstudio's local tooling.
4. Start the bridge: double-click `start-bridge.cmd`
   (or `node openbim-nwc-bridge.mjs`).

## Daily use

In openBIMstudio: **Insert ▸ BIM / Navisworks…** and pick your `.nwc`,
`.nwd` or `.nwf`. The app detects the bridge, sends the file, opens it in
Navisworks, and waits for the export:

1. In the Navisworks window that just opened: **BIMCamel ▸ IFC exporter**.
2. Save the IFC **into the folder shown by the app** (the app shows the exact
   path with *Copy* and *Open folder* buttons).
3. The IFC appears in openBIMstudio automatically and federates like any
   other IFC link (positioning, Manage Links, clash, properties all work).

Optional **zero-click mode**: if you build BIMCamel's headless harness from
its MIT repository (`tests/HeadlessExport` — requires the .NET SDK), place
`BIMCamelHeadlessRunner.exe` next to `BIMCamelHeadlessExport.dll` under
`%USERPROFILE%\bimcamel-ifc-exporter\out\runner` + `out\harness`. The bridge
then converts headlessly with no Navisworks window at all.

## Security

- Listens on **127.0.0.1 only**; the `Host` header must be loopback.
- Browser access is gated by an origin allow-list: all `localhost`/`127.0.0.1`
  ports are allowed; for the **deployed** openBIMstudio site, add its origin
  to `obs-bridge-origins.json` next to this script, e.g.:
  `["https://your-site.example"]`
- Uploaded files live in `%AppData%\openBIMstudio\navisworks-bridge\jobs`
  and are deleted with the job (TTL 30 min, manual cancel, 10-min purge after
  completion). Files never leave the machine.

## Endpoints (all JSON unless streaming)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/openbim-bridge/health` | capability probe (Navisworks + exporter detection) |
| POST | `/openbim-bridge/jobs` | create a job (`x-file-name` header, octet-stream body) |
| GET | `/openbim-bridge/jobs/:id` | job status (state, message, IFC list) |
| GET | `/openbim-bridge/jobs/:id/ifc/:name` | download one produced IFC |
| POST | `/openbim-bridge/jobs/:id/reveal` | open the export folder in Explorer |
| DELETE | `/openbim-bridge/jobs/:id` | cancel + delete the job |

## Environment overrides (testing / advanced)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OBS_BRIDGE_PORT` | `8424` | loopback port |
| `OBS_BRIDGE_WORKSPACE` | `%AppData%\openBIMstudio\navisworks-bridge\jobs` | job folders root |
| `OBS_BRIDGE_MAX_BODY` | 2 GiB | upload cap |
| `OBS_BRIDGE_PROGRAM_FILES` | `C:\Program Files\Autodesk` | Navisworks scan root |
| `OBS_BRIDGE_APPDATA` / `OBS_BRIDGE_HOME` | real values | detection roots |
| `OBS_BRIDGE_NO_LAUNCH` | off | never spawn Navisworks/Explorer (tests) |
| `OBS_BRIDGE_ORIGINS` | – | comma-separated extra allowed origins |

The same rules the tests enforce: loopback-only, sanitized names, byte caps,
stable-file detection (an IFC is only served once its size is unchanged
between two sweeps, so half-written exports are never picked up).
