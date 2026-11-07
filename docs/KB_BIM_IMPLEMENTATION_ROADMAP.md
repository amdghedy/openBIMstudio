# KB-BIM Intelligent MEP — Architecture and Delivery Roadmap

## Product decision

- Platform: OpenBIMStudio (web-native, openBIM-first).
- Optimization: hybrid deterministic engineering solver plus AI-assisted learning/ranking.
- Scope: complete product, delivered in independently testable increments.
- Design authority: hard engineering constraints and qualified engineer approval.
- Data strategy: preserve IFC/source identifiers and provenance; do not silently rewrite source models.

## Repository audit snapshot

Repository: amdghedy/openBIMstudio  
Audited branch: main  
Audited commit: 601240626f1d4e0afa1f249ecd6049d995e0ebed  
Application version at audit: 0.74.0  
Architecture: React/TypeScript/Vite browser application, Three.js/That Open/web-ifc, domain modules under src/modules, UI adapters under src/features, background workers under src/workers, optional server under server/.

### Existing foundations confirmed in source

| Capability | Existing source | Audit status |
|---|---|---|
| 3D voxel A* routing | src/modules/mep/router.ts | Existing foundation; route envelope and fitting realism need further work |
| MEP system types and sizing | src/modules/mep/types.ts, sizing.ts | Existing; engineering profile provenance needs formalization |
| Duct/pipe pressure calculations | src/modules/mep/pressure.ts | Existing calculation aids; not complete design certification |
| MEP connectivity | src/modules/mep/connectivity.ts | Existing geometry connectivity; graph/system semantics need strengthening |
| Connector compatibility and route previews | src/modules/mep/connectors.ts | Existing; source documentation identifies transaction/geometry integration gaps |
| Electrical loads/circuits/panels | src/modules/mep/electrical.ts | Existing validation/schedule APIs; not a complete electrical design workflow |
| MEP UI and fabrication catalog | src/features/mep-fabrication.ts, mep-balance-panel.ts | Existing partial UI; not a CSD optimization workspace |
| Clash detection | src/features/clash-engine.ts, src/modules/clash/ | Existing geometry/clash infrastructure |
| IFC and Fragments | web-ifc integration, src/features/ifc-to-frag.ts and export modules | Existing; validate class/geometry/property coverage per format |
| Generic constraint solver | src/features/constraint-solver.ts | Existing general constraint feature; not a KB-BIM service packing solver |
| Test infrastructure | tests/mep-*.test.cjs, scripts/ci-unit-tests.mjs | Existing; new CSD regression suite registered |

### Missing dedicated KB-BIM capabilities

The audit did not find a dedicated end-to-end implementation for:
- MEP section-plane extraction into service cross-section envelopes with source provenance.
- CSD candidate packing and engineer-facing candidate comparison.
- A project-configurable MEP engineering knowledge base with rule citations and versioning.
- Expert candidate grading and traceable labelled training records.
- ANN or learning-to-rank trained on approved CSD solutions.
- NDCG@K evaluation and ranking reports.
- Multi-section corridor optimization with transition continuity.
- Explicit crossover-zone optimization.
- CSD approval-to-model transaction and rollback workflow.

These are repository audit findings, not claims that no related code exists anywhere in the application.

## Target architecture

Keep the solver and engineering data contracts independent from the viewer and AI providers.

    IFC / Fragments / Native model adapters
                  |
                  v
       MEP geometry extraction
                  |
                  v
       Section & envelope model
                  |
          +-------+--------+
          |                |
          v                v
   Knowledge/rules    Geometry index
          |                |
          +-------+--------+
                  |
                  v
       Deterministic CSD solver
                  |
                  v
       Candidate validation gate
                  |
          +-------+--------+
          |                |
          v                v
   Cost/objectives    Expert feedback
          |                |
          |                v
          |         Learning/ranking
          |                |
          +-------+--------+
                  |
                  v
       Candidate comparison UI
                  |
                  v
       Engineer approval workflow
                  |
                  v
       Corridor / 3D route execution
                  |
                  v
       Transactional model adapter
                  |
                  v
       IFC / drawings / reports

### Domain boundaries

- src/modules/mep/: pure engineering contracts, section extraction, rules, packing, corridor optimization, scoring and validation.
- src/workers/: cancellable/background geometry and optimization jobs; serializable request/result contracts.
- src/features/: CSD workspace, configuration panels, candidate comparison, grading, diagnostics and approval.
- src/modules/export/: approved drawing/report/IFC output paths.
- docs/: engineering assumptions, standards provenance, API contracts, benchmarks and known limitations.

AI is an optional ranking and learning service. It cannot bypass hard constraints and must not be required for baseline solver operation.

## Delivery phases and exit criteria

### Phase 0 — Repository baseline and capability map
Status: audited.
Exit criteria:
- Preserve existing MEP modules.
- Record current tests and known integration gaps.
- Maintain a source-to-test capability matrix.

### Phase 1 — Deterministic CSD packing kernel
Status: initial implementation in PR #177.
Delivered in this slice:
- Rectangular section boundary and service envelope contracts.
- Fixed/preferred positions and optional 90-degree rotation.
- Pair clearances and section-edge clearances.
- Hard relationships: left/right, above/below, same centre X/Y.
- Deterministic candidate generation and objective ranking.
- Bounded-search transparency: solved/partial/infeasible/invalid-input.
- Dedicated regression tests and MEP service export.

Exit criteria:
- CSD test suite passes in CI.
- Production TypeScript build passes.
- Test fixtures verify clearances, relations, rotation, deterministic ranking and search-limit behavior.

### Phase 2 — Knowledge base and project profiles
Status: first implementation slice added to the active feature branch.
Delivered in this slice:
- Versioned profile and rule contracts with project/jurisdiction metadata.
- Provenance, approval audit and effective-date validation.
- Pair-specific and edge clearances, preferred service side, service ordering, discipline restrictions and system priority.
- Deterministic rule compilation with draft/expired rule handling and diagnostics.
- Pair-specific clearance support in the CSD solver without inflating unrelated system clearances.
- Dedicated rule-engine regression suite.

Remaining deliverables:

- Typed rule schema and schema version.
- Project profiles with jurisdiction, client, consultant and contractor source references.
- Hard/soft/preference rule classification.
- Rule severity, applicability, units, evidence, approval, effective dates and override permissions.
- Rule validation and deterministic conflict resolution.
- Import/export and migration tests.

Exit criteria:
- No hard-coded universal clearances.
- Every active rule has a source or explicit project approval.
- Conflicting rules produce explainable diagnostics.

### Phase 3 — Real IFC/Fragments cross-section extraction
Deliver:
- Section plane and bounded-volume contracts.
- Actual geometry/mesh-plane intersection and source-element mapping.
- Service dimension extraction and unit normalization.
- Insulation, lining and installation-envelope support where data exists.
- Connector and system metadata capture.
- Provenance and unsupported-geometry diagnostics.

Exit criteria:
- Reproducible section geometry on representative IFC fixtures.
- Geometry coordinates and units validated against known dimensions.
- No silent fallback from missing geometry to fabricated service dimensions.

### Phase 4 — Candidate workspace and validation
Deliver:
- 2D CSD canvas and synchronized 3D selection.
- Candidate list, side-by-side comparison and overlays.
- Hard-rule validation and rejection reasons.
- Cost/objective breakdown and engineer overrides with audit trail.
- Undo/redo for candidate edits.

Exit criteria:
- Every visible candidate maps to a solver result and source elements.
- Invalid candidates cannot be approved.
- UI remains responsive during background solver execution.

### Phase 5 — Expert grading and AI ranking
Deliver:
- Versioned candidate feature vectors.
- Expert grade and criterion-level feedback records.
- Training/evaluation split by project to reduce leakage.
- ANN or learning-to-rank model selected after baseline benchmarking.
- NDCG@K, precision-at-K and calibration reporting.
- Model registry, versioning and rollback.

Exit criteria:
- No AI inference can relax hard constraints.
- Metrics use held-out projects.
- Cold-start deterministic ranking remains available.
- Model explanations show contributing features and uncertainty.

### Phase 6 — Multi-section corridor and crossover optimizer
Deliver:
- Ordered section chain with stationing and geometric transforms.
- Shared element identity across sections.
- Continuity constraints for position, elevation, slope and orientation.
- Transition and crossover-zone candidate generation.
- Global/local objective comparison.
- Constructability checks for transition length, fitting and access envelopes.

Exit criteria:
- No disconnected route transition in accepted corridor solutions.
- Transition geometry is validated in 3D, not only by independent section rectangles.
- Solver reports bounded-search status and unresolved transitions.

### Phase 7 — 3D connector-aware route and model execution
Deliver:
- Connector graph extraction and system topology.
- Real fitting family/port geometry.
- Clearance-aware 3D route generation.
- Slope, flow, pressure and electrical constraints where applicable.
- Native model transaction integration.
- Geometry regeneration after move/resize/delete.
- Save/reload, undo/redo and rollback.
- Preview-before-commit approval.

Exit criteria:
- No connector relationship is inferred from proximity alone.
- Fitting ports, domains, shapes, sizes and directions are validated.
- Model transaction and persistence tests pass.

### Phase 8 — Drawings, reports and production acceptance
Deliver:
- CSD, section, longitudinal and crossover drawing outputs.
- Dimensions, tags, legends, revision and sheet data.
- Rule compliance and candidate decision reports.
- IFC/BCF/IDS handover where supported by the validated exchange matrix.
- Large-model performance benchmarks and installation/user documentation.

Exit criteria:
- Representative model regression corpus passes.
- Deliverables are checked in external readers.
- All unsupported cases are visible to users.
- Engineering approval remains explicit.

## Engineering invariants

1. A weighted objective must never compensate for a hard-constraint violation.
2. Missing engineering data is unknown, not zero and not a default clearance.
3. All dimensions carry units; conversions are explicit.
4. Every candidate and issue retains source element IDs and provenance.
5. A partial search is never labelled exhaustive or globally optimal.
6. AI may rank only candidates that have passed deterministic hard-constraint validation.
7. No original model is modified without explicit approval and a reversible transaction.
8. Calculation aids are not code-compliance certification.
9. All rules are versioned and traceable to a standard, project requirement or approved engineering decision.
10. Performance claims require measured representative workloads.

## Immediate next work after PR #177

1. Implement versioned MEP engineering rule profiles and clearance validation contracts.
2. Implement IFC/Fragments section geometry extraction with source GUID provenance.
3. Add a worker protocol for CSD solving with progress and cancellation.
4. Build a CSD candidate review panel around real extracted geometry.
5. Build expert grading records before selecting/training an ANN model.
