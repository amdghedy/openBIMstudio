# OpenBIMstudio — Master Tool Catalogue

Repository: https://github.com/amdghedy/openBIMstudio

This is a source-mapped catalogue of the application's tool families. It is intentionally evidence-led: a source file or menu label proves that code or intended functionality exists, not that the feature is complete or production-ready.

## Status vocabulary

- **Source present** — a related source module exists.
- **UI exposed** — an entry point is registered in a menu, panel, ribbon, or command palette.
- **Tested** — an automated test covers the relevant behavior; inspect its assertions.
- **Runtime verified** — exercised in the browser with representative models.
- **Partial / known limitation** — a documented restriction exists.
- **Not verified** — further investigation is required.

Do not promote a feature to production-ready based only on its filename or import statement.

## 1. Application shell and core interaction

| Tool / subsystem | Source reference | Documentation and verification focus |
|---|---|---|
| Application bootstrap | src/main.ts; src/core/setup.ts | Startup order, viewer initialization, feature registration, boot failures. |
| Error handling | src/core/errors.ts | Global errors, import failures, user-visible diagnostics. |
| Shared context and services | src/core/context.ts; src/core/services.ts | Service contracts, lifecycle, missing-service behavior. |
| Diagnostics and notifications | src/core/diagnostics.ts; src/core/notify.ts | Diagnostic data, severity, user feedback. |
| Input router | src/core/input-router.ts | Pointer/keyboard routing and conflict handling. |
| Revit mouse policy | src/core/revit-mouse-policy.ts | Actual camera and pointer bindings; verify orthographic and perspective modes. |
| Wheel arbitration | src/core/wheel-arbiter.ts | View zoom versus panel scrolling, modifier keys. |
| Camera gate | src/core/camera-gate.ts | Camera interaction state and recovery after tools close. |
| Options registry | src/core/options-registry.ts | Defaults, option scope, persistence. |
| Units and formatting | src/core/units.ts; src/core/format.ts | Internal/display units, conversion, rounding. |
| Spatial hash | src/core/spatial-hash.ts | Spatial query correctness and performance. |
| Performance optimizer | src/core/performance-optimizer.ts | Profiling evidence and measurable impact. |
| Localization | src/core/i18n.ts; src/core/locale-boot.ts | Supported locales and missing translation behavior. |
| Command base | src/commands/CommandBase.ts | Command lifecycle, errors, undo/cancel semantics. |
| Command palette | src/features/command-palette.ts | Search, command registration, activation. |
| Shortcuts | src/shell/default-shortcuts.ts; src/features/shortcuts.ts | Exact shortcut inventory and conflicts. |
| Context menu | src/features/context-menu.ts | Target-sensitive actions and enabled/disabled state. |
| Ribbon and shell | src/shell/ribbon.ts; src/shell/shell.ts | Main navigation and tool groups. |
| Viewport toolbar | src/shell/viewport-toolbar.ts | Quick actions and command wiring. |
| Status bar | src/shell/status-bar.ts; src/features/status-bar-extras.ts | Status metrics, coordinate and unit labels. |
| UI registry/menu | src/modules/ui-registry.ts; src/features/user-interface-menu.ts | Registered items, availability, toggle behavior. |
| Workspace layout | src/modules/workspace-layout.ts; src/features/workspace-boot.ts | Layout restore, first-run defaults. |
| Ribbon persistence | src/features/ribbon-persist.ts | Stored preferences and migration. |
| Home screen | src/shell/home-screen.ts | New/open/recent project flows. |

The UI registry describes visibility getters, toggle callbacks, availability, optional unavailable hints, and groups. The user-interface menu stores visibility state in browser local storage under obs.ui.visibility.v1. This is browser-local preference storage, not project-file persistence.

## 2. Viewer, navigation, selection, visibility

| Tool | Source reference | Verification focus |
|---|---|---|
| Viewer setup | src/core/setup.ts; src/features/bim-experience.ts | Scene, renderer, camera and lifecycle. |
| Navigation controls | src/features/navigation.ts; src/features/navigation-bar.ts | Orbit, pan, zoom and bindings. |
| Selection | src/features/selection.ts; src/features/box-selection.ts; src/features/select-all.ts | Single, multiple, box, select-all. |
| Selection orbit/pivot | src/features/selection-orbit.ts; src/features/selection-orbit-pivot.ts | Orbit target and pivot behavior. |
| Fit/focus | src/features/dblclick-fit.ts; src/features/focus-service.ts; src/features/camera-tools.ts | Framing bounds, double-click, selected-object focus. |
| Gizmo and snapping | src/features/gizmo.ts; src/features/snapping.ts | Supported transforms, snap types and tolerances. |
| Cursor tracking | src/features/cursor-tracker.ts | Coordinate readout and units. |
| Walk mode/minimap | src/features/walk-mode.ts; src/features/walk-minimap.ts | Movement constraints and minimap sync. |
| Section tools | src/features/section.ts; src/features/section-box.ts; src/features/section-cut-interaction.ts; src/features/section-modal.ts | Section creation, clipping and reset behavior. |
| View graphics/visibility | src/features/view-graphics.ts; src/modules/visibility/visibility-filter.ts | Hide/isolate/reset and category filters. |
| Model tree | src/modules/model-tree/tree.ts; src/features/model-tree-panel.ts | Hierarchy, search and selection sync. |
| Property palette/schema | src/features/property-palette.ts; src/features/property-schema.ts | Read-only versus editable fields and data persistence. |
| Saved views | src/features/saved-views.ts | Camera/view persistence and restore. |
| View panels | src/features/views-panel.ts; src/features/plan-view-panel.ts | View navigation and plan workflow wiring. |
| Temporary dimensions/measure | src/features/temp-dimensions.ts; src/features/measure.ts | Reference points, precision and units. |
| Model alignment | src/features/model-align.ts; src/features/align-tool.ts | Model transforms and coordinate alignment. |
| Model health | src/features/model-health.ts | Rule definitions and actionable findings. |
| LOD manager | src/features/lod-manager.ts | Detail levels and rendering impact. |
| MEP coloring | src/features/mep-coloring.ts | Coloring rules and reset behavior. |
| Item metadata | src/features/item-meta.ts | Metadata extraction and display. |

### Viewer acceptance checklist

1. Test orthographic and perspective views with wheel zoom, pan, orbit, modifiers and keyboard.
2. Select objects in the viewport and tree; verify synchronization with properties.
3. Test hide, isolate, reset, category visibility and section clipping.
4. Verify saved views after reload and project switching.
5. Test rotated elements, linked models and dense geometry.
6. Confirm all displayed distances and coordinates use documented units.
7. Record browser, model size, element count, FPS/memory where performance is claimed.

## 3. Projects, imports, links, federation, collaboration

| Tool | Source reference | Verification focus |
|---|---|---|
| Projects and store | src/modules/projects/projects.ts; src/modules/projects/store.ts; src/modules/projects/types.ts | Create/open/rename/duplicate/delete, schema migrations. |
| Project information/browser | src/features/project-info.ts; src/features/project-browser.ts | Project metadata and navigation. |
| Importer and file menu | src/features/importer.ts; src/features/file-interop.ts; src/features/file-menu.ts; src/shell/file-menu.ts | Supported extensions, parser errors, fidelity. |
| Manage links | src/features/manage-links.ts; src/features/link-tools.ts | Reload, detach, transforms, missing files. |
| Federation | src/modules/federation/manager.ts; src/modules/federation/store.ts; src/modules/federation/types.ts | Source models, transforms, coordinate systems, persistence. |
| Collaboration | src/modules/collaboration/realtime-client.ts; src/modules/collaboration/workshare-client.ts | Server requirements, authentication, conflict resolution, concurrency. |
| CDE | src/modules/cde/; src/features/cde-panel.ts | Provider registry, HTTP, storage; ACC, Dalux and SharePoint provider code requires live-operation verification. |
| App loader | src/features/app-loader.ts | Loading state and error recovery. |

For federation, validate units, origin, rotation, elevation, link transforms and duplicate-model handling before running clash tests. Never assume shared coordinates are correct without checking known reference points.

## 4. BIM authoring and element domains

These modules indicate the project's authoring scope. They do not establish parity with a commercial parametric BIM engine.

| Domain | Source reference | Required documentation |
|---|---|---|
| General authoring | src/features/authoring.ts; src/features/primitives.ts; src/features/push-pull.ts; src/features/frag-edit.ts | Create/edit operations, geometry persistence, undo. |
| BIM Object Studio/toolbox | src/features/bim-object-studio.ts; src/features/bim-toolbox.ts | Available categories, creation inputs and output data. |
| Families/parametric engine | src/modules/families/; src/features/family-browser.ts; src/features/parametric-family-panel.ts | Type/instance distinction, constraints, formulas, placement, nesting and limitations. |
| Levels | src/modules/levels/; src/features/level-chip.ts | Elevation, associations, display and persistence. |
| Rooms | src/modules/rooms/rooms.ts; src/modules/bim-gaps/room-detect.ts; src/modules/bim-gaps/room-tool.ts | Boundary rules, holes, area, tagging and update behavior. Existing milestone notes describe room behavior as non-associative and note an unwired plan-panel workflow. |
| Stairs and railings | src/modules/stairs/stairs.ts; src/modules/railings/railings.ts | Geometry parameters, edits and export. |
| Curtain walls | src/modules/curtain-wall/curtain-wall.ts; src/modules/curtainWall/panelTypes.ts | Grids, mullions, panels, openings and edits. |
| Roofs | src/modules/roofs/complexRoof.ts | Supported roof forms and editing. |
| Materials | src/modules/materials/materials.ts | Assignment, appearance, persistence and export mapping. |
| Shared parameters | src/modules/shared-params/shared-params.ts | Definitions, binding and export mapping. |
| Type catalogs | src/modules/type-catalog/type-catalog.ts | Type data and instance/type propagation. |
| Groups/design options/phases | src/modules/groups/groups.ts; src/modules/design-options/design-options.ts; src/modules/phases/phases.ts | Membership, option visibility and phase behavior. |
| Reference planes | src/modules/ref-planes/ref-planes.ts | Reference geometry and constraints. |
| Copy/Monitor | src/modules/copy-monitor/copy-monitor.ts | Monitored relationships and change detection. |
| Hosted openings | src/features/hosted-openings.ts; src/features/hosted-place-sync.ts | Host cuts, placement sync, recut logic and failures. |
| MEP fabrication | src/features/mep-fabrication.ts | Exact supported fabrication operations. |
| P&ID | src/features/pid-modeler.ts | Symbols, connectivity and data model. |
| Constraint solver | src/features/constraint-solver.ts | Supported constraints and solve failures. |
| AccuDraw | src/features/accudraw.ts | Precision drawing, coordinate plane and snaps. |
| Wall handles/plan grid | src/features/wall-handles.ts; src/features/plan-grid-tool.ts | Editable geometry versus visual aids. |

For every authoring tool, verify category, host/level relationships, parametric behavior, persistence after reopen, undo/redo, schedules and export inclusion.

## 5. Drawings, views, annotations, sheets

| Tool | Source reference | Verification focus |
|---|---|---|
| Drawing/drafting | src/features/drawing.ts; src/features/drafting-2d.ts; src/features/drafting-bridge.ts | Supported primitives and model/view linkage. |
| DWG/DXF engine | src/modules/drawings/ | Supported entity types and round-trip losses. |
| Plan generator | src/modules/views/generators/plan.ts; src/modules/drawings/plan-generator.ts | Generated geometry and update behavior. |
| Section/elevation generators | src/modules/views/generators/section.ts; src/modules/views/generators/elevation.ts | Cut geometry, hidden lines and view consistency. |
| Annotations | src/modules/views/annotation-layer.ts; src/modules/views/annotations.ts; src/modules/views/annotation-store.ts | Annotation storage and rendering. |
| Dimensions/tags | src/modules/views/dimension-engine.ts; src/modules/auto-dimensions/; src/modules/views/tag-engine.ts | Reference resolution, placement and update. |
| Plan snap/hit test | src/modules/views/plan-snap.ts; src/modules/views/hit-test.ts | Tolerances and selection precision. |
| Sheet layout | src/modules/views/sheet-layout.ts; src/modules/sheets/sheets.ts | Viewports, scale, page size and placement. |
| Sheets UI | src/features/sheets-panel.ts; src/features/sheets-2d-panel.ts | Sheet navigation/editing. |
| PDF export | src/modules/export/pdf.ts; src/modules/export/sheet-pdf.ts | Page size, fonts, line weights and printed scale. |
| DWG command | src/commands/ExportDWGCommand.ts | Registration and actual output format. |
| Revision clouds | src/features/revision-cloud.ts | Revision annotation behavior. |

A file opening successfully is not evidence of dimensionally correct output. Validate sheet size, scale, line weights, fonts, dimensions, title blocks, revision data and external-reader compatibility.

## 6. Coordination, clashes, issues, standards

| Tool | Source reference | Verification focus |
|---|---|---|
| Clash UI/categories/review | src/features/clash.ts; src/features/clash-categories.ts; src/features/clash-review.ts | Setup, category pairs and review. |
| Clash engine/worker | src/features/clash-engine.ts; src/modules/clash/; src/features/clash-worker-client.ts | Intersection algorithm, tolerance, cancellation and large-model performance. |
| Clash grouping/report | src/modules/clash/grouping.ts; src/features/clash-report.ts | Grouping keys and report contents. |
| Issues | src/modules/issues/issues.ts; src/features/issues-panel.ts | Lifecycle, assignment, comments, viewpoint and persistence. |
| BCF | src/modules/issues/bcf.ts; src/modules/export/bcf21.ts | Version, fields, viewpoint components and round trip. |
| IDS | src/features/ids-panel.ts; src/features/ids.ts | Supported IDS version and requirement facets. |
| Standards | src/features/standards-panel.ts; src/modules/standards/; src/features/standards-report.ts | Rule IDs, severities, evidence and report traceability. |
| Native BIM validation | src/modules/native-bim/model-validation.ts; src/modules/native-bim/documentation-validation.ts | Exact checks and test assertions. |

Clash verification must include known positive, known negative, touching geometry, tolerance-boundary, rotated elements, linked models and unsupported geometry. Do not use clash counts alone as proof of coordination quality. Model-health/standards results are not certification or proof of code compliance unless every rule and its scope have been independently validated.

## 7. Schedules, quantities, cost, 4D and automation

| Tool | Source reference | Verification focus |
|---|---|---|
| Schedules | src/modules/schedules/; src/features/schedules-panel.ts; src/features/schedules-ui.ts | Catalog, builder, formulas, templates, diff, refresh. |
| Quantity takeoff | src/modules/cost/quantities.ts | Units, gross/net rules, openings and supported categories. |
| Cost | src/modules/cost/cost.ts; src/modules/cost/types.ts; src/features/cost-panel.ts | Currency, rate source/date, rounding and exclusions. |
| Timeline/4D | src/modules/timeline/timeline.ts; src/modules/timeline/types.ts; src/features/timeline-panel.ts | Task dates, dependencies, element mapping and playback. |
| Phases | src/modules/phases/phases.ts | Phase metadata; not automatically a complete construction schedule. |
| Automation rules | src/modules/automation/rules.ts; src/features/automation-panel.ts | Triggers, actions, permissions and logs. |

Treat quantities and costs as estimates until reconciled with approved measurement rules. Verify timeline baseline, task dependencies and element mapping before contractual reporting.

## 8. Exchange formats and handover

| Format/workflow | Source reference | Important boundary |
|---|---|---|
| IFC import | src/features/importer.ts; src/features/file-interop.ts; web-ifc dependency | Confirm versions, geometry, properties, placement and units. |
| Authored IFC | src/modules/bim-gaps/authored-ifc.ts; src/modules/bim-gaps/ifc-guid.ts; src/modules/export/native-twin-ifc.ts | Milestone notes describe a defined IFC4/IFC2X3 subset and list unsupported classes. Read ../docs/REVIT_GAPS_M1.md before promising full export. |
| COBie | src/modules/export/cobie.ts | Validate required fields and worksheet/schema completeness. |
| BCF | src/modules/export/bcf21.ts | Validate version and import/export symmetry. |
| DWG/DXF | src/modules/drawings/; src/commands/ExportDWGCommand.ts | Layers, blocks, dimensions, fonts, units and unsupported entities. |
| PDF | src/modules/export/pdf.ts; src/modules/export/sheet-pdf.ts | Page scale and graphics fidelity. |
| Native-twin reconstruction | src/modules/export/native-twin-ifc.ts; src/modules/bim-gaps/ | Define source formats, supported classes and geometry/property fidelity. |

For every format, maintain a matrix of version, entity coverage, geometry/property fidelity, coordinate handling, identifier behavior, warnings, external validator and round-trip test result. Never silently describe a partial subset as complete format support.

## 9. AI and intelligent assistance

| Tool | Source reference | Verification focus |
|---|---|---|
| AI chat | src/features/ai-chat.ts | UI, provider configuration and failure behavior. |
| AI providers | src/features/ai-providers.ts | Providers, credentials and data egress. |
| Embeddings | src/features/ai-embeddings.ts | What is embedded, where it is stored and retention. |
| AI tools | src/features/ai-tools.ts | Tool permissions and side effects. |
| Automation rules | src/modules/automation/rules.ts | Keep deterministic checks distinct from AI suggestions. |

Never commit credentials. Document whether prompts or model data leave the workstation. Review generated actions before executing them against a project.

## 10. UI wiring and compatibility modules

| Subsystem | Source reference | Verification focus |
|---|---|---|
| Panel wiring | src/features/panel-wiring.ts | Federation, Standards and CDE command registration; missing-panel handling. |
| UI registration | src/features/ui-items-register.ts; src/modules/ui-registry.ts | Registered IDs, unavailable placeholders and stable identifiers. |
| BIM/CAD parity bridges | src/features/bim-parity-bridge.ts; src/features/bim-input-parity.ts; src/features/cad-parity.ts | Actual implemented paths, not parity aspirations. |
| Critical-gaps boot/UI | src/critical-gaps-boot.ts; src/features/critical-gaps-ui.ts; src/modules/bim-gaps/ | Registration and module-specific startup errors. |
| Extras/panels | src/features/_extras.ts; src/features/panels/ | Inventory every setup function and visible action. |

## 11. Package scripts and tests

The package manifest declares development/build/verification commands including:

- npm run dev
- npm run typecheck
- npm run build
- npm run preview
- npm run server
- npm run verify
- npm run verify:v50
- npm run verify:v52
- npm run verify:v54
- npm run test:native-bim

The test tree includes geometry, IFC, M2 geometry/tools, M3 plan/register/views, M4 smoke, visibility, and a test runner. Read the actual script and assertions before treating a command as comprehensive. A typecheck is not a runtime test; a smoke test is not full interoperability validation.

## 12. Per-tool reference template

Create docs/tools/<tool-name>.md with:

- **Status:** source present / UI exposed / tested / runtime verified / partial / planned.
- **Purpose and use case**
- **Entry point:** menu, panel, shortcut or command.
- **Preconditions**
- **Inputs, defaults, units**
- **Step-by-step workflow**
- **Expected outputs and persisted changes**
- **Source files and key functions**
- **Dependencies and data contracts**
- **Failure cases and recovery**
- **Known limitations**
- **Automated and manual verification**
- **Interoperability and fidelity**
- **Security/privacy**
- **Version and change history**

## 13. Release acceptance checklist

- [ ] UI entry is accurate and discoverable.
- [ ] Preconditions and disabled states are clear.
- [ ] Invalid input produces actionable feedback.
- [ ] Minimal fixture and production-like model tested.
- [ ] Cancel/retry behavior is safe.
- [ ] No unrelated elements are modified.
- [ ] Save/reopen and project switching tested.
- [ ] Undo/redo documented.
- [ ] Units, coordinate transforms and tolerances tested.
- [ ] Exchange files checked in an independent reader.
- [ ] Automated tests are linked.
- [ ] Limitations are explicit.
- [ ] Documentation matches the release.

## 14. Scope boundary

OpenBIMstudio is an evolving project. This catalogue intentionally does not claim that every module is equivalent to Revit, Navisworks, ACC or other commercial BIM systems. Read source code, tests and runtime evidence together when assessing maturity.
