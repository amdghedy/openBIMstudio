# OpenBIMstudio — User Guide

## 1. Product overview

OpenBIMstudio is a browser-based BIM/openBIM development project. The package describes a local-first workflow spanning authoring, federation, coordination, documentation, 4D/5D, IDS, BCF, automation, AI and linked-model/native-twin work. This is the stated scope, not a guarantee of full feature parity. Use the [Master Tool Catalogue](MASTER_TOOL_CATALOG.md) for source references and verification boundaries.

## 2. Requirements

The package declares Node.js >=20.11.0. Use a compatible modern browser. Some features may also require WebAssembly assets, local-file access, a configured collaboration server, network connectivity, or provider credentials.

## 3. Run locally

From the repository root:

\`\`\`bash
npm install
npm run typecheck
npm run dev
\`\`\`

Open the local URL printed by Vite. To build and preview:

\`\`\`bash
npm run build
npm run preview
\`\`\`

The package also defines \`npm run server\` to start \`server/index.mjs\`. Inspect server routes, configuration, authentication, and storage before exposing it beyond localhost. A development server is not automatically a production deployment.

## 4. First session

1. Start the application and wait for viewer/panel initialization.
2. Open a project or import a supported model using the current File/import workflow.
3. Fit the model to the viewport.
4. Select an element and inspect its properties.
5. Use the model tree and verify tree-to-viewport selection synchronization.
6. Test visibility and section tools on a disposable model before applying them to a production file.
7. Save/export a test copy and inspect it in the intended target application.

Menu labels can change between versions; use the live UI and command palette as the current authority.

## 5. Navigation and selection

The source tree includes navigation, camera tools, selection, box selection, snapping, gizmo, focus, walk mode and sectioning modules. Verify exact mouse bindings in the current build.

Acceptance sequence:
- Scroll forward/backward and confirm zoom direction.
- Pan and orbit using the configured gestures.
- Test both orthographic and perspective views.
- Test orbit pivot with and without selection.
- Single-select, multi-select and box-select.
- Confirm focus/double-click does not unexpectedly alter selection.
- Confirm context menus act on the intended element.
- Verify scrolling inside panels does not accidentally zoom the model.

See [Master Tool Catalogue — Viewer](MASTER_TOOL_CATALOG.md#2-viewer-navigation-selection-visibility).

## 6. Model visibility and properties

Use the model tree, property palette, visibility/graphics tools, section tools, saved views and MEP coloring where available. Confirm whether a property edit changes authored model data or only displayed metadata. Imported/federated geometry may be read-only or expose a different property set.

Before bulk operations:
1. Save or duplicate the project.
2. Select a small, known set of elements.
3. Record IDs and important properties.
4. Apply the operation and inspect visible and stored results.
5. Test undo or reopen the test copy to establish recovery behavior.

## 7. Authoring

Source modules cover general authoring, primitives, push/pull, parametric families, levels, rooms, stairs, railings, curtain walls, roofs, materials, groups, design options, phases, reference planes, hosted openings and MEP/P&ID-related tools.

For each command establish:
- Supported element categories.
- Whether geometry is parametric or static.
- Editable dimensions and constraints.
- Host/level relationships.
- Persisted fields and schedule inclusion.
- Save/reopen behavior.
- Undo/redo support.
- IFC, CAD, PDF, COBie and quantity workflow inclusion.

A sample mesh, UI button or source module is not proof of a fully associative BIM element. See [Master Tool Catalogue — Authoring](MASTER_TOOL_CATALOG.md#4-bim-authoring-and-element-domains).

## 8. Federation and coordination

The source includes federation management, model links, clash tooling, issue management, BCF, standards/IDS and CDE providers.

Recommended workflow:
1. Use a disposable coordination project.
2. Load the discipline models and record source formats.
3. Confirm units, origins, rotations and elevation offsets.
4. Run a small clash test with one known intersection and one known clearance.
5. Review and validate each result against the model.
6. Create an issue and confirm element references and viewpoint.
7. Export/import BCF if needed and inspect it in an independent BCF-capable application.
8. Record false positives, false negatives and unsupported geometry.

Never assume linked models are aligned automatically. Check transforms against known points.

## 9. Drawings, views and sheets

Source modules include plan/section/elevation generators, annotations, dimensions, tags, sheet layout, drawing/DWG/DXF code and PDF exporters. Validate outputs against a known-scale test drawing:
- Sheet size and orientation.
- View scale and crop.
- Dimension references and precision.
- Text, fonts, line weights and layers.
- Annotation visibility.
- Revision/title-block fields.
- Output page count and printed scale.

A PDF that opens is not necessarily a dimensionally accurate construction drawing.

## 10. Schedules, quantities, cost and 4D

Schedules, quantity extraction, cost, timeline, phases and automation are separate but related workflows. Validate source data before using results for procurement, payment or contractual reporting.

- **Schedules:** check field definitions, sorting, grouping, calculated fields and refresh behavior.
- **Quantities:** establish gross/net rules, opening deductions, unit conversions and supported categories.
- **Cost:** record currency, rate source/date, waste factors, rounding and exclusions.
- **4D:** validate task dates, dependencies, element mapping, baseline and progress rules.
- **Automation:** review triggers and side effects; test against a copy first.

Treat quantities and costs as estimates until reconciled with the project's approved measurement rules.

## 11. IFC, BCF, IDS, COBie, DWG/DXF and PDF

Format coverage and round-trip fidelity vary by entity and implementation. For each exchange:
1. Keep an untouched source file.
2. Export a fixture with representative elements, materials, properties, levels and openings.
3. Open the output in an independent application or schema validator.
4. Compare counts, identifiers, units, coordinates, properties and geometry.
5. Record unsupported entities and warnings.
6. Repeat with a production-sized file.

The existing engineering gap review describes a defined authored IFC subset and lists unsupported classes and checks still required. Review those limitations before relying on authored IFC export for delivery.

## 12. AI and automation

AI chat, provider, embedding and tool modules exist in source. Before using them with confidential project data:
- Identify the provider and whether prompts/model data leave the workstation.
- Configure credentials outside source control.
- Do not send sensitive project information to an unapproved service.
- Review AI-generated actions before execution.
- Distinguish suggestions from deterministic validation results.
- Test timeout, rate-limit and provider-failure behavior.

## 13. Troubleshooting

### Application fails to start
- Run \`npm run typecheck\`.
- Check browser console and terminal output.
- Confirm Node.js version and dependencies.
- Inspect missing WebAssembly/static assets and import errors.

### A button appears but does not work
- Check command registration and whether the target feature loaded.
- Inspect console warnings for missing panels/services.
- Confirm the button is not a placeholder.
- Reproduce with a minimal project and capture the exact command label, browser, console error and steps.

### Model appears displaced
- Check source units, origin, transforms, rotations and elevation.
- Verify link placement and shared-coordinate assumptions.
- Compare a known point against a trusted reference.

### Export is incomplete
- Review console warnings and format-specific limitations.
- Compare element counts and properties.
- Open the export in an independent application.
- Record unsupported categories instead of silently accepting missing geometry.

### Performance is poor
- Test a smaller model and isolate linked models.
- Record model size, element count, browser, GPU and memory.
- Profile rendering separately from clash/import/export.
- Disable nonessential overlays and compare.

## 14. Bug report template

Include:
- Version and Git commit.
- OS, browser and GPU.
- Model format and approximate size.
- Exact tool/command name.
- Numbered reproduction steps.
- Expected versus actual result.
- Console/terminal errors.
- Minimal sample file if safe to share.
- Whether it reproduces in a clean browser session.

## 15. Related documentation

- [Master Tool Catalogue](MASTER_TOOL_CATALOG.md)
- [Developer Guide](DEVELOPER_GUIDE.md)
- [Tool page index/template](tools/README.md)
- Existing authored-IFC implementation and limitation notes.
- [Install and UX notes](../docs/INSTALL_AND_UX.md)
