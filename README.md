<p align="center">
  <img src="openBIMstudio.png" alt="OpenBIMStudio" width="960">
</p>

<div align="center">

# OpenBIMStudio

### The open, local-first BIM workspace that runs in your browser

[![GitHub stars](https://img.shields.io/github/stars/amdghedy/openBIMstudio?style=social)](https://github.com/amdghedy/openBIMstudio/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/amdghedy/openBIMstudio?style=social)](https://github.com/amdghedy/openBIMstudio/network/members)
[![GitHub watchers](https://img.shields.io/github/watchers/amdghedy/openBIMstudio?style=social)](https://github.com/amdghedy/openBIMstudio/watchers)
[![Version](https://img.shields.io/badge/version-0.74.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![IFC](https://img.shields.io/badge/IFC-2x3%20%7C%204-3b82f6.svg)](#-interoperability)
[![Runs in](https://img.shields.io/badge/runs%20in-browser-success.svg)](https://github.com/amdghedy/openBIMstudio#quick-start)
[![CI](https://github.com/amdghedy/openBIMstudio/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/amdghedy/openBIMstudio/actions/workflows/unit-tests.yml)
[![BIM validation](https://github.com/amdghedy/openBIMstudio/actions/workflows/native-bim-validation.yml/badge.svg)](https://github.com/amdghedy/openBIMstudio/actions/workflows/native-bim-validation.yml)

**Local-first · Zero install · Open standards · IFC · FRAG · BCF · IDS · PDF · drawing · AI-ready**

<p align="center">
  <a href="https://open-bi-mstudio.vercel.app"><img src="https://img.shields.io/badge/🚀_Live_demo-open--bi--mstudio.vercel.app-00C853?style=for-the-badge" alt="Live demo"></a>
  &nbsp;
  <a href="https://github.com/amdghedy/openBIMstudio"><img src="https://img.shields.io/badge/⭐_Star_this_repo-181717?style=for-the-badge&logo=github" alt="Star on GitHub"></a>
  &nbsp;
  <a href="https://github.com/amdghedy/openBIMstudio/issues/new/choose"><img src="https://img.shields.io/badge/Issues_&_ideas-open-2088FF?style=for-the-badge" alt="Open an issue"></a>
</p>

**Canonical project:** [github.com/amdghedy/openBIMstudio](https://github.com/amdghedy/openBIMstudio) · **Live app:** [open-bi-mstudio.vercel.app](https://open-bi-mstudio.vercel.app)

[Quick start](#quick-start) · [Why OpenBIMStudio](#-why-openbimstudio) · [What you can do](#-what-you-can-do) · [All tools & commands](#tools--commands) · [Interoperability](#-interoperability) · [Documentation](#-documentation) · [Contributing](CONTRIBUTING.md)

<p align="center">
  <a href="https://www.buildingsmart.org/"><img src="https://img.shields.io/badge/IFC-2x3%20%7C%204-0096D6?style=for-the-badge" alt="IFC — Industry Foundation Classes"></a>
  <a href="https://thatopen.com/"><img src="https://img.shields.io/badge/That%20Open-web--ifc%20·%20Fragments-7C3AED?style=for-the-badge" alt="That Open"></a>
  <a href="https://threejs.org/"><img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=white" alt="Three.js"></a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/React-18-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/MUI-007FFF?style=flat-square&logo=mui&logoColor=white" alt="MUI">
  <img src="https://img.shields.io/badge/LibreDWG-WASM-2D7D9A?style=flat-square" alt="LibreDWG">
  <img src="https://img.shields.io/badge/Yjs-CRDT-4B7BE5?style=flat-square" alt="Yjs">
</p>

</div>

---

## What is OpenBIMStudio?

OpenBIMStudio is a **browser-based, local-first BIM workspace** for architecture, engineering, and construction. It combines model authoring, multi-model federation, clash detection, BCF issue exchange, sheet production, and validation around open standards and a self-hosted local workflow.

One install (none, actually — it's your browser). One license (MIT — yours). Your model data stays on your machine by default.

> **Latest release ([v0.74.0](https://github.com/amdghedy/openBIMstudio/releases/tag/v0.74.0)):** internationalization foundation — a region-profile service covering 20 countries (units, currency, paper sizes, date formats), 19 UI locales with browser auto-detection, and machine-checkable GCC building-code rule packs (UAE FSC 2018 / SBC 201 / Dubai Build accessibility). Release notes: [Releases](https://github.com/amdghedy/openBIMstudio/releases) · [CHANGELOG.md](CHANGELOG.md).

| For you if you… | OpenBIMStudio helps by… |
|-----------------|-------------------------|
| Need a free / open alternative for BIM | Full authoring + coordination workspace, MIT license, IFC-native |
| Coordinate multi-discipline models | Federation, worker-based clash detection, BCF issues, Copy/Monitor |
| Produce plans and sheets | Views, auto-dimension chains, tags, sheets with title blocks, PDF export |
| Validate deliverables | IDS requirements, native model QA, rule packs, model health diagnostics |
| Prefer open data | IFC, BCF, IDS, DXF, CSV, PDF — no proprietary lock-in, ever |

> **Status:** OpenBIMStudio is under active development and maturity varies by feature. Each capability is rated *verified*, *limited*, *experimental*, *planned* or *unavailable*, with its known limitations, in the app under **User Interface -> Feature Status** (source: `src/features/feature-maturity.ts`). See also [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for file-format support, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is organised, and the [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md).
>
> Not decodable in a browser: LAZ, E57, RCP/RCS, RWCX and FLS point clouds (export to LAS first); Native DWG export from the drawing editor is experimental and uses a local MPL-2.0 acadrust WASM writer; unsupported content is rejected rather than silently dropped.

---

## 🚀 Why OpenBIMStudio

|  |  |
|---|---|
| 💰 **Free, forever** | MIT license. No seats, no subscriptions, no paywalled features. An integrated BIM workflow built around open standards. |
| 🌐 **Zero install** | The whole platform runs in the browser tab you already have open. Clone it for local use — no drivers, no licensing daemons, no installers. |
| 🔐 **Local-first & private** | Models stay on your machine by default. Cloud AI and collaboration are **opt-in and self-configured** — bring your own keys, point at your own server. |
| 🏗️ **Authoring to delivery in one app** | Walls to rebar, clash to BCF, views to sheets to PDF, quantities to cost, phasing to 4D. No stitching together five tools. |
| 🔓 **Open standards, no lock-in** | IFC 2x3/4, BCF, IDS, DXF, CSV, PDF. Your data is never hostage to a vendor. |
| 🤖 **Automate & extend** | Event-driven automation rules, an AI assistant (bring your own provider key), a plugin SDK with capability gating, and a sample plugin marketplace. |
| ✅ **Evidence-based engineering** | 117 focused test suites run in CI on every push, a public per-tool maturity catalogue, and documented known limitations. |
| 🧠 **Modern modeling engine** | Justification lines, magnetic snapping, constraint solving, parametric families with formulas, and deep authoring workflows. |

---

## Quick start

### Option A — Run locally (recommended)

```bash
# Requirements: Node.js 18+
git clone https://github.com/amdghedy/openBIMstudio.git
cd openBIMstudio
npm install
npm run dev
```

Open the URL shown in the terminal (usually **http://localhost:3000**).

### Option B — Production build

```bash
npm run build
npm run preview
```

### Deploy to Cloudflare Workers (with visit counter)

Pushes to `main` deploy automatically through the `deploy.yml` GitHub Action (`wrangler deploy`). The worker in `worker/index.ts` serves `dist/` and exposes the cumulative visit counter shown in the Project Center status bar (`POST/GET /api/visits`), backed by a SQLite Durable Object created automatically on deploy.

To deploy manually instead:

```bash
npm run deploy
```

### First 2 minutes in the app

1. The **BIM Command Center** opens (or click the blue **RC** button bottom-left).
2. Use **Import** to load an IFC model, or start modeling with **Wall / Door / Room**.
3. Press **Ctrl+P** to search any command (e.g. `Clash`, `Sheet`, `Schedule`).
4. Select elements → inspect **Properties** → try **Hide / Isolate**.

---

## 🎯 What you can do

### View & navigate
- 3D viewport (perspective & orthographic)
- Orbit, pan, zoom, fit, focus on selection
- **ViewCube** navigation (faces, edges, corners, Home menu, 90° orbit steps)
- Section planes & section boxes
- Hide / isolate / category visibility
- Measure, temporary dimensions, snapping
- Saved views, model tree, properties panel
- drawing & PDF underlays, point cloud viewing

### Model (architecture)
- Walls (including layered / compound), floors, roofs, ceilings
- Doors & windows (host-aware openings)
- Levels, grids (with bubbles), rooms & areas
- Stairs (straight, L, U, winder, spiral), railings, ramps
- Curtain walls, materials, reference planes, work planes
- Groups, design options, phases
- Parametric families (formulas, constraints, nested, arrays)
- In-place massing, wall sweeps, model curves

### Model (structure & MEP)
- Beams, braces, trusses, footings, foundations
- **Rebar** modeling
- Ducts, pipes, cable trays, conduits — with pressure & connectivity checks
- Routing, fittings (elbow geometry), fabrication parts
- **MEP Design Toolkit** — parametric calculators: Hunter fixture-unit demand, sprinkler density/area hydraulics, voltage drop & conductor check, pipe/duct insulation heat loss + condensation screening + takeoff, ASHRAE round↔rect duct equivalents, air-changes airflow, Joukowsky water-hammer surge, unit conversions
- **Sprinkler system** — fire piping joins the sizing/color/routing systems
- P&ID-related workflows
- Analytical / structural model export paths, structural loads & connections

### Site & terrain
- Toposurfaces & site topology
- Building pads, property lines, site components

### Analyze
- Energy analysis paths
- Daylighting studies
- Sun settings & orientation

### Coordinate
- Load and align **multiple models** (federation)
- Clash detection (several methods, worker-based)
- Clash scenarios, grouping, status tracking
- **BCF** import/export for issues
- Copy / Monitor relationships
- Worksets & linked-model management

### Document
- Plans, sections, elevations, RCPs, details, plan regions
- Dimensions (linear, aligned, angular, radial, spot…) and **auto dimension chains**
- Tags (elements, rooms, materials), keynotes
- Sheets, viewports, title blocks, revisions, matchlines
- View templates, view filters & graphic overrides, filled regions, detail components, hatch patterns
- **PDF** export · drawing import/export paths · PDF underlay

### Quantify & plan
- Schedules and quantity take-off
- Cost items mapped from quantities (5D)
- CSV export
- 4D timeline / phasing simulation

### Check quality
- **IDS** information requirements
- Native BIM validation (IDs, hosts, geometry, sheets…)
- Rule packs (accessibility, fire, QA, structural review)
- Model health diagnostics

### Automate & extend
- Automation rules on model events
- AI assistant (optional providers — your keys, your choice)
- Plugin SDK with capability gating + plugin marketplace
- Sample plugins included: element counter, CSV take-off, clash rule pack, family-from-CSV
- Optional collaboration server (presence, worksharing concepts) — auth & hardening built in

---

## Tools & commands

Use the **ribbon**, **bottom toolbar**, **Command Center (RC)**, or **Ctrl+P** command palette.

### Project & files

| Command | What it does |
|---------|----------------|
| New / Open Project | Create or open a project |
| Project Browser | Browse projects and data |
| Project Information | Project metadata |
| Import / Export | Load or write supported files (IFC, DXF, and more) |
| Manage Links | Linked models, reload, transforms |
| Federation | Multi-model coordination workspace |
| Save View | Store camera / view state |

### Viewport

| Command | What it does |
|---------|----------------|
| Select / Multi-select / Box Select | Select elements |
| Orbit / Pan / Zoom / Fit / Focus | Navigate |
| Section / Section Box | Cut through the model |
| Hide / Isolate / Reset Visibility | Control what you see |
| Category Visibility | Show/hide by category |
| Measure / Temp Dimensions | Measure distances |
| Snapping / Transform Gizmo | Precise placement and edits |
| LOD Controls | Level of detail |
| Model Health | Diagnostics |

### Create & modify

| Command | What it does |
|---------|----------------|
| Wall / Floor / Roof / Ceiling | Building elements |
| Door / Window | Hosted openings |
| Levels / Grids | Datum references |
| Rooms / Areas | Spatial elements |
| Stairs / Railings / Ramps / Curtain Wall | Vertical circulation & facades |
| Structural Members / Rebar | Beams, braces, foundations, reinforcement |
| Ducts / Pipes / Trays / Conduits | MEP runs with fittings |
| Toposurface / Building Pad / Property Line | Site & terrain |
| Materials / Shared Parameters / Type Catalog | Data & appearance |
| Family Browser / Parametric Editor | Families & formulas |
| Move / Copy / Rotate / Mirror / Array | Transforms |
| Align / Distribute / Match Properties | Coordination edits |
| Paint / Group / Create Similar | Appearance & reuse |
| Copy / Monitor | Track linked elements |
| Phases / Design Options | Time & alternatives |

### Drawings & sheets

| Command | What it does |
|---------|----------------|
| Plan / Section / Elevation / RCP | Create views |
| Dimensions & Tags / Auto Dimensions | Annotate |
| Sheets & Viewports / Matchlines | Layout drawings |
| Title Blocks / Revisions / Keynotes | Issue control |
| View Templates / View Filters | Apply graphic standards |
| Filled Regions / Detail Components / Hatches | 2D detailing |
| Export PDF | Issue sheets |

### Coordination, QA & output

| Command | What it does |
|---------|----------------|
| Clash Detection | Find interferences |
| Clash Scenarios | Save rules & reviews |
| Issues / BCF | Track and exchange issues |
| IDS / Standards | Check information requirements |
| Validate Model | Native QA checks |
| Schedules / QTO / Cost | Quantities and estimates |
| 4D Timeline | Construction simulation |
| Energy / Daylighting / Sun Settings | Analysis paths |
| Automation Rules / AI Assistant | Automate repetitive work |

### Keyboard shortcuts (common)

| Shortcut | Action |
|----------|--------|
| **Ctrl+P** | Command palette |
| **Ctrl+Shift+R** | BIM Command Center |
| **Esc** | Cancel / clear tool |
| **Delete** | Delete selection |
| **Ctrl+Z / Ctrl+Y** | Undo / Redo (when history is active) |

### Drawing Editor (DWG/DXF) — Modify tools

The standalone Drawing Editor ribbon has a full **Modify** group with professional drafting transform tools. Select objects first (noun–verb), then run the command — or start the command and pick objects, then press **Enter / right-click** to finish the selection stage. Every transform shows a live yellow dashed ghost preview, supports osnap / ortho, numeric entry typed into the command line, and a single Undo step (Ctrl+Z).

**Multi-document workspace.** The editor opens any number of DWG/DXF files at once, one drawing per file tab (native-drawing-style tab strip with unsaved-changes dots, middle-click close, right-click tab menu with Save / Save All / Close Others / Close All, and `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle drawings). Drawings interact through **Super Copy**: `COPYCLIP` (Ctrl+C / Ctrl+Shift+C) places the selected objects on a shared cross-drawing clipboard together with the layer, linetype and text style definitions they reference, and mirrors the payload to local storage so the clipboard survives a reload and works across app windows; `PASTECLIP` (Ctrl+V / Ctrl+Shift+V) attaches the clipboard to the cursor as a ghost preview — every click drops a copy (repeatable, repeat-placement) and missing layer/linetype/style definitions are carried over into the target drawing so pasted geometry keeps its source colours, dash patterns and fonts; `PASTEORIG` (Ctrl+Alt+V) pastes at the original source coordinates — so plans, details, and legends can be assembled across files without any export/import step.

| Command | Alias | What it does |
|---------|-------|--------------|
| MOVE | `M` | Move selected objects: base point → second point (or displacement) |
| COPY | `CO` | Copy objects; keep clicking to place multiple copies, Enter to finish |
| ROTATE | `RO` | Rotate around a base point; drag the angle or type it (e.g. `45`) |
| MIRROR | `MI` | Mirror about a two-point axis; type `Y` to erase source objects, Enter keeps them |
| SCALE | `SC` | Scale about a base point; drag the factor or type it (e.g. `2`) |
| OFFSET | `O` | Parallel concentric copy: click two points (or type distance) → object → side |
| COPYCLIP | `CC` | Super Copy: copy the selection with its layer/linetype/text-style definitions to the cross-drawing clipboard (Ctrl+C / Ctrl+Shift+C) |
| PASTECLIP | — | Paste the clipboard: ghost follows the cursor, click to place, click again for another copy (Ctrl+V / Ctrl+Shift+V) |
| PASTEORIG | — | Paste the clipboard verbatim at the original source coordinates (Ctrl+Alt+V) |
| LENGTHEN | `LEN` | Stretch the end of a line/arc/polyline: click near the end and drag (live preview), or `LENGTHEN 50` for an exact total / `LENGTHEN D 5` for a delta |
| DIVIDE | `DIV` | Place point objects dividing a line/arc/polyline into N equal segments (`DIVIDE` → object → N) |
| MEASURE | `ME` | Place point objects at a fixed spacing along a line/arc/polyline |
| DDEDIT | `ED` | Edit the text content of a picked TEXT / MTEXT object from the command line |
| LAYISO / LAYUNISO | — | Isolate the layer of a picked object (hide every other layer) / restore what LAYISO hid |
| LAYOFF / LAYLCK / LAYUNLCK | — | Turn off, lock or unlock the layer of a picked object |
| MLEADER | `MLD`, `LE` | Leader annotation: arrow point → landing end → type the text |
| QSELECT | — | Quick select: `QSELECT TYPE LINE` · `QSELECT LAYER Walls` · `QSELECT ALL` |
| PEDIT | `PE` | Polyline edit on the selection: `J` join into one polyline · `C` close · `O` open · `R` reverse |
| CAL | `QC` | Calculator on the command line: `CAL 2*PI*25` — sin/cos/tan take degrees; any numeric prompt also accepts a bare expression like `3*sqrt(2)` |
| Grip editing | — | Select objects → drag the blue hotspots: line endpoints & midpoints, polyline vertices, circle/arc centers, quadrants and radii, text insertion points (Shift = ortho lock, Ctrl+Z undoes) |

While a drawing tab is active, the drawing editor owns Ctrl+Shift+C and Ctrl+Shift+V — app-level features that bind the same combos (Clash Review, View Tools Manager, Saved Views, Validation, VG dialog) stand down until you leave the drawing view; those features stay reachable from their menus.

Notes:

- OFFSET works on lines, circles, arcs and polylines with **curve-aware joins** — corners are extended/trimmed by exact intersection (desktop drafting software's offset-with-trim), shallow-angle spikes clamp to the classic 4× mitre, and a closed loop whose inset would collapse past its centroid is refused with "cannot offset that", exactly like native drawing editor. Hatch boundaries offset with their polyline.
- MIRROR keeps text readable (MIRRTEXT=0 behaviour) and handles arc sweep correctly.
- The Modify engine reuses the drawing undo stack, so `U` / Ctrl+Z reverts each operation in one step, and `REDO` / Ctrl+Y reapplies it.

### Drawing Editor — absorbed from OpenCADStudio (options & functions grab)

Functions absorbed from the OpenCADStudio project (github.com/HakanSeven12/OpenCADStudio) under their own licenses — the GPL-3.0 application code is **not** copied; only permissively-licensed parts are ported and the rest is re-implemented against public formats:

| Feature | Entry | What it does |
|---------|-------|--------------|
| Embedded DWG preview | open any DWG | The drawing's native thumbnail (extracted from the DWG preview container at byte 0x0D) is shown instantly while the full parse runs — big drawings open like native drawing editor. Also listed in the Info dialog. Ported from the MIT/Apache-2.0 `dwg-thumbnailer` crate. |
| CTB / STB plot styles | PLOT › Load CTB / STB… | Load a real standard plot style table; the plot maps every entity through it — forced pen colours, grayscale policy, screen (ink) levels and pen lineweights. Validated against ezdxf-generated fixtures. |
| BAK / SV$ recovery | open / drop a `.bak` or `.sv$` file | drawing backup and autosave files open like native drawing editor, with a "recovered from backup" note in the command line. |
| LandXML CgPoints | drop a `.xml`, or `LANDXMLIN` | Survey points import as POINT entities with name labels on a "LandXML Points" layer (north → drawing Y, east → drawing X). |
| Entity data extract | `DATAEXTRACT`, or App menu › Export Entity Data (CSV) | Every entity's handle, type, layer, colour, linetype, lineweight, text and anchor point exports to a CSV file. |
| RAY / XLINE construction lines | open any DWG/DXF | Infinite construction lines read from the file and drawn edge-to-edge like native drawing editor (clipped to the view, linetype dashes and layer colours kept, pickable everywhere along the line, they never affect ZOOM Extents), moved/copied/mirrored/rotated by their anchor and written back on DXF save. |

### Convert PDF to DWG — built into the editor (video tip)

OpenBIMStudio converts a **vector PDF** into an editable drawing natively — **PDFIN** on the command line (aliases `PDFIMPORT`, `PDF2DWG`; `PDFIN N` for page N), the **Insert tab → PDF Import → PDF to Drawing…** ribbon button, the App menu → *Convert PDF to Drawing…*, the welcome screen *Open DWG / DXF / PDF…*, or just dropping a `.pdf` onto the editor. The conversion runs **locally in the browser** — the PDF is not uploaded to the cloud, so user data stays secure — and lands as a normal drawing tab: stroked paths become LINE/LWPOLYLINE, filled areas become boundaries, text stays text (position, height, rotation), colours are kept, and the drawing opens true-size in millimetres (1 pt = 0.3528 mm). Save with **QSAVE** (DXF) or **DWGSAVE** (DWG) to complete the PDF → DWG conversion. Details and limits: `docs/PDF-IMPORT.md`.

The same workflow was popularised by the free, open-source online tool **Open CAD Studio** — watch their quick-tip video: <https://lnkd.in/dzWK2bzS>

Original announcement:

> This quick tip shows how to convert vector #PDF to #DWG drawing using free open source online tool: Open CAD Studio. The PDF is not uploaded to the cloud, so user data is secure.
> Watch the video here: https://lnkd.in/dzWK2bzS
> #OpenCADStudio is developed under the OpenAEC Foundation i.o. umbrella.
> #SPBProduction
> SPB PRODUCTION
> PDF
> DWG
> Convert PDF to DWG

### Control the engines from AI agents — the AI Agent Bridge (AlphaCLI / AlphaCode)

AI chats and agents can issue orders **directly into the engines** through the AI Agent Bridge (`AGENT` on the drawing command line, the **Agent Bridge** button in Home › AI Copilot, or `__obsAgentBridge.openPanel()` in the BIM workspace). Every order runs on the same paths a human uses — CAD strings go through the command-line dispatcher, natural language goes to the AI copilot — and lands in an audited order log on the dock. Four channels:

| Channel | Who uses it | How |
|---------|-------------|-----|
| **window API** | console, browser automation, bookmarklets | `__obsAgentBridge.exec("CIRCLE 0,0 50")` · `await __obsAgentBridge.ask("draw a gear profile")` · `state()` · `commands()` (full catalog) · `log()` / `on()` |
| **postMessage** | your platform client embedding the studio (e.g. AlphaCLI web) | `iframe.contentWindow.postMessage({ __obsAgent: true, id, type: "exec" \| "ask" \| "state" \| "commands", text }, targetOrigin)` — replies carry the same flag + `id`. Origin allow-list: same-origin + `https://alphacli.github.io` (extend via `localStorage.obs.agent.allowedOrigins`) |
| **URL deep link** | one-shot orders, chat bots that can open a URL | `…/#agent-cmd=CIRCLE%200%2C0%2050` or `…/#agent-ask=draw%20a%20site%20plan` |
| **local relay** | terminal AI agents (AlphaCLI / AlphaCode) | opt-in: **Agent Bridge → Connect Relay**, then `POST /api/agent/exec` on your local collab server; the order executes in the open studio and the HTTP response returns the result |

Terminal example (AlphaCode can run this with its shell tool once the relay is connected):

```sh
curl -s -X POST http://localhost:4000/api/agent/exec \
  -H "Authorization: Bearer $OBS_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"CIRCLE 0,0 50"}'
# → {"orderId":"…","ok":true,"state":{…}}
```

`{"ask":"…"}` sends natural language to the AI copilot instead. Privacy holds: the bridge is local-first, the relay is **opt-in** (off until you press Connect) and talks only to your own collab server — with no relay, no order ever leaves the device. The **Agent Bridge** dock also has a try-it box (Run / Ask AI) and a **Copy Snippet** button with the ready-to-paste examples above.

---

## How to use (day to day)

### 1. Open or import a model
- **Import** an IFC (or start empty and model from scratch).
- For several files: use **Federation** / **Manage Links** and align origins.

### 2. Explore
- Use the **ViewCube** (top-right of the viewport): click faces, edges or corners to jump to exact views; use the curved arrows to orbit in 90° steps (hold to repeat); right-click the cube for quick presets.
- Use the **model tree** and **properties**.
- **Isolate** a system or level; cut with a **section box**.

### 3. Author
- Place walls, doors, rooms from the **Architecture** tools or Command Center.
- Use **Match Properties**, **Align**, and **Create Similar** for speed.
- Let **justification lines** and **magnetic snapping** place elements precisely the first time.

### 4. Coordinate
- Run **Clash Detection** between disciplines.
- Create **issues** and export **BCF** to share with the team.

### 5. Document
- Create **plan/section** views → add dimensions/tags → place on **sheets** → **PDF**.

### 6. Check before issue
- Run **Validate** and **IDS** checks.
- Review schedules and quantities.

---

## 🔓 Interoperability

| Format / standard | Role | Direction |
|-------------------|------|-----------|
| **IFC 2x3 / IFC4** | Model exchange — the openBIM backbone | Import & export |
| **BCF** | Coordination issue exchange | Import & export |
| **IDS** | Information requirements checking | Validation |
| **DXF** | 2D drawing exchange | Import & export |
| **DWG** | Drawing import & link (LibreDWG WASM) | Import & link; experimental 2D drawing editor export via local acadrust WASM |
| **PDF** | Vector PDF → editable drawing (PDFIN, parsed locally) + drawing sheets issue + PDF underlay | Import (vector) & export & underlay |
| **CSV** | Schedules, take-off, cost | Import & export |
| **gbXML** | Energy-related export path | Export (where enabled) |

Some additional model formats may be accessible through separately configured conversion pipelines. Availability depends on the converter and workflow; source files are not necessarily editable in-place without a conversion process.

---

## 📚 Documentation

**Guides for users and developers** (`documentation/`):

| Guide | Audience |
|-------|----------|
| [User Guide](documentation/USER_GUIDE.md) | Setup, workflows, troubleshooting |
| [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) | Full tool list & maturity |
| [Developer Guide](documentation/DEVELOPER_GUIDE.md) | Architecture & contribution |
| [Plugin SDK](docs/PLUGIN_SDK.md) | Extensions |

**Engineering notes** (`docs/`) — the full index lives in [docs/README.md](docs/README.md):

| Guide | Topic |
|-------|-------|
| [Engineering Architecture Map](docs/engineering/ARCHITECTURE.md) | Runtime boot, domain boundaries, module inventory and data flows |
| [Engineering Baseline](docs/engineering/BASELINE.md) | Verified format boundaries, feature maturity inventory, stage evidence |
| [Authoring](docs/02-authoring.md) | Modeling & families |
| [Coordination](docs/03-coordination.md) | Clash & issues |
| [Documentation](docs/04-documentation.md) | Views & sheets |
| [Install & UX](docs/INSTALL_AND_UX.md) | UI map & smoke test |
| [Native BIM validation](docs/NATIVE_BIM_VALIDATION.md) | QA checks |

---

## For developers

```bash
npm install
npm run dev                      # development server (http://localhost:3000)
npm run typecheck                # TypeScript
npm run build                    # production build
npm run test:native-bim          # native BIM validation checks
node scripts/ci-unit-tests.mjs   # the full batched suite (what CI runs)
```

Per-version milestone checks (`npm run verify:v50` … `npm run verify:v73`) remain
available from earlier releases; run the one matching the milestone you touched.

**Stack:** React · TypeScript · Vite · Three.js · That Open (web-ifc / Fragments) · MUI · LibreDWG (WASM) · Yjs (optional real-time collaboration)

**Layout:** `src/features` (tools/UI) · `src/modules` (BIM domains — 100+ modules from authoring to 5D) · `src/commands` · `src/workers` · optional `server/` (collaboration & conversion — self-hosted and optional)

**Testing culture:** 117 focused automated suites (`npm run` and pick any `test:*`; `node scripts/ci-unit-tests.mjs` runs the whole batch), CI on every push, and per-version milestone checks. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md); for substantial changes, open an issue first and discuss the design and validation strategy.

---

## Project principles

- **Open data first:** prioritize IFC and open coordination / information-exchange standards.
- **Local-first workflow:** core development and model exploration run close to the user's machine; optional server-backed functions are configured separately and require explicit consent.
- **Traceable maturity:** source code, a visible command, an automated test, and a validated production workflow are different levels of evidence — we label which one each tool has.
- **Incremental delivery:** report limitations clearly and verify critical workflows with representative models before relying on them for issued deliverables.

## Verification & feature maturity

The repository includes focused automated checks for selected BIM and application behaviors. Run the checks relevant to your change rather than assuming one command covers the whole platform.

```bash
npm run typecheck
npm run test:native-bim
npm run test:bim-gaps
npm run test:mep
npm run test:history
npm run build
```

Not every tool has the same level of coverage. Automated tests cannot fully prove browser interaction quality, geometry fidelity, interoperability round-tripping, large-model performance, or suite-wide production readiness.

## Privacy, local data & optional services

- Review the settings and configuration for any optional AI provider, collaboration server, or connected data environment before using them with confidential project information.
- Do not commit credentials, API keys, private model files, or project-specific data to the repository.
- Local-first does not automatically mean every feature is offline-only: features that connect to a provider or server require that service and its own privacy/security review.
- Back up project data before testing migration, import/export, or experimental authoring features.

## Scope & honesty

OpenBIMStudio aims for broad **openBIM** coverage across authoring, coordination, documentation, and validation. Individual tools differ in maturity: source code or a visible command alone does not guarantee runtime reliability or production readiness.

---



---

## Support the project

OpenBIMStudio is free and MIT-licensed. The fastest way to help is:

1. **[⭐ Star the repository](https://github.com/amdghedy/openBIMstudio)** — improves discoverability on GitHub.
2. **Share the [live demo](https://open-bi-mstudio.vercel.app)** with BIM / AEC / web colleagues.
3. **[Open an issue](https://github.com/amdghedy/openBIMstudio/issues)** for bugs or ideas.
4. **[Contribute](CONTRIBUTING.md)** a fix or docs improvement.

Please link back to **https://github.com/amdghedy/openBIMstudio** (this repo is the source of truth — not forks or mirrors unless they point here).

## License

**MIT** — see [LICENSE](LICENSE).

Built around open standards: **IFC · BCF · IDS · COBie** and the wider openBIM community. Contributions, issues, and pull requests are welcome.
