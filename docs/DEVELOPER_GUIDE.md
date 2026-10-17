# OpenBIMstudio — Developer Guide

## 1. Stack and runtime

The inspected package manifest identifies React 18 and TypeScript; Vite; Three.js, React Three Fiber and Drei; That Open components/fragments/UI packages; web-ifc; Redux Toolkit; Yjs/y-websocket; Material UI; Monaco Editor; PDF tooling; JSZip; CSV parsing; and CAD/DWG-related dependencies.

A package dependency is not proof that every feature uses it or that a production service is configured. Trace imports and runtime paths before documenting an integration.

## 2. Repository map

| Path | Responsibility |
|---|---|
| src/main.ts | Application entry and feature setup orchestration. |
| src/core/ | Shared context, input routing, services, diagnostics, units, errors and utilities. |
| src/shell/ | App shell, ribbon, file menu, home screen, status bar, viewport toolbar and shortcuts. |
| src/features/ | UI-facing features and bridges. |
| src/modules/ | Domain logic and data modules for BIM, federation, clash, views, projects, issues and cost. |
| src/commands/ | Command abstractions and exported commands. |
| scripts/ | Verification, migration, repair, build support and installation scripts. Read scripts before running because some mutate source. |
| tests/ | Automated tests and smoke tests. Review assertions and environment assumptions. |
| server/ | Server entrypoint and related server code. Inspect before deployment. |
| docs/ | Product, implementation, gap and developer documentation. |

## 3. Feature architecture

The project broadly separates user-facing setup modules in src/features/ from domain logic in src/modules/. This is a convention, not an absolute rule: some features combine UI and logic, and bridge modules can modify existing behavior.

Recommended workflow for a new feature:
1. Define the domain contract and stable element/project identifiers.
2. Implement deterministic domain logic under src/modules/<domain>/.
3. Add a UI adapter under src/features/.
4. Register the feature in startup or an explicit registry.
5. Register palette/menu entries only when the feature is available.
6. Define error, notification and cleanup behavior.
7. Add unit tests for geometry/data logic.
8. Add integration tests for registration and state propagation.
9. Add browser acceptance tests for real interaction.
10. Add docs/tools/<tool-name>.md and update the Master Tool Catalogue.

## 4. Startup and registration

src/main.ts imports and starts a broad set of modules, including viewer setup, navigation, selection, import, clash, authoring, projects, issues/BCF, cost, CDE, standards/IDS, model tree, schedules, MEP tools, AI, timeline, automation, sheets, workspace layout and compatibility modules.

Importing a module does not guarantee that its UI is ready. Use the established context/service patterns and report a clear state when a command is invoked before its target feature is available.

src/features/panel-wiring.ts registers commands for Federation, Standards and Common Data Environment. It performs lazy lookup and bounded polling for late-loaded modules. Prefer explicit registration events over permanent polling for new integrations where practical.

## 5. UI registry and persistence

src/modules/ui-registry.ts defines UI items with ID, label, visibility getter, toggle callback, availability flag, optional unavailable hint and group. The UI menu reads/writes obs.ui.visibility.v1 using browser localStorage.

Consequences:
- Visibility is browser-local unless separately synchronized.
- A disabled placeholder can exist without a working feature.
- UI preferences are separate from project model data.
- Use stable IDs and define migrations when IDs change.
- Make toggle failures observable and preserve stored state safely.

## 6. Project persistence and domain stores

Project data is distributed across domain stores. For each new domain, decide whether data belongs to a project, user preference, session or remote collaboration service. Use stable IDs and explicit schema/version fields. Define migration from older projects, ensure project switching swaps all project-scoped state, avoid global localStorage leakage between projects, define deletion semantics, and test deterministic serialization.

Inspect src/modules/projects/ and relevant domain stores before changing persistence. src/modules/bim-gaps/project-scope.ts is also relevant to project-scoped state.

## 7. Geometry and coordinate rules

For every geometry feature, document:
- Internal coordinate system and length units.
- Source-format conversion.
- Model/link transform order.
- Tolerances and their units.
- Local-space versus world-space bounds.
- Rotated, mirrored, sloped and large-coordinate model handling.
- Precision and rounding policy.
- Geometry disposal and memory ownership.
- Supported and unsupported topology.

Clash and quantity outputs need geometry tests, not just UI smoke tests. Include positive, negative, touching, tolerance-boundary, rotated and linked-model fixtures.

## 8. Interoperability contract

For each importer/exporter, maintain a matrix of format/version, supported entities, geometry fidelity, property fidelity, units/transforms, ID/GUID behavior, materials, classification/property sets, unsupported-entity reporting, round-trip status and external validator.

Do not silently drop unsupported geometry. Report warnings that identify the entity and explain the limitation.

## 9. Testing and verification

The package declares commands including:

\`\`\`bash
npm run typecheck
npm run build
npm run verify
npm run verify:v50
npm run verify:v52
npm run verify:v54
npm run test:native-bim
\`\`\`

Inspect each script before assuming its coverage. The repository also includes geometry, IFC, M2, M3, M4 smoke, visibility and native BIM tests.

Recommended pull-request gates:
1. Typecheck.
2. Production build.
3. Focused unit tests for changed domain logic.
4. Relevant version verification script.
5. Browser integration test for UI wiring.
6. Independent-reader validation for exchange changes.
7. Updated docs and known limitations.

A passing typecheck is not runtime proof. A passing unit test does not prove browser integration or external-format conformance.

## 10. Security and deployment

- Never commit API keys, tokens, passwords or provider secrets.
- Review AI/provider integrations for outbound project data.
- Treat imported IFC/DWG/PDF and other files as untrusted input.
- Review server routes, CORS, authentication, authorization, storage and upload limits before network deployment.
- Do not expose a development server as a production service.
- Avoid logging confidential model properties or tokens.
- Document data retention and deletion for remote services.

## 11. Documentation standard

Every new tool should document its purpose, exact activation path, inputs/defaults, prerequisites, outputs, source files/functions, persistence/data schema, failure modes, tests, supported formats, limitations and version/commit.

Use evidence-led language. Prefer “source module exists; runtime behavior not verified” over “fully supported” when no end-to-end test exists.

## 12. Engineering priorities

A defensible route toward a professional BIM authoring platform:
1. Stabilize persistence, identifiers, units and coordinate transforms.
2. Define a canonical native BIM element/data model and validation rules.
3. Establish undo/redo and transaction semantics for editing commands.
4. Complete host relationships, constraints and parametric editability.
5. Make views, dimensions, tags and sheets associative where required.
6. Harden IFC/BCF/IDS/COBie exchange with external validators and fixtures.
7. Validate clash and quantity results on complex geometry.
8. Implement collaboration concurrency, conflict handling and permissions.
9. Add browser regression tests and performance budgets.
10. Publish a feature maturity matrix tied to tests and release versions.
