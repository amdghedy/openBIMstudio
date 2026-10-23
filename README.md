<p align="center">
  <img src="openBIMstudio.png" alt="OpenBIMStudio platform logo" width="960">
</p>

<div align="center">

# OpenBIMStudio

**A local-first, openBIM platform for model authoring, federation, coordination, documentation, validation, and project delivery.**

![Version](https://img.shields.io/badge/version-0.66.2-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![IFC](https://img.shields.io/badge/IFC-IFC2X3%20%7C%20IFC4-3b82f6.svg)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20local--first-success.svg)

[Features](#platform-capabilities) · [Quick start](#quick-start) · [Workflows](#typical-workflows) · [Formats](#interoperability) · [Documentation](#documentation) · [Testing](#quality-and-verification)

</div>

---

## Overview

OpenBIMStudio is a browser-based building information modelling platform focused on open data, practical authoring, and coordinated project delivery. It brings model creation and editing, parametric components, multi-model federation, clash review, issue exchange, drawing production, schedules, quantities, standards checks, and project automation into one workspace.

The platform is designed around open workflows: IFC for model exchange, BCF for coordination issues, IDS for information requirements, and structured project data for schedules and handover. It can run locally in a browser without requiring a hosted account. Project data can be stored in browser-local storage; optional collaboration services are available when configured.

**Important:** OpenBIMStudio is actively evolving. Capabilities vary in maturity, and a source module or visible command does not by itself prove that a workflow is complete or production-verified. Use the [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) and test the exact operations needed for your project.

## Why OpenBIMStudio

- **Local-first workflow:** keep projects in browser storage and work without a remote service for supported local workflows.
- **Open exchange:** work with IFC and coordination/documentation formats rather than relying on a single closed project format.
- **Authoring plus coordination:** create and edit model content, then federate models, review clashes, manage issues, and validate deliverables.
- **Model-linked documentation:** generate views and sheets from model geometry, and create schedules, dimensions, tags, and PDF outputs.
- **Automation-ready:** use validation, rules, repeatable scripts, and structured data to support QA and delivery.
- **Expandable architecture:** typed services, feature modules, commands, workers, and plugin infrastructure provide extension points for continued development.

## Platform capabilities

### 1. Model viewing, navigation, and project workspace

- Browser-based 3D viewport with perspective and orthographic viewing workflows.
- Orbit, pan, zoom, fit/focus, selection, multi-selection, and box selection.
- Selection synchronization between the viewport, model tree, and property palette where supported.
- Hide, isolate, reset visibility, category visibility, section clipping, and section boxes.
- Snapping, gizmo-based transforms, cursor coordinates, measurement, and temporary dimensions.
- Saved views, view navigation, model alignment tools, LOD controls, and model health diagnostics.
- Project creation/opening and project information/browser workflows.
- Ribbon, viewport toolbar, context menus, command palette, status bar, and configurable workspace panels.
- UI visibility and workspace preferences stored locally by the browser where implemented.

### 2. BIM authoring and parametric modelling

- **Direct geometry tools:** primitives, basic solid editing, push/pull workflows, and geometry modification tools.
- **Parametric families:** formula-driven parameters, dependency graphs, constraint checks, nested components, arrays, and reporting parameters, subject to current implementation limits.
- **Compound walls:** layered wall construction, placement controls, and corner joining/mitering workflows.
- **Hosted doors and windows:** host-aware placement and wall-opening geometry for supported workflows.
- **Structural modelling:** beams, braces, trusses, footings, strip foundations, and configurable section profiles.
- **Building elements:** levels, rooms/areas, stairs, railings, roofs, curtain walls, materials, reference planes, groups, design options, and phases.
- **MEP authoring:** ducts, pipes, cable trays, conduits, routing, fitting generation, fabrication-related tools, and P&ID-related workflows.
- **Model data:** element properties, shared parameter definitions, type catalogues, and material assignments.
- **Modification tools:** move/copy/rotate/mirror and array-style workflows where enabled, plus alignment, distribution, match-properties, paint, grouping, and create-similar commands.
- **Host and relationship utilities:** hosted-element synchronization, solve-host tools, and copy/monitor-related workflows.

Element behavior is not uniform across every category. Verify whether an element is fully parametric, whether its relationships persist after reopening, and whether it is included in schedules and exports.

### 3. Parametric family engine

- Formula-based parameter evaluation and dependency ordering.
- Cycle detection and parameter-graph checks.
- Dimensional constraints and parameter reporting.
- Nested family and array-oriented structures.
- Family browsing and family-editing panels.
- JSON family definitions and example content under `public/families/`.

The family engine and family content continue to evolve. Test representative type/instance changes, constraints, placement, save/reopen, and exchange-format behavior before relying on a family in a deliverable.

### 4. Multi-model federation and coordination

- Load and manage multiple models in a coordinated workspace.
- Manage linked models and their transforms, visibility, and placement where supported.
- Align models using known reference points and review units, origin, rotation, and elevation.
- Build selection groups for A-versus-B coordination tests.
- Review clash pairs, focus/crop to involved elements, group related findings, and manage issue statuses.
- Save named clash scenarios with rule settings, selections, review statuses, and comments where supported.
- Export clash and issue reports to supported report formats.

### 5. Clash detection

The coordination engine includes several detection approaches, selected according to the configured workflow:

- Triangle-level intersection using BVH acceleration.
- Conservative bounding-box checks.
- Convex-hull/GJK checks.
- Bounding-sphere checks.
- Center-in-volume checks.
- Clearance-band checks.
- Duplicate detection.
- Penetration-depth analysis.

Clash work can use a Web Worker to reduce blocking of the main interface. Available methods, performance, and result fidelity depend on geometry, settings, and model size. Validate known clash and non-clash examples before using results for formal coordination.

### 6. Issues and openBIM coordination data

- Issue creation and review workflows.
- BCF 2.1 import/export support in the implemented workflows.
- Viewpoints intended to capture camera state, section planes, cropped areas, and selected elements.
- Status, comments, and coordination-review information where supported.
- IDS-based checks against loaded model information.
- Standards/rule packs for areas such as accessibility, fire egress, QA, and structural review.

Standards and IDS results are checks against configured requirements, not automatic certification or a substitute for discipline-specific professional review.

### 7. Views, drawings, and sheets

- Plan, section, elevation, reflected ceiling plan, and detail-view generation workflows.
- 2D drafting and drawing tools.
- Model-linked annotation layers, dimensions, and tags.
- Linear, aligned, angular, radial, diameter, arc-length, spot-elevation, and spot-coordinate dimension workflows, subject to implementation.
- Element, room, and material tags, including leader shapes where supported.
- Drawing content such as wall poche, opening breaks, room boundaries, stair symbols, mullion ticks, ridge lines, and door/window marks.
- Sheet layout with standard metric, ANSI, and architectural sheet sizes.
- Viewports with configurable placement and scale.
- Title-block and revision-related workflows.
- PDF sheet export and CAD drawing import/export paths.
- View templates and visibility/graphics controls.

Always check page size, drawing scale, line weights, fonts, dimensions, title-block fields, revision data, and external-reader compatibility before issuing construction documents.

### 8. Schedules, quantities, and cost

- Element schedules and schedule-building workflows.
- Quantity take-off and material take-off.
- Formula-driven schedule columns.
- Grouping, sorting, subtotals, and conditional formatting where implemented.
- Quantity extraction from available model properties and geometric measurement.
- Cost items and configurable mapping from quantities to rates.
- CSV output for supported schedule/cost workflows.

Quantities and costs are estimates until checked against the project's approved measurement rules. Confirm unit conversions, gross/net conventions, opening deductions, rate source/date, currency, rounding, and exclusions.

### 9. 4D, phases, and automation

- Timeline-based construction simulation.
- Element appearance and demolition across project phases.
- Phase metadata and phase-related workflows.
- JSON automation rules triggered by supported model events.
- Rule actions for supported property, phase, and element workflows.
- Extensible standards rule packs and validation diagnostics.

Confirm task dates, dependencies, element mapping, baseline, and progress rules before using 4D outputs for project reporting. Test automation against a copy and review side effects before applying rules to live project data.

### 10. Native model and documentation QA

The native BIM validation layer includes checks for:

- Stable and unique authored element identifiers.
- Required element categories/names and finite, positive dimensions.
- Linear element endpoints and zero-length structural/MEP runs.
- Polygon point counts, finite coordinates, and non-zero area.
- Hosted door/window host references and basic placement bounds.
- Level and grid references.
- Triangle-buffer integrity and transform sanity.
- Duplicate IFC GlobalIds and identity-divergence warnings.
- Fitting parent types and bend-radius sanity.
- Sheet identifiers/numbers, sheet sizes, view references, viewport dimensions, scale notation, and viewport placement/overlap.

Validation reports provide diagnostic codes, severities, element references, and parameter paths where implemented. These checks are a QA foundation, not a full engineering solver or automatic model repair system.

### 11. AI and intelligent assistance

- AI chat interface and provider configuration modules.
- Embedding-related workflows.
- AI tool integration points.
- Rule-based automation that can complement AI-assisted tasks.

Provider availability depends on configuration. Before using AI with confidential information, identify where prompts and model data are sent, keep credentials out of source control, and review proposed actions before execution. AI suggestions should remain distinct from deterministic QA results.

### 12. Collaboration and project services

- Optional local Node.js backend.
- Project API and room-oriented endpoints.
- Server-Sent Events (SSE) presence feed and WebSocket-based collaboration paths.
- Yjs-based co-presence and shared-state workflows where configured.
- Worksharing client concepts including element-level locking and synchronization.
- CDE/provider integration points that require provider-specific setup and live-operation testing.

Local-only use does not require running the collaboration server. Before exposing the server outside localhost, inspect authentication, authorization, storage, network configuration, and deployment security.

## Interoperability

The following table summarizes intended/currently implemented exchange paths. Format coverage and fidelity vary by entity type and workflow.

| Format / workflow | Import | Export | Notes |
|---|---:|---:|---|
| IFC2X3 / IFC4 | Yes | Yes | Authored export covers a defined subset; verify classes, properties, units, and geometry. |
| FRAG | Yes | Yes, via converter | Streaming geometry workflow. |
| BCF 2.1 | Yes | Yes | Validate issue fields and viewpoint round trips. |
| IDS | Yes | — | Used for information-requirement validation. |
| COBie | — | Yes | Check worksheet and required-field completeness. |
| DXF | Yes | Yes | Verify supported entities, layers, dimensions, fonts, and units. |
| DWG | Yes, via browser-side bridge | Not fully confirmed | Check the actual output path before relying on export. |
| glTF / GLB | Yes | Yes | Check materials, transforms, and element metadata. |
| OBJ / STL / PLY | Yes | Not listed | Primarily geometry exchange; BIM semantics may not be preserved. |
| PDF | — | Yes | Drawing/sheet output; validate printed scale and layout. |
| CSV | — | Yes | Reports, quantities, schedules, and cost outputs where supported. |

**Interoperability rule:** opening a file successfully does not prove complete round-trip fidelity. Keep a source copy and compare geometry, element counts, identifiers, properties, units, coordinates, and unsupported entities using representative test files.

## Typical workflows

### Start a project and inspect a model

1. Start the application using the quick-start commands below.
2. Create/open a project or import a supported model.
3. Fit the model to the viewport.
4. Select an element and inspect its properties.
5. Use the model tree, visibility controls, and section tools to inspect the model.
6. Save/export a test copy and validate the result.

### Author and validate a building element

1. Choose the appropriate authoring command and confirm its inputs and units.
2. Create the element in a disposable test project.
3. Check dimensions, level/host relationships, and constraints.
4. Test modification, undo/redo, and save/reopen behavior.
5. Confirm schedule inclusion and export behavior before using the element in a deliverable.

### Coordinate discipline models

1. Load the required models.
2. Check units, origins, rotations, elevation offsets, and reference points.
3. Configure clash groups A and B and select the detection method/tolerance.
4. Run the test and review representative results.
5. Create issues and export BCF/reports if needed.
6. Verify issue viewpoints and identifiers after import into another compatible tool.

### Produce a drawing set

1. Generate or open plans, sections, and elevations.
2. Check crop, view scale, dimensions, tags, and visibility.
3. Place views on sheets and configure title blocks/revisions.
4. Run documentation QA.
5. Export PDF and inspect printed scale, page count, line weights, and text.

### Prepare quantities and handover data

1. Define the categories and schedule fields required.
2. Confirm measurement rules and units.
3. Review quantities, formulas, subtotals, and missing properties.
4. Map approved rates for cost estimates if required.
5. Export the required schedules/reports and validate exchange files independently.

## Quick start

### Requirements

- Node.js 20.11 or newer is recommended by the project documentation.
- npm 10 or newer.
- A modern browser with WebAssembly support.
- Additional network/provider configuration only for optional collaboration or AI services.

### Run locally

```bash
git clone https://github.com/amdghedy/openBIMstudio.git
cd openBIMstudio
npm install
npm run dev
```

Open the local address printed by the development server (the default Vite port is commonly `http://localhost:3000` in this project configuration).

### Type-check and build

```bash
npm run typecheck
npm run build
npm run preview
```

### Optional collaboration server

Open a second terminal in the project root:

```bash
npm run server
```

The server is configured around `http://localhost:4000` and exposes project/room endpoints. Inspect the server implementation and its security configuration before making it reachable on a network.

## Quality and verification

The repository includes automated tests and verification scripts for selected geometry, authoring, selection, views, MEP routing, stairs, rebar, CAD links, native BIM validation, and other targeted workflows.

Useful commands include:

```bash
npm run typecheck
npm run test:native-bim
npm run test:mep
npm run test:hip
npm run test:hatch
npm run test:stairs
npm run test:rebar
npm run test:view-crop
npm run test:selection-box
npm run test:section-box
npm run test:view-lock
npm run test:plan-draw
npm run test:props
npm run test:elbow
npm run test:walk
npm run test:cad-link
npm run test:bim-gaps
npm run verify
```

Additional versioned verification scripts are available in `package.json`. Read each script and its assertions to understand what it actually checks. A TypeScript check is not a runtime test; a smoke test is not proof of full interoperability.

### Suggested release checks

- [ ] The application starts without critical console errors.
- [ ] Import and export work with representative small and large fixtures.
- [ ] Element selection, properties, visibility, and model-tree synchronization work.
- [ ] Authoring edits persist after save/reopen and behave safely with undo/redo.
- [ ] Model alignment is checked against known reference points.
- [ ] Clash tests include known positive and negative cases.
- [ ] BCF/IFC/CAD/PDF outputs are validated independently.
- [ ] Drawing scale, dimensions, sheet layout, and title-block fields are checked.
- [ ] Quantities, costs, and standards checks are reviewed against project rules.
- [ ] Known limitations and test evidence are documented for the release.

## Architecture

```text
Browser application
  src/core/        Typed services, input routing, units, diagnostics
  src/features/    Viewer tools, authoring, ribbon, selection, commands
  src/modules/     Families, federation, clash, views, sheets, schedules,
                   cost, standards, issues, projects, phases, timeline
  src/commands/    Undo-oriented command workflows
  src/plugins/     Plugin loading and extension points
  src/workers/     Off-main-thread coordination processing
  src/locales/     Localization resources
  server/          Optional project and collaboration services
```

The application boot sequence initializes feature modules in a defined order. Cross-feature communication uses a typed service registry, while a shared input router coordinates viewport interactions so tools do not unintentionally compete for pointer and keyboard events.

## Documentation

- [User Guide](documentation/USER_GUIDE.md) — setup, workflows, troubleshooting, and safe validation.
- [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) — source-mapped feature inventory, maturity vocabulary, and verification guidance.
- [Developer Guide](documentation/DEVELOPER_GUIDE.md) — architecture, module registration, persistence, testing, and security.
- [Documentation index](documentation/README.md) — supporting technical notes and engineering gap reviews.
- [BIM authoring guide](docs/02-authoring.md) — authoring concepts and parametric families.
- [Coordination guide](docs/03-coordination.md) — clash workflow and issue exchange.
- [Documentation guide](docs/04-documentation.md) — views, templates, and sheets.
- [Native BIM validation](docs/NATIVE_BIM_VALIDATION.md) — validation checks and known boundaries.
- [Plugin SDK](docs/PLUGIN_SDK.md) — extension development.

## Development and contribution

Contributions are welcome.

1. Fork the repository.
2. Create a focused feature branch.
3. Install dependencies with `npm install`.
4. Run `npm run typecheck` and relevant targeted tests.
5. Describe the change, verification performed, and any known limitations in your pull request.

For significant changes, open an issue first. Avoid committing project files, credentials, confidential model data, or provider tokens.

## Scope and maturity

OpenBIMStudio is under active development. The capabilities listed here describe the platform's current scope and documented implementation paths, not a guarantee that every command is fully wired, tested, or production-ready. Use the live UI, source code, test assertions, and Master Tool Catalogue together to establish the maturity of a specific workflow.

## License

Distributed under the MIT License. See [LICENSE](LICENSE).

## Open standards

OpenBIMStudio is built around open information exchange and benefits from the communities maintaining IFC, BCF, IDS, COBie, and related open standards.
