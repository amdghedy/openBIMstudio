# OpenBIMstudio Modify — Repository Gap Analysis

**Audit date:** 2026-11-02  
**Audited ref:** `main` at `65ca9e0395880a59efaaf95b97a872faedd5bbdb`  
**Method:** recursive repository tree + targeted source/test inspection. This is a source-evidence audit, not a browser end-to-end certification. “Partial” means code exists but the full professional completion criteria have not been demonstrated.

## Executive summary

OpenBIMstudio already has a meaningful Modify foundation; it is not starting from zero. The repository contains command abstractions, transform/edit/duplicate modules, selection and snapping engines, constraints, transactions/history, relationships, MEP, rebar, groups, properties, context menus, and test suites.

The primary gap is **integration and semantic completeness**: multiple layers exist but not all are proven to share one registry, one transaction boundary, one relationship graph, and one persistence/undo contract. In particular, category-aware contextual command availability, robust host-aware geometry edits, connector identity/compatibility, electrical editing UI, and comprehensive linked/reference selection remain major work.

## Evidence inventory

| Capability | Inspected repository evidence | Finding |
|---|---|---|
| Generic modify contract | `src/modules/modify/command.ts` | Implemented foundation; current contract uses CanExecute/Begin/UpdatePreview/Validate/Commit/Cancel |
| Move/rotate/mirror | `src/modules/modify/transform.ts`, `group1.ts` | Implemented mathematical/core paths; verify all native element categories and relationship atomicity |
| Offset/trim/split | `src/modules/modify/edit.ts` | Implemented polyline/line-oriented operations; solid/profile/category coverage incomplete |
| Align/split-gap/wall corner | `src/modules/modify/group2.ts` | Implemented targeted cases; not general face/edge/center alignment |
| Copy/array | `src/modules/modify/duplicate.ts` | Core clone and linear/radial placement exist; full associative arrays and paste-aligned workflows unverified |
| UI modify actions | `src/features/modify-actions.ts` | Actions include move/copy/paste/rotate/mirror/array/offset/scale/create-similar/match-props/select-similar/align/pin/unpin/split/join/delete |
| Options surface | `src/features/modify-options.ts` | Selection-aware dimensions/values exist; not equivalent to complete category-specific command options |
| Selection manager | `src/features/selection.ts`, `src/modules/selection/index.ts` | Selection snapshots, multi-model, named sets and hit/window selection foundations |
| Snapping | `src/modules/snapping`, `src/features/snapping.ts`, `src/features/cad-underlay-snap.ts` | Spatial/magnetic/geometry snapping foundations; reference typing and stale-ref safety require unified integration |
| Constraint solver | `src/modules/constraints/solver.ts`, `src/modules/parametric-constraints`, `src/features/constraint-solver.ts` | Solver and wall integration exist; complete general constraint taxonomy not proven |
| Transaction/history | `src/modules/transaction/index.ts`, `src/features/history.ts` | Two history/transaction systems are present; consolidation/adapter and cross-module atomicity are P0 |
| Relationship graph | `src/modules/relationships` | Persistent relationship registry exists; audit edge coverage and propagation policy per command |
| MEP topology | `src/modules/mep/connectivity.ts`, `connectors.ts`, `router.ts`, `sizing.ts`, `slope.ts`, `stretch.ts` | Meaningful MEP foundations; connectivity currently has geometry-derived rules/tolerances and must be reconciled with persistent connector IDs |
| Electrical | `src/modules/mep/electrical.ts` | Circuit/panel/load data and calculations exist; user-facing editing workflows and robust model integration remain |
| Rebar | `src/modules/rebar/layout.ts`, `geometry.ts`, `shapes.ts`, `schedule.ts`, `standards.ts` | Layout/geometry/quantity/clash capabilities; layout comments note axis-aligned assumptions for common host cases; full constraint-handle editor not evidenced |
| Groups | `src/modules/groups/groups.ts`, `src/modules/model-groups` | Group storage/type/instance foundation; full interactive edit and atomic propagation need validation |
| Properties | `src/features/property-schema.ts`, `property-palette.ts` | Schema-driven property UI exists; type/family/global/shared parameter semantics need completion |
| Context menu | `src/features/context-menu-model.ts`, `context-menu.ts`, `element-context-menu.ts` | Data-driven menu foundation; one canonical registry integration not established |
| Annotation/views | `src/modules/views/annotation-*.ts`, `src/features/*crop*`, `scope-box` | Multiple annotation and view-editing features exist; category-complete sheet/viewport behavior not proven |
| Tests | `tests/modify*`, `history.test.cjs`, `selection-box.test.cjs`, `constraint-solver.test.cjs`, MEP/rebar tests | Broad test footprint; acceptance matrix still lacks end-to-end coverage for every command/category |

## Gap matrix

| Command family | Required | Existing evidence | Complete | Partial | Missing / next implementation | Priority | Proposed location |
|---|---|---|---:|---:|---|---|---|
| Select / multi-select / window / crossing | Yes | selection manager + selection module + tests |  | ✓ | unify native + fragment + link + subelement identity; selection policy tests | P0 | `src/modules/selection` |
| Filter / select by property / previous selection | Yes | selection filters and named sets |  | ✓ | query DSL, persisted previous set, linked source selectors | P1 | `src/modules/selection/query.ts` |
| Move | Yes | transform + group1 |  | ✓ | all-axis 3D, hosts, MEP graph, atomic transaction | P0 | `src/modules/modify` |
| Rotate | Yes | transform + group1 |  | ✓ | arbitrary axis, family facing/hand, connectors and view-plane policy | P1 | `src/modules/modify` |
| Mirror | Yes | group1/duplicate |  | ✓ | handedness, host, connector remapping, annotation policies | P1 | `src/modules/modify` |
| Copy / paste aligned | Yes | duplicate + modify-actions clipboard |  | ✓ | cross-project schema, level/view/same-place paste, dependency remap | P1 | `src/modules/clipboard` |
| Linear/radial array | Yes | duplicate |  | ✓ | associative parent, edit count/spacing, constraints, persistence | P2 | `src/modules/modify/array.ts` |
| Align | Yes | group2 + alignment snap |  | ✓ | face/edge/center/datum/connector references and persistent lock | P0 | `src/modules/modify/align.ts` |
| Offset | Yes | edit.ts + action |  | ✓ | analytic curves, solid profiles, category restrictions | P1 | `src/modules/modify/offset.ts` |
| Trim/extend | Yes | edit.ts |  | ✓ | robust 3D intersections, MEP fitting reconciliation, multiple mode | P1 | `src/modules/modify/trim-extend.ts` |
| Split / split with gap | Yes | edit.ts/group2 |  | ✓ | all category policies, connectors, identity, phase/type/host copy | P1 | `src/modules/modify/split.ts` |
| Join/unjoin/cut/uncut | Yes | wall join action; geometry helpers |  | ✓ | persistent solid join/cut relation + switch order + rollback | P1 | `src/modules/geometry/relationships` |
| Edit sketch/profile/shape | Yes | native twin geometry/plan polygon, wall tools |  | ✓ | common typed edit-session framework and category editors | P1 | `src/modules/edit-sessions` |
| Pin/unpin | Yes | modify-actions |  | ✓ | host-driven vs independent pin semantics; linked/worksharing | P0 | `src/modules/modify/pin.ts` |
| Delete/dependency cascade | Yes | deleteSelectedElement and history |  | ✓ | dependency preflight UI, detach/cascade policies, atomic multi-delete | P0 | `src/modules/modify/delete.ts` |
| Property editing | Yes | property schema/palette |  | ✓ | source/scope/formula/type/shared/global parameter semantics | P1 | `src/modules/parameter-engine` |
| Type editing | Yes | family/type mechanisms partially |  | ✓ | duplicate/rename/replace/load type compatibility + impact preview | P2 | `src/modules/types` |
| Constraint engine | Yes | solver, parametric constraints, level/dim constraints |  | ✓ | generic constraints, solver DOF, cycles, conflict UX, persistent locks | P0 | `src/modules/constraints` |
| Temporary/permanent dimensions | Yes | plan dimension geometry and annotation modules |  | ✓ | driving dimension model relation, witness editing, units/rounding | P1 | `src/modules/views/dimensions` |
| MEP connectors | Yes | connectors + connectivity |  | ✓ | persistent stable connector IDs, family/equipment definitions, compatibility | P0 | `src/modules/mep/connectors.ts` |
| MEP routing/fittings | Yes | router, elbow/fitting geometry, sizing/slope |  | ✓ | local route edit, fitting replacement, route solution preview/commit | P1 | `src/modules/mep/router.ts` |
| MEP system graph | Yes | connectivity, lifecycle, pressure |  | ✓ | logical vs physical topology, system split/merge and incremental checks | P1 | `src/modules/mep/connectivity.ts` |
| Electrical circuits/panels UI | Yes | electrical data module |  | ✓ | add/remove circuit, panel schedule edit, assignment/validation UI | P1 | `src/features/electrical` |
| Rebar shape/constraints | Yes | rebar shape/layout/geometry |  | ✓ | constraint target editor, arbitrary orientation, 3D path/variable spacing | P3 | `src/modules/rebar` |
| Group edit | Yes | group store |  | ✓ | group edit session, exclusions/restores, transaction propagation | P2 | `src/modules/groups` |
| Assemblies | Yes | no complete subsystem evidence |  |  | member/type/views/sheets | P3 | `src/modules/assemblies` |
| Parts | Yes | no complete subsystem evidence |  |  | derived provenance, divide/merge, boundary editing | P3 | `src/modules/parts` |
| Linked model selection | Yes | linked model/drawing snap foundations |  | ✓ | source IDs, subelement selection, read-only enforcement, copy/monitor | P1 | `src/modules/links` |
| View/sheet/viewport | Yes | crop/scope/view modules |  | ✓ | sheet placement, viewport alignment/title, open placed views | P2 | `src/modules/views` |
| Annotation edit | Yes | annotation layers/interactions |  | ✓ | tags/text/keynotes/dim leaders and reference updates | P2 | `src/modules/views` |
| Analytical model | Yes | not enough source evidence |  |  | analytical object model, loads/supports/combinations | P3 | `src/modules/analytical` |
| Fabrication part edit | Yes | fabrication module |  | ✓ | service-aware part editing and fabrication validation | P3 | `src/modules/mep/fabrication` |
| Modify command registry | Yes | action IDs/context menu exist |  | ✓ | canonical metadata registry drives all UI surfaces | P0 | `src/modules/modify/registry.ts` |
| Command search | Yes | command palette exists |  | ✓ | registry-backed synonyms/category/selection/capability filtering | P1 | `src/features/command-palette.ts` |
| Green-dot status | Yes | no centralized release metadata evidence |  |  | feature state + first-seen acknowledgement | P4 | `src/modules/modify/feature-status.ts` |
| Performance/large selection | Yes | spatial index modules |  | ✓ | budgets, cancellation, incremental invalidation, perf CI | P0 | `tests/performance/modify` |

## Important architecture risks

1. **Two history systems:** `src/features/history.ts` and `src/modules/transaction/index.ts` coexist. Decide a single source of truth and provide adapters; don't allow a modify command to commit in one history stack while dependent edits land in another.
2. **Relationship propagation after geometry writes:** audit each command to ensure dependency updates are inside the same transaction, not a post-commit best-effort mutation.
3. **Selection source identity:** fragment IDs, native element IDs, linked source IDs and subelement references must not collide.
4. **MEP topology:** geometry-derived proximity is useful for recovery/legacy models, but must not replace stable connector identity for authored systems.
5. **Rebar orientation:** current layout assumptions must be removed or isolated behind a local coordinate frame before arbitrary host orientation is claimed.
6. **Property scope:** type-level edits must preview all impacted instances; avoid applying type edits as instance patches.
7. **UI source of truth:** modify-actions, context menus, command palette and ribbon must consume the same registry metadata.

## Audit limitations

This was a repository tree and targeted-source review. It did not execute the full app, inspect every file, or prove every command through browser interaction. Items marked Partial/Missing are based on inspected evidence; reclassify only after locating implementation plus passing tests and live workflow proof. No command is marked Complete in this gap table because this audit did not execute the complete DoD test stack.
