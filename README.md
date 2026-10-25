<p align="center">
  <img src="openBIMstudio.png" alt="OpenBIMStudio" width="960">
</p>

<div align="center">

# OpenBIMStudio

### Build, coordinate, and document BIM models in your browser — free, local-first, open standards

[![Version](https://img.shields.io/badge/version-0.66.2-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![IFC](https://img.shields.io/badge/IFC-2x3%20%7C%204-3b82f6.svg)](#)
[![Runs in](https://img.shields.io/badge/runs%20in-browser-success.svg)](#)

**No install required for local use · Works offline · IFC · BCF · IDS · PDF · DWG**

[Quick start](#-quick-start) · [What you can do](#-what-you-can-do) · [Tools & commands](#-tools--commands) · [How to use](#-how-to-use-day-to-day) · [Docs](#-documentation)

</div>

---

## What is OpenBIMStudio?

OpenBIMStudio is a **browser-based BIM platform** for architecture, engineering, and construction.  
You can create and edit models, link several models together, find clashes, produce drawings, run checks, and export open formats — without locking your data into a proprietary file.

| For you if you… | OpenBIMStudio helps by… |
|-----------------|-------------------------|
| Need a free / open alternative for BIM | Local-first app, MIT license, IFC-based |
| Coordinate multi-discipline models | Federation, clash detection, BCF issues |
| Produce plans and sheets | Views, dimensions, tags, sheets, PDF |
| Validate deliverables | IDS, rules, native model QA |
| Prefer open data | IFC, BCF, IDS, CSV, PDF, DWG paths |

> **Note:** The platform is actively developed. Always test the exact workflow you need before using it on a formal deliverable. See the [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) for maturity details.

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

### First 2 minutes in the app

1. The **BIM Command Center** opens (or click the blue **RC** button bottom-left).
2. Use **Import** to load an IFC model, or start modeling with **Wall / Door / Room**.
3. Press **Ctrl+P** to search any command (e.g. `Clash`, `Sheet`, `Schedule`).
4. Select elements → inspect **Properties** → try **Hide / Isolate**.

---

## What you can do

### View & navigate
- 3D viewport (perspective & orthographic)
- Orbit, pan, zoom, fit, focus on selection
- Section planes & section boxes
- Hide / isolate / category visibility
- Measure, temporary dimensions, snapping
- Saved views, model tree, properties panel

### Model (architecture)
- Walls (including layered / compound), floors, roofs, ceilings
- Doors & windows (host-aware openings)
- Levels, grids, rooms & areas
- Stairs (straight, L, U, winder, spiral), railings
- Curtain walls, materials, reference planes
- Groups, design options, phases
- Parametric families (formulas, constraints, nested, arrays)

### Model (structure & MEP)
- Beams, braces, trusses, footings, foundations
- Ducts, pipes, cable trays, conduits
- Routing, fittings, fabrication-related tools
- P&ID-related workflows
- Analytical / structural model export paths

### Coordinate
- Load and align **multiple models** (federation)
- Clash detection (several methods, worker-based)
- Clash scenarios, grouping, status tracking
- **BCF** import/export for issues
- Copy / Monitor relationships

### Document
- Plans, sections, elevations, RCPs, details
- Dimensions (linear, aligned, angular, radial, spot…)
- Tags (elements, rooms, materials)
- Sheets, viewports, title blocks, revisions
- View templates & graphic overrides
- **PDF** export · CAD import/export paths

### Quantify & plan
- Schedules and quantity take-off
- Cost items mapped from quantities
- CSV export
- 4D timeline / phasing simulation

### Check quality
- **IDS** information requirements
- Native BIM validation (IDs, hosts, geometry, sheets…)
- Rule packs (accessibility, fire, QA, structural review)
- Model health diagnostics

### Automate & extend
- Automation rules on model events
- AI assistant (optional providers)
- Plugin SDK & marketplace registry
- Optional collaboration server (presence, worksharing concepts)

---

## Tools & commands

Use the **ribbon**, **bottom toolbar**, **Command Center (RC)**, or **Ctrl+P** command palette.

### Project & files

| Command | What it does |
|---------|----------------|
| New / Open Project | Create or open a project |
| Project Browser | Browse projects and data |
| Project Information | Project metadata |
| Import / Export | Load or write supported files (IFC and more) |
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
| Stairs / Railings / Curtain Wall | Vertical circulation & facades |
| Structural Members | Beams, braces, foundations… |
| Ducts / Pipes / Trays / Conduits | MEP runs |
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
| Dimensions & Tags | Annotate |
| Sheets & Viewports | Layout drawings |
| Title Blocks / Revisions | Issue control |
| View Templates | Apply graphic standards |
| Export PDF | Issue sheets |

### Coordination & QA

| Command | What it does |
|---------|----------------|
| Clash Detection | Find interferences |
| Clash Scenarios | Save rules & reviews |
| Issues / BCF | Track and exchange issues |
| IDS / Standards | Check information requirements |
| Validate Model | Native QA checks |
| Schedules / QTO / Cost | Quantities and estimates |
| 4D Timeline | Construction simulation |

### Keyboard shortcuts (common)

| Shortcut | Action |
|----------|--------|
| **Ctrl+P** | Command palette |
| **Ctrl+Shift+R** | BIM Command Center |
| **Esc** | Cancel / clear tool |
| **Delete** | Delete selection |
| **Ctrl+Z / Ctrl+Y** | Undo / Redo (when history is active) |

---

## How to use (day to day)

### 1. Open or import a model
- **Import** an IFC (or start empty and model from scratch).
- For several files: use **Federation** / **Manage Links** and align origins.

### 2. Explore
- Use the **model tree** and **properties**.
- **Isolate** a system or level; cut with a **section box**.

### 3. Author
- Place walls, doors, rooms from the **Architecture** tools or Command Center.
- Use **Match Properties**, **Align**, and **Create Similar** for speed.

### 4. Coordinate
- Run **Clash Detection** between disciplines.
- Create **issues** and export **BCF** to share with the team.

### 5. Document
- Create **plan/section** views → add dimensions/tags → place on **sheets** → **PDF**.

### 6. Check before issue
- Run **Validate** and **IDS** checks.
- Review schedules and quantities.

---

## Interoperability

| Format / standard | Role |
|-------------------|------|
| **IFC 2x3 / IFC4** | Model exchange (import/export paths) |
| **BCF** | Coordination issues |
| **IDS** | Information requirements checking |
| **PDF** | Drawing sheets |
| **DWG / CAD** | Drawing import/export paths |
| **CSV** | Schedules & cost |
| **gbXML** | Energy-related export path (where enabled) |

RVT / NWD / NWC can be brought in through conversion pipelines where configured — native Revit/Navisworks files are not edited in-place.

---

## Documentation

| Guide | Audience |
|-------|----------|
| [User Guide](documentation/USER_GUIDE.md) | Setup, workflows, troubleshooting |
| [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) | Full tool list & maturity |
| [Authoring](docs/02-authoring.md) | Modeling & families |
| [Coordination](docs/03-coordination.md) | Clash & issues |
| [Documentation](docs/04-documentation.md) | Views & sheets |
| [Install & UX](docs/INSTALL_AND_UX.md) | UI map & smoke test |
| [Native BIM validation](docs/NATIVE_BIM_VALIDATION.md) | QA checks |
| [Plugin SDK](docs/PLUGIN_SDK.md) | Extensions |
| [Developer Guide](documentation/DEVELOPER_GUIDE.md) | Architecture & contribution |

---

## For developers

```bash
npm install
npm run dev          # development server
npm run typecheck    # TypeScript
npm run build        # production build
npm run test:native-bim
```

**Stack:** React · TypeScript · Vite · Three.js · That Open (web-ifc / Fragments) · MUI  

**Layout:** `src/features` (tools/UI) · `src/modules` (BIM domains) · `src/commands` · `src/workers` · optional `server/`

Contributions welcome — open an issue for large changes; keep secrets and project files out of git.

---

## Scope & honesty

OpenBIMStudio aims for broad **openBIM** coverage (authoring, coordination, documentation, validation).  
Individual tools differ in maturity. A button in the UI does not always mean a fully production-proven workflow.  
Validate critical paths on your own models before relying on them for contractual deliverables.

---

## License

**MIT** — see [LICENSE](LICENSE).

Built around open standards: **IFC · BCF · IDS · COBie** and the wider openBIM community.
