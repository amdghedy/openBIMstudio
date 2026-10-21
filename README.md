<p align="center">
  <img src="openBIMstudio.png" alt="OpenBIMStudio Banner" width="700">
</p>
<div align="center">

# OpenBiMStudio

**Professional, local-first openBIM authoring, coordination & documentation — running entirely in the browser.**

![Version](https://img.shields.io/badge/version-0.66.2-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![IFC](https://img.shields.io/badge/IFC-IFC2X3%20%7C%20IFC4-3b82f6.svg)
![Platform](https://img.shields.io/badge/platform-web%20%7C%20local--first-success.svg)

</div>

## Overview

**OpenBiMStudio** is a web-native, local-first building information modelling (BIM) platform built on open standards. It loads, edits, coordinates and documents IFC models without any desktop installation — the entire authoring environment, 3D viewer, documentation engine and collaboration server run in the browser and on a single lightweight Node.js backend.

Models stay on your machine. Federated IFC files, project files, family definitions and everything else persist in the browser (IndexedDB / OPFS), so nothing is uploaded unless you explicitly connect to a collaboration server.

The platform is designed for AEC professionals who need a productive BIM authoring and coordination workflow that respects open standards — **IFC as the interchange format, BCF for issue exchange, IDS for validation, and buildingSMART-defined schemas throughout.**

## Why OpenBIMStudio

- **Truly local-first.** Every project, model, family and setting lives in your browser. No account, no cloud, no vendor lock-in.
- **Open by design.** IFC2X3 and IFC4 in, IFC2X3 and IFC4 out. Native BCF 2.1, IDS, COBie, DXF, DWG (via libredwg-web) and glTF.
- **Full authoring loop.** Not just a viewer — parametric families, compound walls, hosted doors and windows with real openings, MEP routing with auto-fittings, slabs, roofs, stairs, railings, curtain walls, ceilings, rooms and grids.
- **Federation-ready.** Load multiple IFC models at once with per-model positioning, shared coordinates, isolation and coordinated clash detection.
- **Production documentation.** Plans, sections and elevations generated from live model geometry, driven into sheet sets with title blocks, schedules, dimensions and tags.
- **Engineered to scale.** Web Worker-offloaded clash detection with BVH acceleration, streaming IFC to FRAG conversion, LOD management and bounded-concurrency bulk operations.

## Core Capabilities

### Authoring & Parametric Families

- **Parametric family engine** — formula-driven parameter graphs with topological sort, cycle detection, dimensional constraints, nested families, arrays and reporting parameters.
- **Compound walls** — layer-based construction (e.g. `Brick:0.1, Insulation:0.05, Gypsum:0.015`) with location-line placement and automatic L-corner mitering.
- **Hosted elements** — doors and windows with real openings carved from the host wall, sill height, frame thickness and clamped offset along host.
- **MEP routing** — ducts, pipes, cable trays and conduits with auto-generated elbow, tee, cross, wye, cap, transition and union fittings at every bend.
- **Structural elements** — beams, braces, trusses, footings and strip foundations with configurable section profiles.
- **Direct modelling** — push/pull faces, primitive solids (box, cylinder, sphere, cone) and boolean subtract via CSG.

### Clash Detection & Coordination

- **Eight detection methods** — triangle-accurate (BVH), conservative bounding box, convex hull (GJK), bounding sphere, center-in-volume, clearance band, duplicate detection and penetration depth.
- **Web Worker execution** — a dedicated worker keeps the UI responsive while clash runs traverse millions of triangle pairs.
- **Federated A vs B** — build selection groups from loaded models, add the current selection to A or B, run the test, then navigate clashes and crop to each pair.
- **Grouping and reporting** — union-find grouping by shared element, per-status review workflow (new, active, reviewed, approved, resolved), and CSV / HTML / XLS report export.
- **Scenarios** — save and reload complete clash rules, selections, statuses and comments as a named scenario.

### Documentation

- **True 2D views** — plans, sections, elevations, RCPs and details generated from live geometry.
- **Sheet production** — A0 to A4, ANSI and Arch sheet sizes with title blocks, viewports at arbitrary scales and PDF export.
- **Schedules** — element schedules, quantity take-offs and material take-offs with formula columns, grouping, subtotals and conditional formatting.
- **Dimensions & tags** — aligned, linear, angular, radial, diameter, arc length, spot elevation and spot coordinate dimensions. Element tags, room tags and material tags with leader shapes.
- **Automatic drawing content** — wall poche broken at door and window openings, room boundaries, stair symbols, riser lines, mullion ticks, ridge lines, door and window marks.

### Coordination & Data

- **IFC export** — IFC2X3 and IFC4 STEP files with valid GlobalIds, property sets (`OpenBIMStudio`, `Pset_*Common`), material assignments, element quantities and storey-relative placement.
- **BCF 2.1** — issue import and export with viewpoints that capture camera state, section planes, cropped boxes and element selection.
- **IDS validation** — run Information Delivery Specification checks against loaded IFC models.
- **COBie** — export a COBie spreadsheet from the current model state.

### 4D, 5D and Automation

- **4D construction simulation** — a timeline editor that sequences element appearance and demolition across project phases.
- **5D cost** — quantity take-off driven by `Qto_*` properties where present, geometric measurement otherwise, mapped to configurable cost items and exported as CSV.
- **Automation rules** — a JSON rule engine that reacts to model events (element created, phase changed, property assigned) and applies actions.
- **Standards rule packs** — an extensible rule framework with shipped packs for accessibility, fire egress, QA and structural checks.

### Collaboration

- **Real-time co-presence** — Yjs over WebSockets for live cursors, named presence and shared state.
- **Worksharing client** — element-level locking and synchronisation against a central server.
- **Local-first with optional server** — the Node.js backend in `server/` provides a projects API, SSE-based presence feed and per-room change log. Skip it entirely for a fully offline workflow.

### Interoperability

| Format | Import | Export |
|---|---|---|
| IFC 2X3 / IFC 4 | yes | yes |
| FRAG (streaming mesh format) | yes | yes (via converter) |
| BCF 2.1 | yes | yes |
| IDS | yes | no |
| COBie | no | yes |
| DF | yes | yes |
| DWG | yes (via libredwg-web) | no |
| glTF / GLB | yes | yes |
| OBJ / STL / PLY | yes | no |

## Tech Stack

| Layer | Technology |
|---|---|
| **Language** | TypeScript (strict) |
| **Build** | Vite, esbuild (ESNext target) |
| **3D** | Three.js, `@thatopen/components`, `@thatopen/fragments`, `@thatopen/ui` |
| **IFC** | `web-ifc` (WASM), `@thatopen/fragments` (streaming) |
| **UI shell** | Vanilla TypeScript + Web Components, MUI for legacy panels, Monaco for the formula editor |
| **State** | Typed service registry, Redux Toolkit (legacy), Yjs (collaboration) |
| **Backend** | Node.js, Server-Sent Events, WebSocket |
| **Export** | `pdf-lib`, `file-saver`, JSZip |
| **Testing** | Node test runner, TypeScript compilation |

## Quick Start

**Prerequisites:** Node.js 20.11 or newer, npm 10 or newer.

```bash
git clone https://github.com/amdghedy/openBIMstudio.git openbimstudio
cd openbimstudio
npm install
npm run dev
```

The app runs at `http://localhost:3000`.

For a production build:

```bash
npm run build
```

For the optional collaboration server (separate terminal):

```bash
npm run server
```

The server listens on `http://localhost:4000` and exposes `/api/projects/:id` and `/api/rooms/:room`.

## Architecture at a glance

```
Browser (Vite dev / prod)
  index.html -> src/main.ts -> ~90 sequential boot steps

  src/core/       typed service registry, input router,
                  i18n, units, diagnostics, camera gate

  src/features/   authoring, navigation, selection,
                  gizmo, snapping, measure, section,
                  frag-edit, clash, importer, ribbon

  src/modules/    families, clash, views, drawings,
                  schedules, cost, standards, projects,
                  issues, sheets, cde, model-tree,
                  federation, timeline, phases, rooms

  src/workers/    clash detection (BVH + GJK) off main thread

           |                              |
           v                              v
   web-ifc (WASM)                    Node.js server
   IFC -> FRAG                       projects, rooms
                                     SSE + WebSocket
```

### Boot chain

`main.ts` runs a fixed sequence of idempotent `setupXxx()` calls. Each step is wrapped so a failure in one module never prevents the rest of the app from loading. The ordered contract ensures that camera tools initialise before the input router, the router before navigation, and everything before the ribbon and workspace panels.

### Service registry

Cross-feature communication goes through a typed registry:

```typescript
services.selection.snapshot()        // throws if not registered
services.tryUse("family")            // returns null if missing
await services.ready("clash")        // resolves when registered
```

This replaces ad-hoc window globals with a compile-time-checked contract while still supporting late registration.

### Input router
A single, priority-ordered router owns every pointer, wheel and Escape event on the 3D viewport. The first handler to accept a drag-start owns the gesture; nobody else sees its move or end events. Priorities: gizmo (100), box-select (50), navigation (30), context menu (20), authoring (10). This is what keeps a gizmo drag from accidentally orbiting the camera, or a rubber-band selection from placing a wall.

## Project structure

```
src/
  core/           Typed services, context, routing, utilities
  features/       User-facing features (authoring, selection, ribbon, ...)
  modules/        Domain engines (families, clash, views, schedules, ...)
    clash/        Triangle BVH, GJK, spatial hash
    families/     Parametric engine, formula, constraints
    views/        Scene2D pipeline, plan / section / elevation
    drawings/     DXF reader / writer, DWG bridge
    schedules/    Formula columns, grouping, subtotals
    cost/         Quantity take-off, cost items
    standards/    Rule packs (accessibility, fire, QA, structural)
  shell/          Ribbon, file menu, status bar, home screen
  commands/       Command pattern (undo-able operations)
  plugins/        Plugin loader
  locales/        i18n catalogs
  workers/        Web Workers (clash detection)
  main.ts         Boot sequence
```

## Status

OpenBiMStudio is under active development. The core authoring, parametric, coordination and documentation engines are functional and being hardened for production use. Breaking changes to the internal API are still possible between minor versions; the IFC import/export surface is stable.

## Documentation

The expanded documentation set is maintained under [`documentation/`](documentation/README.md):

- [User Guide](documentation/USER_GUIDE.md) — setup, workflows, troubleshooting and safe model validation.
- [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) — source-mapped inventory of tool families and verification status.
- [Developer Guide](documentation/DEVELOPER_GUIDE.md) — architecture, module registration, persistence, testing and security.
- [Tool Reference Template](documentation/tools/README.md) — standard structure for documenting each command and workflow.
- [Existing implementation and gap documents](documentation/README.md) — parametric engine, IFC/native BIM validation, drawings and parity milestones.

The catalogue deliberately distinguishes source presence from runtime verification. Review each tool's limitations and test evidence before treating it as production-ready.

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Make your change, keeping the existing code style and running `npm run typecheck` before committing.
4. Open a Pull Request describing what changed and why.

For significant changes, open an issue first to discuss the approach.

## License

Distributed under the MIT License. See `LICENSE` for details.

## Acknowledgments

- The **buildingSMART** community for the IFC, IDS and BCF specifications.
- The **That Open Company** team for `@thatopen/components` and `@thatopen/fragments`.
- The **web-ifc** maintainers.
- The **Three.js** community.
- Everyone who has contributed to the open standards that make a project like this possible.

