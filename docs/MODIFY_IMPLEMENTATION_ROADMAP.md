# Modify Subsystem — Incremental Implementation Roadmap

**Rule:** one independently reviewable vertical slice per PR. No large rewrite. A feature moves to Complete only after UI, model, geometry, parameters, relationships, transaction, undo/redo, persistence, validation, performance and regression gates pass.

## Delivery priorities

| Priority | Objective | Scope |
|---|---|---|
| P0 | Core model integrity | canonical command registry, selection identity, atomic transaction/history, dependency graph, capability resolver, pin/delete safety, stable references |
| P1 | Professional authoring | move/rotate/mirror/align/offset/trim/split, profile editing, properties/type workflows, dimensions, clipboard, linked snap |
| P2 | Advanced BIM | associative arrays, groups, assemblies, parts, annotation, views/sheets, family/type editors |
| P3 | Advanced MEP/structural | persistent connectors, route solutions, circuits/panels UI, fabrication, rebar constraints/layout, analytical model |
| P4 | Productivity | global command search, shortcut manager, green-dot release tracking, bulk operations, saved selection queries |
| P5 | Enterprise/automation | worksharing ownership, audit trail, policy/permissions, batch command API, scripting/automation hooks, telemetry and performance dashboards |

## Work packages

### P0.1 — Canonical command registry
- Add `src/modules/modify/registry.ts` with typed metadata and capability predicates.
- Migrate `modify-actions.ts`, `context-menu-model.ts`, ribbon and command palette to registry adapters.
- Enforce unique IDs, valid category names, shortcut conflict reporting and missing-handler diagnostics.
- Tests: registration, filtering, permission, selection count, heterogeneous selection, no stale UI.

### P0.2 — Transaction/history consolidation
- Inventory all write paths and select one transaction/history authority.
- Add adapters for legacy `features/history.ts` and `modules/transaction`; migrate modify writes.
- Store semantic forward/inverse patches including geometry and relationship deltas.
- Commit relationship propagation, connector updates, quantity/schedule invalidation and persistence in one atomic unit.
- Tests: injected failure at each commit stage, rollback invariants, undo/redo roundtrip, concurrent revision conflict.

### P0.3 — Selection/reference identity
- Define `ElementRef` with modelId, elementId, sourceKind, sourceModelId, subElementId, geometryRevision.
- Unify OBC fragments, authored native objects, linked CAD/IFC, point cloud, annotations and connector/bar handles.
- Add stale reference detection and deterministic Tab candidate cycling.
- Tests: same GUID in two linked models, link reload, geometry revision, nested pick candidates, window/crossing.

### P0.4 — Delete/pin integrity
- Add dependency preflight and explicit cascade/detach/rehost policies.
- Distinguish user pin from host-driven association and read-only link state.
- Tests: host with inserts, dimension/tag, MEP fitting, circuit, group member, linked model and worksharing lock.

### P1.1 — Transform vertical slices
1. Move 3D (rigid objects, host/dependent closure, numeric input, axis constraints).
2. Rotate (arbitrary axis and category orientation adapters).
3. Mirror (handedness, normals, host and connector remap).
4. Align (typed reference pairs, optional persistent lock).
5. Offset (analytic curves and category profiles).
6. Trim/extend and split (curve then MEP then host/solid categories).
Each PR adds command registry entry, diagnostics, inverse transaction and all relevant tests.

### P1.2 — Geometry edit sessions
- Typed EditSession API: begin/draft/validate/commit/cancel.
- Implement wall/floor/roof profile editor, then split face/paint, then solid join/cut relationships.
- Preserve element identity; invalidate stale face/edge references.
- Geometry kernel acceptance includes robust predicates, tolerances and degenerate geometry.

### P1.3 — Properties and type semantics
- Typed PropertyDefinition includes scope, units, source, readOnly, formula, validation, dependencies and schema GUID.
- Add type edit impact preview; duplicate/rename/replace and family flex workflow.
- Add shared/project/global parameter binding and IFC property-set provenance.

### P1.4 — Clipboard and duplication
- Versioned clipboard payload; copy/paste aligned to same location/current view/level/selected reference.
- Dependency remap policy; no silent host/system/circuit duplication.
- Associative array model is a separate P2 feature, not a loop of independent copies.

### P2 — Advanced BIM
- Group edit session with exclusion/restore and shared definition semantics.
- Assembly membership + generated views/sheets.
- Parts provenance and boundary editing.
- View/sheet/viewport and annotation editors.
- Type/family editing with flex tests.

### P3 — MEP and structural
- Stable connector IDs and family-aware connector definitions; explicit graph as source of truth.
- Route solution candidate generator with fitting library, clearance/clash and pressure/flow validation.
- Electrical circuit/panel workflows and schedules.
- Fabrication-part service-aware edits.
- Rebar constraint target editor, local coordinate frame, 3D path distribution and variable spacing; analytical object/load/support model.

### P4/P5 — productivity and enterprise
- Global search powered by registry synonyms and natural-language aliases.
- Shortcut manager with collision detection and import/export.
- Green-dot release acknowledgement lifecycle.
- Bulk edit preview, progress/cancellation, dry-run, audit and undo.
- Worksharing leases, optimistic concurrency, permissions and auditable changes.

## Mandatory PR checklist

- [ ] Research/evidence link and release scope
- [ ] Capability predicate and command metadata
- [ ] Selection/reference semantics
- [ ] Preview is side-effect free
- [ ] Validation diagnostics and recovery
- [ ] Atomic transaction and rollback
- [ ] Undo/redo restores relationships and derived state
- [ ] Save/reopen persistence test
- [ ] Geometry/constraint/MEP/category tests
- [ ] UI/context-menu/shortcut/search integration
- [ ] Performance benchmark and cancellation
- [ ] Golden regression (geometry, quantities, schedules, views)
- [ ] Feature status updated from evidence
- [ ] Documentation and migration notes

## First recommended implementation

Start with **P0.1 + P0.2 as a combined architecture PR** only after separately writing tests against current behavior. The repository already has multiple command entry points and two history abstractions; expanding category-specific buttons before resolving these would multiply inconsistent behavior.
