# Authoring Core — v0.68 (MASTER PROMPT Modules 1, 2, 2B, 2C, 2D, 2E)

This document is the implementation record for the authorized modules of the
*Next-Generation BIM Authoring Engine* specification. It follows the spec's
architecture deliverables and the three mandatory registers. Modules 3–6
(discipline toolsets, view pipeline, worksharing, tech stack) were **not**
implemented, per the spec's strict-scope rule.

Evidence discipline (spec §2): every behavioral claim below is classified.
Nothing in this repository claims "verified against Revit" — the platform
has no Autodesk Revit installation attached, so no level A (verified
observable) or level B (verified API) evidence exists. All Revit-adjacent
statements are level C (public documentation), D (inference, labelled), or
E (proposed engine behavior). Everything actually shipped in v0.68 is
level E with closed-form-verified automated tests.

---

## 1. Modules delivered (all level E unless noted)

### Module 1 — Parametric relationship engine (`src/modules/dependency-graph`, `src/modules/parameter-engine`)

- **1.1 Dependency graph database.** Node kinds: parameter, formula,
  geometry, constraint, host, type, connector, view, quantity, cache. Edge
  kinds per spec. Functions: `addNode`, `removeNode`, `addDependency`,
  `removeDependency`, `getDependencies`, `getDependents`,
  `buildAffectedSubgraph`, `validateAcyclicDependencies`, `detectCycles`,
  `topologicalSort`, `invalidate`, `evaluateNode`, `recompute`. Mutation
  guards: duplicate ids, self-dependencies and prohibited formula cycles
  throw `GraphError`. Complexity: O(1) amortised mutations, O(V+E) cycle
  detection and topological sort, O(V'+E') affected-subgraph recomputation.
- **1.2 Incremental evaluation.** Dirty flags, generation stamping, batch
  coalescing (`beginBatch`/`endBatch` recompute once per batch), cooperative
  cancellation, and failure recovery that keeps the last-good value with the
  error recorded on the node (verified by test).
- **1.3 Cycles.** Iterative Tarjan SCC; classification:
  `circular-formula` (prohibited), `inconsistent-constraints` (prohibited),
  `simultaneous-constraint-system` (legitimate — solved numerically by the
  v0.67 constraint solver, never evaluated sequentially),
  `underconstrained` (reserved for the solver layer).
- **1.4 Constraint solver.** The v0.67 Levenberg–Marquardt solver (11 kinds)
  gained `tangent` (fixed-radius or point-defined radius; residual =
  point-to-line distance − radius) and `concentric` (centre coincidence,
  2 equations). Unknown vector, residual vector, central-difference
  Jacobian, damping adaptation and backtracking unchanged.
- **1.6 Parameter evaluation engine** (`parameter-engine`). Typed
  parameters (length/area/volume/angle/number/integer/text/boolean/
  element-id/url), instance/type/global scopes, builtin/family/shared/
  global/project origins, formula parameters (read-only by rule),
  range validation, unit-aware parsing (`"1500 mm"` → 1.5 internal metres;
  unit suffix must start with a letter), exact unit conversion tables
  (m/cm/mm/ft/in, m²/ft², m³/ft³, rad/deg), display formatting, and
  cross-parameter circular-reference detection routed through the
  dependency graph. Formula grammar = the platform's safe-expr grammar
  (no `eval`/`Function` — inherited, level C by construction).
- **1.7 Transactions.** The graph's batch API coalesces invalidations and
  preserves validity on failure (5.4 atomicity at graph level); document
  transactions remain in `src/modules/transaction` (pre-existing).

### Module 1.5 — Hosting (`src/modules/hosting`)

Host surface parameterisation by curve length `s` for straight and arc
walls (frames: tangent, left normal), compound-layer offsets, opening
placement with sill/head/host-length validation, pairwise overlap
detection (curve overlap AND vertical-range overlap), and host-change
propagation: openings keep their curve parameter (level E policy, matching
the observable behavior that a window keeps its position along a resized
wall); openings that no longer fit are reported invalid with reasons.
`propagateOpeningToNewRadius` preserves angular position when an arc wall's
radius changes (spec worked example B, exact to 1e-9).

### Module 2 — Object hierarchy + solid kernel (`src/modules/object-hierarchy`, `src/modules/solid-kernel`)

- **2.1–2.2 Hierarchy + identity.** Hybrid storage (definition tables +
  sparse instance overrides). Coherence enforcement (family→category,
  type→family). Identity: monotonic element ids never reused after
  deletion; RFC-4122 UUIDs (crypto when available, deterministic fallback);
  uniqueId index with duplicate rejection; external-id slots NOT copied on
  duplication (a copy has no exchange identity yet); host remapping through
  the duplication plan. `changeType` validates same-family (2.11).
- **2.7 B-Rep kernel.** Face/loop/vertex topology with derived edge-use
  tables, manifoldness counting, tolerance-based vertex welding
  (COINCIDENT_TOL = 1e-9 m; never exact float equality, spec 5.2), Newell
  face normals, rigid transforms. The three-representation rule (5.1):
  parametric definition → B-Rep/boundary → display mesh; a display mesh is
  never authoritative for dimensions.
- **2.8 Parametric forms.** `extrude` (closed-profile enforcement,
  O(n²) self-intersection detection, start offsets), `revolve`
  (axis-frame construction with the profile's radial half-plane,
  axis-crossing rejection, partial revolutions with caps), `sweep`
  (per-segment frames via the proven adaptive sweep), `blend` (polar-angle
  resampling to a common vertex count, rectangular↔round lofts). All
  produce outward-wound watertight meshes; volumes verified against closed
  forms (box, cylinder πr²h, frustum (h/3)(A₁+A₂+√(A₁A₂))).
- **2.9 Booleans + voids.** Exact half-space (Sutherland–Hodgman style)
  solid clipping against the cutter's supporting planes. Composition:
  `subtract(A,B)` = A-surface outside B + B-surface inside A flipped
  (B convex; A any closed mesh — walls with existing openings work);
  cavity detection probes just OUTSIDE each void face (flush/through-
  openings handled exactly). `union`/`intersect` require both operands
  convex AND non-coplanar (see Deviation Register D-3). Broad phase:
  median-split AABB tree with per-triangle leaf refinement; narrow phase:
  Möller triangle-triangle (two-mesh form) plus a robust 3-direction
  majority-vote point-in-solid test. Sequential void cutting with per-void
  records and a rollback guarantee (input never mutated).
- **2.12 Validation.** `validate.ts`: open profiles, self-intersections,
  zero-length edges, degenerate faces, non-manifold edges (use-count and
  winding), inverted volume, invalid booleans, missing references,
  unresolved hosts, unsolvable constraints (bridged from the solver
  status), invalid formulas (bridged from the parameter engine). Every
  diagnostic carries severity, code, affected ids, a recovery action and a
  commit-eligibility verdict; errors block commit, warnings do not.
  Topology checks weld coincident vertices first (boolean output is a
  geometrically-watertight polygon soup, not an indexed solid).

### Module 2B — Interactive modeling (`src/modules/snapping`, `src/modules/relationships`, `src/modules/mep/connectors`)

- **2B.1 State machine.** 13 states, explicit transition table (illegal
  transitions throw), the eight spec functions, temp-state cleared on
  commit/cancel/failure, validation gating commit.
- **2B.2 Magnetic snapping.** 20 reference kinds with baseline priorities,
  screen-space tolerance filtering, tool/domain compatibility gates,
  deterministic scoring (distance 0.65 / priority 0.35 / depth penalty),
  hysteresis (configurable margin), lock maintenance with a wider release
  band, indicator data (glyph + legend), temporary constraints that are
  session-scoped and NEVER persisted — the only path to persistence is
  `convertSnapToPersistentRelationship`, and `createRelationship("temporary-snap")`
  throws by design.
- **2B.3 Wall–column connection.** Rectangle detection; ray–plane contact
  candidates (spec formula t = ((Q−P₀)·n)/(d·n), forward hits only);
  compound-wall pullback Δ = ℓ·|p·n|/|d·n| derived so the full end cap
  clears the face plane (0 for perpendicular approaches, 0.1 m for the
  spec's 45°/0.2 m case — exact); near-parallel approaches refused by the
  analytic path; endpoint validation (on-edge, no penetration, plausibility)
  with on-edge points explicitly not "interior"; relationship creation and
  `UpdateWallAfterColumnChange` re-resolution with repair-or-report.
- **2B.4 Alignment.** Spec residuals exactly (point-on-line
  r = (P−Q) − [(P−Q)·u]u; point-on-plane r = (P−Q)·n), one-time vs locked
  alignment, conflict detection with the EXACT allowed move along the
  proposed direction (t* = −2(r·u)/(u·u), the second intersection with the
  locked-distance circle).
- **2B.5–2B.6 Relationship registry.** 13 relationship types with explicit
  separation of contact / join / engineering connectivity; records carry
  local offsets, priorities, geometry versions, reconnection and deletion
  policies. Reconnection: `follow-source` (exact rigid composition
  R(Δθ)·offset + source + translation), `fixed-world`, `local-reference`
  (rotation about the source's new frame), `becomes-invalid`. Suspension,
  breaking, orphan cleanup and post-reload reconciliation are implemented
  and tested.
- **2B.7 MEP connector intelligence.** Compatibility gates on domain, flow
  direction and system classification; size/shape transitions are
  resolvable through reducer/transition fittings (reported via `sizeDelta`
  and `CalculateRequiredFittings`) — never rejected merely for being close
  or different-sized. Route preview with elbow detection at direction
  changes; atomic engagement; topology validation (closed loops,
  disconnected equipment, size jumps without fittings); disconnect releases
  both sides.

### Module 2C — Modify engine (`src/modules/modify`)

`IModifyCommand` contract (CanExecute/Begin/UpdatePreview/Validate/Commit/
Cancel/GetAffectedElements/GetRequiredReferences/GetDiagnostics) with a
shared pending-change-set core: pinned/editable/lock gates, preview never
mutates, validation errors refuse commit with ZERO partial application
(verified), Cancel discards. Commands: Move (translation + numeric offset
+ alignment-conflict blocking), Rotate (Rodrigues arbitrary-axis helper +
planar pivot rotation; the local curve is frame-relative and NOT rewritten),
Align (one-time or locked-through-the-registry), Offset (edge-direction
corner intersection, closed-ring degeneracy via orientation flip or convex
erosion collapse |d| > A/s), Trim/Extend (parametric side selection;
extend decides by parameter sign), Split (original keeps id; new part gets
a fresh id), Copy/Array-linear/Array-radial/Mirror (fresh ids, deep-cloned
parameters, host remapping upstream, world-space mirror re-expressed in the
new local frame).

### Module 2D — Property panel engine (`src/modules/properties-panel/schema|lifecycle|dimensions`)

- 21-field `PropertyDefinition` metadata (id, names, description, data
  type, unit, defaults, editability + read-only reason, kind
  editable/calculated/read-only/formula/override, range, allowed values,
  formula, scope, shared-parameter id, validation rule, dependencies,
  precision, group, visibility predicate, propagation policy) — asserted
  for every definition of all 19 covered categories.
- Category schemas (spec 2D.4 baseline): walls, columns, beams, floors,
  doors+windows, generic families/equipment, pipes+ducts, conduits+cable
  trays, MEP fittings, levels+grids, stairs+railings, curtain walls,
  reinforcement.
- Editing lifecycle: the 12 named functions; unit-aware parsing through the
  parameter engine; atomic rejection (a failed step writes nothing);
  multi-select common/`*VARIES*` values with per-element provenance
  (instance-override / type / formula / default); engine-backed parameters
  outside the schema surface through synthesized definitions; preview
  writes-then-restores so nothing persists.
- Editable dimensions: measured/reference/driving/locked/calculated/
  annotation-only roles; driving edits produce parameter changes AND the
  exact geometric move (bearing preserved; angular edits move the tracked
  ray); zero-value rejection; preview re-evaluates formula dependents
  against the planned value then undoes.

---

## 2. Reverse-Engineering Evidence Register (spec 3.11.1)

| ID | Feature | Evidence level | Source | Confidence | Notes |
|----|---------|----------------|--------|------------|-------|
| RE-1 | Formula parameters are read-only/computed | E | Platform design (safe-expr) | High | Consistent with public Revit documentation of formula-driven parameters (level C context) |
| RE-2 | Temporary snaps are not persistent constraints | E | Spec §3.4 mandate | High | Enforced by API: `temporary-snap` records are refused |
| RE-3 | Walls join/heal at coincident endpoints; locked distances survive edits | D | Public Revit user docs describe constraint persistence; internal mechanism unobserved | Medium | Implemented via the numeric LM solver (v0.67) |
| RE-4 | Wall endpoints land on column faces accounting for wall thickness | D | Observable Revit behavior widely documented in user guides; exact pullback formula is our derivation | Medium | Δ = ℓ·\|p·n\|/\|d·n\| is level E mathematics |
| RE-5 | Openings keep their position along a resized wall | D | Public user docs; not experimentally verified here | Medium | Implemented as constant curve parameter `s` |
| RE-6 | Type-value changes propagate to non-overriding instances | D | Public Revit docs on type/instance parameters | Medium | EffectiveValue precedence chain, tested |
| RE-7 | Duct/pipe size transitions require fittings, not refusal | D | Public MEP documentation; fitting families | Medium | Reducer/transition in `calculateRequiredFittings` |
| RE-8 | Element ids never reused after deletion; copies get new ids | D | Public API docs describe ElementId/UniqueId semantics | Medium | IdentityService policy |
| RE-9 | Pinned elements reject Modify commands | D | Public Revit docs (pinning) | High | Gate in `CanExecute` |
| RE-10 | Contact ≠ join ≠ connectivity | E | Spec §3.4 mandate | High | Distinct relationship types |

No entry is marked level A or B. The register intentionally contains no
"verified against Revit" rows (spec §10 completion rule).

## 3. Assumptions and Open Questions Register (spec 3.11.2)

| ID | Assumption / question | Priority | Validation method | Status |
|----|----------------------|----------|-------------------|--------|
| A-1 | "Exterior = approach side" for wall justification when a wall meets a column | Medium | Compare against Revit experiments (user-owned) | Open |
| A-2 | Openings keep curve parameter `s` (not absolute world position) on host curve edits | Medium | Revit experiment: move a wall's end, observe window behaviour | Open |
| A-3 | Locked-distance allowed move along the proposed ray (t* solution) matches user expectation vs interactive re-solve | Medium | UI prototype + user testing | Open |
| A-4 | Round-size compatibility step (25 mm) for "no reducer needed" | Low | Compare with manufacturer fitting catalogues | Open |
| A-5 | Exact oblique pull-back Δ = ℓ·\|p·n\|/\|d·n\| vs Revit's interactive join cleanup at obtuse angles | High | Revit experiment with 45°/60° wall-to-column approaches | Open |
| A-6 | Snap priority table values (endpoint 100 … nearest 20) | Low | Usability testing; configurable via `SnapSettings.priority` | Open (configurable) |
| A-7 | Boolean outputs are polygon soups; topology validation welds first — downstream consumers must not rely on shared vertex indices | High | Internal contract; documented here | Accepted (documented) |

## 4. Revit Compatibility Deviation Register (spec 3.11.3)

| ID | Deviation | Reason | User impact | Interop impact | Status |
|----|-----------|--------|-------------|----------------|--------|
| D-1 | No "verified against Revit" claims anywhere | No Revit installation available; spec forbids unevidenced claims | None (honest documentation) | None | Approved |
| D-2 | Constraint cycles among geometry/constraint nodes are legal (simultaneous systems) | Matches the numeric-solver architecture; spec 1.1 distinguishes them from formula cycles | Positive (richer modelling) | None | Approved |
| D-3 | `union`/`intersect` throw on coplanar operands; subtract requires a convex cutter | Half-space clipping is exact and testable where a full CSG kernel would be risky; wrong geometry is worse than a precise error | Errors carry actionable messages; void cutting (the dominant case) is unaffected | IFC import paths unaffected (no boolean round-trips) | Approved — full CSG kernel is a tracked future milestone |
| D-4 | Boolean output is a polygon soup; validators weld before topology checks | Keeps the kernel dependency-free and Node-testable | None visible | None | Approved |
| D-5 | Unit-suffix parsing accepts only letter-initial units ("1500 mm", not "1500 ²") | Prevents bare numbers parsing as number+unit | Negligible | None | Approved |
| D-6 | `follow-source` reconnection composes rotation about the SOURCE reference, not the world origin | Deterministic local semantics; world-origin rotation is the caller's composition | Behaviour documented; rigid bodies follow correctly when the caller passes the source's true displacement | None | Approved |
| D-7 | Local curve is not rewritten by pure rotations (frame-relative geometry) | Matches transform composition T_world = T_parent·T_local (spec 5.3) | None | None | Approved |

## 5. Coverage matrix (spec §9, engine-level)

| Category | Snap refs | Alignment | Hosting | Relationships | Move | Rotate | Offset | Trim/Ext | Copy/Mirror | Split | Property schema | Dim edit | Propagation | Validation | Tests |
|----------|-----------|-----------|---------|---------------|------|--------|--------|----------|-------------|-------|-----------------|----------|-------------|------------|-------|
| Walls | endpoint/centerline/core+finish faces/grid | yes | host (1.5) | endpoint-constraint, wall-join | yes | yes | yes | yes | yes | yes | WALL_SCHEMA | yes | solver+registry | yes | ✓ |
| Columns | column-boundary/grid | yes | n/a | structural-connection | yes | yes | n/a | n/a | yes | n/a | COLUMN_SCHEMA | yes | registry | yes | ✓ |
| Beams/framing | endpoint/centerline | yes | n/a | structural-connection | yes | yes | yes | yes | yes | yes | BEAM_SCHEMA | yes | registry | yes | ✓ |
| Floors/slabs | face/grid | partial | n/a | contact | yes | yes | closed rings | n/a | yes | n/a | FLOOR_SCHEMA | partial | registry | yes | ✓ |
| Doors/windows | host faces | yes | opening (1.5) | host | follows host | follows host | n/a | n/a | yes (re-host upstream) | n/a | DOOR_WINDOW_SCHEMA | n/a | hosting engine | yes | ✓ |
| Generic families | family-reference/work-plane | yes | host | face-attachment | yes | yes | n/a | n/a | yes | n/a | GENERIC_FAMILY_SCHEMA | yes | registry | yes | ✓ |
| Pipes/ducts | connector-origin/axis | connector axis | n/a | mep-connection | yes | yes | route offset | n/a | yes (reconnect upstream) | route split upstream | PIPE_DUCT_SCHEMA | n/a | connectors engine | yes | ✓ |
| Conduits/cable trays | connector-origin | partial | n/a | system-membership | yes | yes | n/a | n/a | yes | n/a | CONDUIT_CABLETRAY_SCHEMA | n/a | registry | yes | ✓ |
| MEP fittings | connector-origin | n/a | n/a | mep-connection | yes | yes | n/a | n/a | yes | n/a | FITTING_SCHEMA | n/a | connectors engine | yes | ✓ |
| Levels/grids | grid/level | yes | n/a | persistent-alignment | yes | n/a | n/a | n/a | yes | n/a | LEVEL_GRID_SCHEMA | n/a | registry | yes | ✓ |
| Stairs/railings | endpoint/grid | partial | level-based | host | yes | yes | n/a | n/a | yes | n/a | STAIR_RAILING_SCHEMA | partial | registry | yes | ✓ |
| Curtain walls | family-reference | partial | n/a | system-membership | yes | yes | n/a | n/a | yes | n/a | CURTAIN_WALL_SCHEMA | n/a | registry | yes | ✓ |
| Reinforcement | endpoint | n/a | host | host | yes | yes | n/a | n/a | yes | n/a | REINFORCEMENT_SCHEMA | n/a | registry | yes | ✓ |

"partial"/"n/a" are explicit per spec §9 (no ambiguous blanks). UI-level
wiring of these engine capabilities into the plan-view tools is a separate
milestone (see §8).

## 6. Feature status (spec §10)

Status per feature = max reached stage. Stages: Specified → Implemented →
Unit-tested → Integration-tested → Regression-tested → Verified-against-
Revit (NOT CLAIMED anywhere).

| Feature | Status |
|---------|--------|
| Dependency graph + incremental evaluation | Integration-tested (acceptance 2E.8) |
| Cycle detection/classification | Unit-tested |
| Parameter engine (EffectiveValue, formulas, units) | Integration-tested (2E.5, 2E.9) |
| Constraint solver tangent/concentric | Unit-tested (closed forms) |
| Hosting + opening regeneration | Integration-tested (2E.3) |
| Object hierarchy + identity | Unit-tested |
| Solid forms (extrude/revolve/sweep/blend) | Unit-tested (closed forms) |
| Booleans + void cutting | Unit-tested (exact volumes) + Integration (2E via cutVoids) |
| Geometry validation | Unit-tested |
| Snapping engine + state machine | Unit-tested |
| Wall–column connection | Integration-tested (2E.1) |
| Alignment + conflict detection | Integration-tested (2E.7) |
| Relationship registry + reconnection | Integration-tested (2E.6, 2E.8) |
| MEP connectors + topology | Integration-tested (2E.4) |
| Modify commands (9) | Integration-tested (2E.6, 2E.7) |
| Property panel engine + dimensions | Integration-tested (2E.5, 2E.9) |
| Verified-against-Revit | **Not claimed (register RE/D above)** |

## 7. Verification

- `tests/v68-engine-core.test.cjs` — 20 assertions: graph semantics,
  batching, cancellation, Tarjan classification, failure recovery,
  EffectiveValue precedence, unit parsing, circular references, identity,
  duplication, solver tangent/concentric.
- `tests/v68-solid-hosting.test.cjs` — 25 assertions: exact volumes
  (extrude, cylinder, frustum, sweep), boolean identities (7 = 8−1,
  contained voids, overlapping voids without double-counting, coplanar
  through-openings), AABB precision, validation diagnostics, host frames,
  opening placement/overlaps, propagation.
- `tests/v68-authoring-interaction.test.cjs` — 33 assertions: snap
  pipeline determinism/hysteresis, state machine flows, wall–column
  perpendicular/oblique/miss, alignment residuals/conflicts, relationship
  policies (all four, exact positions), MEP compatibility/fittings/
  topology, every Modify command incl. atomicity, property metadata/lifecycle/
  mixed-values, dimension driving, identity uniqueness.
- `tests/v68-acceptance.test.cjs` — the ten mandatory 2E scenarios.
- `scripts/verify-v68.mjs` — 44 structural milestone checks, wired into CI.

## 8. Implementation dependencies and next milestone

Dependency order honoured: dependency-graph → parameter-engine →
object-hierarchy → solid-kernel/hosting → relationships → snapping →
mep-connectors → modify → properties-panel → acceptance.

Recommended next milestones (spec Modules 3–6 remain blocked pending
explicit instruction):
1. UI wiring of the engines into plan-view tools (snap indicators,
   modify gizmos, property panel binding to `__obsProperties`).
2. Full CSG kernel for non-convex union/intersect (removes D-3).
3. Module 3 (architectural/structural/MEP discipline toolsets) upon
   explicit instruction.
