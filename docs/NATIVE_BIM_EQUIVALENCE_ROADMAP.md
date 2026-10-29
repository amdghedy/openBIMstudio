# Native BIM Authoring Equivalence Roadmap

**Status:** Baseline audit and implementation plan  
**Repository:** openBIMStudio  
**Baseline reviewed:** 2026-10-29  
**Goal:** Build a dependable, native, parametric building-authoring workflow on open standards—not merely a viewer with drawing tools.

This roadmap defines measurable behavior. A feature is not considered complete because a toolbar button exists or a source file is present. It must work on a representative project, persist through save/reopen, participate in relationships and schedules where applicable, support undo/redo, and have automated evidence.

## 1. Current baseline

The repository already has substantial foundations: authored element tools, snapping and justification, persistent element relationships, a parametric-family engine, solid operations, MEP routing/connectors, view and sheet generation, model validation, IFC workflows, and a large automated test suite.

The repository's own feature-maturity registry correctly records several boundaries. These are important gaps to close rather than hide:

- **Authoring/hosting:** doors and windows are hosted only on in-app authored walls; arbitrary linked-geometry hosts are not supported.
- **Constraints/dependencies:** rotation propagation does not yet re-solve every dependent geometry relationship; tangent snapping is limited by the available curve-based element set.
- **Modify tools:** the currently verified group covers move, copy, rotate, mirror, array and offset; additional modify groups remain separate work.
- **Interoperability:** IFC round-trip fidelity is not comprehensively measured against a representative external-model corpus; entity-level interchange reports are missing.
- **Documentation:** sheets/views/PDF support is limited compared with a full documentation environment.
- **Schedules and quantities:** take-off is parameter-driven, not yet a full configurable rules-based quantity/cost engine.
- **Collaboration:** persistence is whole-file JSON and conflict semantics need a formal consistency audit.
- **DWG:** import is limited to the documented reader/version coverage; DWG export is explicitly unavailable and must not be presented as implemented.
- **Validation and performance:** some IDS facets, large-model performance budgets and offline end-to-end flows still need evidence.

See `src/features/feature-maturity.ts` for the machine-readable baseline and limitations.

## 2. Non-negotiable native-model contract

Every authored element and relationship must obey these rules:

1. **One canonical model:** element identity, type, geometry, parameters, level, host, material, classification and relationships live in project-scoped model data, not only in viewport meshes or browser-global state.
2. **Parametric regeneration:** changing a driving parameter regenerates dependent geometry deterministically; derived geometry is not the source of truth.
3. **Constraint graph:** hosts, joins, endpoint constraints, alignments, offsets, dimensions and system connections are explicit persistent relationships with validated references.
4. **Transactional edits:** each user operation is atomic, undoable and redoable. Failed validation rolls back without leaving partial geometry, relationships or property changes.
5. **Predictable placement:** active level, work plane, units, justification, temporary dimensions, snapping priority, alignment inference and hosted placement are consistent across tools.
6. **Real documentation:** plans, reflected ceiling plans, elevations, sections, details, schedules and sheets derive from model data and view settings—not unrelated screenshots or duplicated geometry.
7. **Interoperable data:** IFC/BCF/IDS and supported drawing formats preserve identifiers, properties, units, classifications, spatial containment and relationships to the extent each format permits; unsupported content is reported.
8. **Honest maturity:** only features with automated tests and runtime validation on representative files may be marked verified.

## 3. Implementation phases and acceptance gates

### Phase 1 — Native model integrity and editing transactions
- Make the project model the sole authoritative source for authored elements.
- Audit every create/edit/delete/host/join operation for atomic transaction, rollback and one-step undo/redo.
- Validate unique IDs, finite dimensions, valid transforms, host compatibility, level references, relationship cycles and dependent updates.
- Ensure save/reopen retains parameters, types, hosts, joins, constraints, materials and IDs.
- Add regression tests for failed operations and undo/redo after dependent geometry changes.

**Acceptance gate:** invalid operations cannot corrupt a project; save/reopen and undo/redo preserve the same model graph and geometry within documented tolerances.

### Phase 2 — Parametric families and constraint solving
- Complete type/instance parameter separation, formulas, parameter dependency graphs and cycle diagnostics.
- Support family types, instance placement, nested instances, reference planes, labeled dimensions, alignment/lock constraints and type duplication.
- Regenerate geometry from parameters and constraints, including hosted openings and nested elements.
- Add family editor workflows for reference geometry, constraints, preview, type management and validation.
- Report unsatisfied constraints rather than silently breaking them.

**Acceptance gate:** changing a type or instance parameter updates all intended geometry and schedules, while locked relationships remain valid or show an actionable constraint error.

### Phase 3 — Architectural authoring
- Harden walls, wall joins, layered construction, floors, roofs, ceilings, openings, doors/windows, curtain systems, stairs, ramps, railings, columns and beams.
- Add robust curve-based wall/beam/railing paths, end conditions, joins, trims, offsets and boundary editing.
- Complete levels, grids, scope regions, rooms/spaces, room boundaries, area/volume calculation and phase/design-option behavior.
- Implement linked-model references and supported host/snap behavior without pretending linked geometry is editable native geometry.

**Acceptance gate:** representative multilevel architectural models remain geometrically consistent through edits, joins, host changes, copy/mirror and save/reopen.

### Phase 4 — MEP systems and engineering relationships
- Make connectors first-class typed ports with direction, shape, size, system classification and connection rules.
- Complete pipe, duct, conduit and cable-tray routing with configurable elbows, tees, transitions, reducers, slopes, offsets, clearances and obstacle avoidance.
- Add system membership, connectivity graphs, disconnect detection, flow/pressure or load checks where applicable, and deterministic rerouting after edits.
- Add electrical circuits, panel assignment, circuit capacity, panel schedules and single-line diagram generation.
- Add fabrication-oriented parameters and supports/hangers with explicit limits.

**Acceptance gate:** a connected MEP system can be edited without losing valid connections; invalid connections and capacity failures are detected and surfaced.

### Phase 5 — Views, annotations and construction documentation
- Unify plan/elevation/section generation so the same view definition controls viewport, sheet and PDF output.
- Implement view templates and per-view visibility/graphics, detail level, crop regions, phase filters, hidden lines, cut patterns and annotation categories.
- Complete dimensions, temporary dimensions, tags, leaders, text, keynotes, symbols, detail components and revision clouds.
- Complete sheet composition, title blocks, viewports, revision tracking, drawing lists and deterministic PDF export.
- Add automated geometry comparisons between model projections and generated documentation.

**Acceptance gate:** view settings survive save/reopen and generate consistent on-screen and printed drawings for representative projects.

### Phase 6 — Schedules, parameters and quantities
- Implement a typed parameter schema with shared/project/type/instance parameter scopes and safe migration.
- Support schedule field selection, calculated fields, sorting/grouping, filters, totals, units, formatting, itemization and material take-off.
- Ensure schedule edits round-trip to model parameters when editable; identify read-only/derived fields clearly.
- Add rule-based quantity and cost definitions, rounding/measurement rules, exclusions and audit trails.

**Acceptance gate:** schedule values reconcile with model data and documented measurement rules; round-trip edits do not silently lose data.

### Phase 7 — Interoperability and model governance
- Build an IFC import/export conformance corpus covering common spatial, architectural, structural and MEP entities.
- Produce an import/export report for unsupported entities, property loss, geometry fallback, GUID mapping and relationship changes.
- Verify BCF issue round-trips and IDS supported-facet coverage.
- Complete project validation, standards checks, model health reports and reproducible issue exports.
- Keep drawing-format limitations explicit; do not advertise unsupported native DWG export.

**Acceptance gate:** every supported exchange workflow has round-trip tests, known limitations and a machine-readable validation report.

### Phase 8 — Collaboration, reliability and performance
- Define project revisioning, save conflict policy, recovery, merge semantics and collaborative edit ownership.
- Add autosave/recovery tests, offline workflow tests, large-model profiling, memory budgets and worker cancellation.
- Add browser end-to-end acceptance tests for critical authoring, documentation and exchange flows.
- Test security boundaries for plugins, imported files and AI integrations.

**Acceptance gate:** collaboration conflicts are observable and recoverable; performance budgets and critical browser workflows are measured in CI.

## 4. Priority order

Implement in this order to avoid adding more features on an unstable foundation:

1. Transaction/undo-redo and dependency-graph integrity.
2. Parametric family constraints and regeneration.
3. Architectural joins, hosts, levels and spaces.
4. MEP connectors, system continuity and electrical circuits.
5. Consistent views, annotations and sheets.
6. Schedules and rules-based quantities.
7. IFC/BCF/IDS conformance and data-loss reporting.
8. Collaboration and large-model performance.

## 5. Required engineering workflow for each delivery

For each phase:

1. Trace the real UI entry point to the implementation and saved model data.
2. Record existing behavior and reproduce the gap with a failing regression test.
3. Implement the behavior in the shared domain/model layer, not as a visual-only shortcut.
4. Add unit tests for geometry/constraints, integration tests for persistence and undo/redo, and UI/browser acceptance tests where relevant.
5. Run typecheck, targeted tests, the full test suite and production build.
6. Update `src/features/feature-maturity.ts`, the master tool catalogue and user documentation to match the evidence.
7. Do not mark the phase complete until the acceptance gate passes.

## 6. Definition of success

“Native BIM authoring” means model elements behave as connected, parameter-driven building objects across modeling, editing, views, schedules, documentation and exchange. It does not mean copying another product's branding or claiming undocumented feature equivalence. Compatibility must be demonstrated with tests and representative project files.

This roadmap is intentionally staged: the repository has meaningful capabilities already, but matching the depth and reliability of a mature BIM authoring platform requires closing the listed gaps in sequence and verifying each one.
