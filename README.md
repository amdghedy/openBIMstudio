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

**Local-first · Open standards · Browser-based · IFC · BCF · IDS · PDF · CAD**

[Quick start](#-quick-start) · [What you can do](#-what-you-can-do) · [Tools & commands](#-tools--commands) · [How to use](#-how-to-use-day-to-day) · [Docs](#-documentation)

</div>

---

## What is OpenBIMStudio?

OpenBIMStudio is a **browser-based, local-first BIM workspace** for architecture, engineering, and construction. It brings model authoring, multi-model coordination, drawing workflows, information checks, quantities, and open-format exchange into one application.

The project is released under the MIT license. Local development and local project workflows are the primary path; optional collaboration and AI features may require separate configuration. Open standards are a design priority, while support and fidelity vary by format and workflow.

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
- Use the **ViewCube** (top-right of the viewport): click faces, edges or corners to jump to exact views; use the curved arrows to orbit in 90° steps (hold to repeat); right-click the cube for the full navigation menu.
- **Home menu**: Go Home · Orthographic / Perspective / Perspective with Ortho Faces · Set current view as Home · Focus and set as Home · Reset Home · Set current view as Front / Top · Reset orientation.
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

Some additional model formats may be accessible through separately configured conversion pipelines. Availability depends on the converter and workflow; source files are not necessarily editable in place.

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

Contributions welcome. For substantial changes, open an issue first to agree on scope. Include reproduction steps, expected versus actual behavior, test evidence, and screenshots or a small non-confidential sample when useful. Keep credentials, private models, and project files out of git.

---

## Project principles

- **Open data first:** prioritize IFC and open coordination / information-exchange standards.
- **Local-first workflow:** keep core development and model exploration close to the user's machine; optional server-backed functions are configured separately.
- **Traceable maturity:** source code, a visible command, an automated test, and a validated production workflow are different levels of evidence.
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

Not every tool has the same level of coverage. Automated tests cannot fully prove browser interaction quality, geometry fidelity, interoperability round-tripping, large-model performance, or suitability for contractual delivery. For important workflows, record the sample model, expected result, observed result, browser/runtime, and any known limitation.

## Privacy, local data & optional services

- Review the settings and configuration for any optional AI provider, collaboration server, or connected data environment before using them with confidential project information.
- Do not commit credentials, API keys, private model files, or project-specific data to the repository.
- Local-first does not automatically mean every feature is offline-only: features that connect to a provider or server require that service and its own privacy/security review.
- Back up project data before testing migration, import/export, or experimental authoring features.

## Scope & honesty

OpenBIMStudio aims for broad **openBIM** coverage across authoring, coordination, documentation, and validation. Individual tools differ in maturity: source code or a visible command alone does not prove end-to-end completion. Check the [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) for evidence and known limitations, and validate critical paths on representative models before relying on them for contractual deliverables.

---

## License

**MIT** — see [LICENSE](LICENSE).

Built around open standards: **IFC · BCF · IDS · COBie** and the wider openBIM community.
