# MODIFY GROUP 1 BEHAVIORAL SPECIFICATION — v0.71

**Master prompt:** *Modifying, Editing, and Object Behavior Specification* (uploaded spec, 15 sections).
**Scope of this document:** Group 1 only — **Selection, Reference Acquisition, Move, Rotate, Mirror** (spec §15, group 1 of 7).
**Execution discipline (spec §15):** this specification, its data model, function catalog and validation rules are complete BEFORE any implementation code. Work stops after Group 1.

---

## 0. ADAPTATION DECISIONS (binding)

These decisions adapt the uploaded spec to this platform without weakening it:

| # | Spec clause | Adaptation |
|---|---|---|
| A1 | §3 interface is C# `IModifyCommand` | TypeScript. The existing `IModifyCommand` in `src/modules/modify/command.ts` is the canonical contract; Group 1 extends it, never rewrites it. Mapping: `CommandId`→`name`; `Validate()`→`Validate()`; `GetAffectedObjects()`→`GetAffectedElements()`; `GetAffectedRelationships()` is added via the relationship registry; `GetPreview()`→`UpdatePreview()` return value. |
| A2 | Existing-engine mapping (anti-re-specification) | Selection state machine hooks → `src/modules/snapping/state-machine.ts`; snapping → `src/modules/snapping/engine.ts`; persistent relationships → `src/modules/relationships/index.ts`; identity → `src/modules/object-hierarchy` `IdentityService` (never-reused IDs); undo/redo → `src/modules/transaction` `TransactionService`. |
| A3 | Units & tolerances (spec leaves these open) | Internal length unit: **metre** (matches parameter-engine `"1500 mm" → 1.5`). Geometric tolerance (hit-testing, coincidence): **1e-6 m**. Solver tolerance: **1e-9 m**. Angular tolerance: **1e-12 rad**. |
| A4 | Diagnostic IDs (§3.6 of object spec) | Convention `MOD-<CMD>-<NNN>`: `MOD-SEL-nnn`, `MOD-REF-nnn`, `MOD-MOV-nnn`, `MOD-ROT-nnn`, `MOD-MIR-nnn`. Severity ∈ {info, warning, error}. Errors block commit. |
| A5 | Registers (§11) | **Continue** the platform registers — v0.70 ended at A-9 / D-12. New assumptions start at **A-10**, deviations at **D-13**. Evidence entries use the spec §11 classes E1–E6 (E1 verified observable, E2 verified API, E3 documented, E4 inferred internal, E5 proposed engine, E6 unverified). Honesty rule: every behavioral claim in this document is **E5** unless marked otherwise; no claim of Revit-internal knowledge is made anywhere. |
| A6 | Clean-room clause (§11 hardening) | Evidence may come from public documentation and behavioral observation only. No decompilation of Autodesk assemblies, no copied code, no invented Revit API methods. |
| A7 | Performance budgets (§13.25) | Group 1 budgets, Node-tested: selection hit-test over 10 000 elements ≤ 50 ms; window selection over 10 000 elements ≤ 100 ms; a Move/Rotate/Mirror preview regeneration over 1 000 selected elements ≤ 100 ms. |

---

## 1. UNIVERSAL COMMAND ARCHITECTURE (spec §2, §3)

### 1.1 Lifecycle (spec §3.1 — all Group 1 commands)

1. Activate command.
2. Acquire target selection (via the Selection Engine, §2 below).
3. Validate target eligibility (pinned / not editable / locked / linked-model rules).
4. Acquire references and input (Reference Service, §3 below).
5. Resolve snapping and alignment (snap engine; a temporary snap NEVER becomes persistent unless an explicit lock is created — spec §2.3).
6. Generate preview (pending change set; preview never mutates the store).
7. Validate preview (all §3.3 rules).
8. Evaluate dependencies (hosted follow set, connected set — §4.1/§5.1/§6.1).
9. Create transaction (`TransactionService.start`).
10. Apply geometric and parametric changes (pending change set replay).
11. Resolve constraints (alignment conflict detection; blocked moves produce errors, not silent failure).
12. Update relationships (geometry version bump + `evaluateRelationshipAfterGeometryChange` with each record's reconnection policy).
13. Regenerate dependent geometry (hosted/connected re-evaluation results applied).
14. Update quantities, schedules, views, analytical data (engine-observable via version bump; host application reads versions).
15. Commit or roll back (atomic: any failure replays inverse changes and returns the model to the pre-command state).
16. Record undo and redo data (committed transaction pushed to undo stack; redo stack cleared).

### 1.2 Mandatory command metadata (spec §3.2)

Every Group 1 command carries: command id, supported/unsupported categories, required selection count, required/optional references, keyboard modifiers, numeric input support, snap behavior, alignment behavior, defaults, preview rules, validation rules, dependency rules, transaction boundary, undo/redo behavior, failure conditions, messages, performance constraints, tests. These are tabulated per command in §4, §5, §6.

### 1.3 Mandatory validation rules (spec §3.3)

Before commit, every command validates: editability (element `editable`), selection validity (non-empty, all elements exist), reference validity (Reference Service status `valid`), geometric validity (non-degenerate transform), parameter validity (if parameters are touched), constraint solvability (alignment residuals), host validity (hosted elements still have valid hosts), relationship validity (reconnection policy resolvable), connector compatibility (untouched by Group 1 — N/A), analytical validity (N/A in Group 1 — analytical sync is Group 6), quantity validity (N/A — quantities derive from versions), material validity (untouched), phase/design-option validity (untouched in Group 1), workset/ownership validity (`lockedElementIds`), transaction integrity (no partial application).

Explicit Group 1 scope note: rules marked N/A are validated as "not touched by this command" — they are NOT silently skipped; the validation report lists each rule with status `pass | fail | not-applicable`.

---

## 2. SELECTION BEHAVIOR (spec §4.1)

### 2.1 Data model

```ts
interface SelectableElement {
  id: string; categoryId: string; typeId?: string;
  pinned: boolean; hidden: boolean; editable: boolean;
  linkedModel?: boolean; groupId?: string; hostedOnId?: string | null;
  // plan-view hit geometry (any of):
  aabb?: { min: [number, number]; max: [number, number] };
  curve?: { start: [number, number]; end: [number, number] };
  point?: [number, number];
  params?: Record<string, number | string | boolean>;
}
```

### 2.2 Hit-testing rules

Default pick radius `r = 0.05 m` (configurable). For each candidate element, sub-hits are computed:

| Sub-kind | Test | Base priority |
|---|---|---|
| vertex | distance(point, curve.endpoints or point) ≤ r | 100 |
| edge | distance(point, curve segment) ≤ r | 90 |
| connector | element exposes connector positions within r | 70 |
| datum | datum elements (levels/grids/ref planes in plan) within r | 60 |
| face/body | point inside aabb (2-D containment) | 40 |

Ranking: **priority descending, then distance ascending, then id ascending** (deterministic tie-break; E5). Overlapping objects therefore resolve predictably: a vertex beats an edge beats a body at the same pick point.

### 2.3 Selection modes

- **Single pick** — top-ranked hit replaces the selection.
- **Multi-select** — Shift adds/toggles; the selection is an ordered, de-duplicated id list preserving first-click order.
- **Window (inside)** — rectangle [a, b]; element selected iff its geometry is *fully* inside (aabb fully inside; curve: both endpoints inside; point: inside).
- **Crossing** — element selected iff its geometry *intersects* the rectangle (aabb overlap test).
- **By category / by type / by parameter predicate** — filtered scan of all visible elements.
- **By ID** — direct id list; missing ids produce `MOD-SEL-004` info diagnostics, not errors.
- **Inversion** — visible, selectable elements minus current selection.

### 2.4 Behavioral rules

- **Hidden objects** are not hit-testable and not window-selected (default). A `includeHidden` filter override exists for recovery tooling; selecting a hidden element emits `MOD-SEL-005` warning.
- **Pinned objects ARE selectable** (so the user can select-and-unpin). Editing commands reject them at `CanExecute` (existing rule; pinning is an editability flag, not a geometric constraint).
- **Read-only / linked-model objects** are selectable only when the corresponding filter flag is set; they always fail edit eligibility (`editable=false`), producing `MOD-MOV-001`-style errors in modify commands.
- **Group behavior** — picking one member selects the whole group when `selectWholeGroups` is enabled (default true, E5); individual member selection requires group ungrouping or an explicit `selectSingleMember` override.
- **Hosted/connected/dependent/related expansion** — expansion queries the relationship registry (`hosted-on`, `attachment`, `connects`, and all other records). Expansion results are ADDED to the selection, de-duplicated.
- **Multi-category selection** is permitted; per-category eligibility is checked at command activation, not at selection time.

### 2.5 Function catalog (selection)

`HitTest(point)` · `SelectSingle(point)` · `SelectWindow(a, b, mode)` · `SelectByCategory(cats)` · `SelectByType(typeId)` · `SelectByParameter(pred)` · `SelectByIds(ids)` · `Invert()` · `AddToSelection(id)` · `RemoveFromSelection(id)` · `ToggleSelection(id)` · `ExpandHosted(id)` · `ExpandConnected(id)` · `ExpandDependents(id)` · `ExpandRelated(id)` · `SetFilter(f)` · `GetSelection() · Clear()`.

### 2.6 Validation & diagnostics (selection)

| Code | Severity | Condition |
|---|---|---|
| MOD-SEL-001 | info | empty hit (no element at pick point) |
| MOD-SEL-002 | warning | pinned element selected (edit will be rejected) |
| MOD-SEL-003 | warning | read-only / linked-model element selected |
| MOD-SEL-004 | info | select-by-id encountered unknown id |
| MOD-SEL-005 | warning | hidden element force-selected via filter override |
| MOD-SEL-006 | error | hit-test invoked with degenerate pick radius (≤ 0) |

---

## 3. REFERENCE ACQUISITION (spec §4.2)

### 3.1 Reference kinds and canonical frames

Every acquired reference carries a right-handed orthonormal frame `{origin, xAxis, yAxis, zAxis}` plus optional `position`/`direction`. Frame construction rules (E5):

| Kind | Origin | Axes | Notes |
|---|---|---|---|
| face / host-surface | pick point projected on surface | z = surface normal, x = projection of world X (fallback world Y) | orientation for face-based placement |
| edge | nearest point on edge to pick | x = unit tangent, z = surface/context normal fallback world Z | |
| vertex | the point | world axes | |
| centerline / location-line / analytical-axis | start point | x = unit direction | line-based placement |
| reference-plane / work-plane | plane origin | z = plane normal, x = in-plane direction | |
| grid | intersection of grid with current level plane | x = grid direction, z = world Z | |
| level | [0, 0, elevation] | world axes | elevation datum |
| connector | connector position | z = flow/engagement direction | MEP |

Orthonormalization: Gram-Schmidt on (x, z) then y = z × x; zero-length directions are rejected with `MOD-REF-002`.

### 3.2 Persistence rules (spec §2.3 — binding)

An acquired reference is **command-scoped and non-persistent** by default. It becomes persistent ONLY through an explicit user action (e.g., Align with lock → persistent-alignment relationship — existing `AlignCommand.Commit` behavior). Temporary acquisition NEVER silently becomes a constraint.

### 3.3 Reference lifecycle

- `status: "valid"` at acquisition.
- Owner geometry change → owned references become `"stale"` (`geometryVersion` bump detected); a stale reference must be re-acquired before use in a new command; using a stale reference produces `MOD-REF-004` error.
- Owner deletion → owned references become `"broken"`; broken references are refused everywhere (`MOD-REF-005`).
- Datum references (level/grid/ref-plane) have no element owner; they invalidate only via explicit datum change notifications.

### 3.4 Command eligibility (valid/invalid categories, spec §4.2)

`REFERENCE_ELIGIBILITY` maps each kind to the commands that may consume it (Move: any point-derived kind for base/target; Rotate: pivot from vertex/edge/face/grid/connector; Mirror: axis from edge/centerline/location-line/reference-plane/grid/level-edge). An ineligible use yields `MOD-REF-006`.

### 3.5 Function catalog (references)

`Acquire(input)` · `Get(id)` · `Status(id)` · `ValidateForCommand(ref, command)` · `MarkGeometryChanged(ownerId, version)` · `MarkOwnerDeleted(ownerId)` · `Clear()` (command scope end).

### 3.6 Diagnostics (references)

| Code | Severity | Condition |
|---|---|---|
| MOD-REF-001 | info | reference acquired |
| MOD-REF-002 | error | zero-length direction / degenerate frame |
| MOD-REF-003 | error | unknown kind |
| MOD-REF-004 | error | stale reference used |
| MOD-REF-005 | error | broken reference used |
| MOD-REF-006 | error | reference kind not eligible for the command |

---

## 4. MOVE (spec §5.1)

### 4.1 Command metadata

| Field | Value |
|---|---|
| Command ID | `move` |
| Supported categories | all selectable, editable, unpinned elements |
| Unsupported | pinned (`MOD-MOV-002`), not editable (`MOD-MOV-001`), workset-locked (`MOD-MOV-003`) |
| Required selection | ≥ 1 |
| Required references | base point, target point (or numeric displacement) |
| Numeric input | `{dx, dy}` in metres |
| Keyboard modifiers | axis constraint x / y (also programmatic) |
| Snap behavior | target resolved through snap engine; temporary snap only |
| Defaults | axis constraint none |
| Transaction boundary | one transaction per commit, name `"Move"` |

### 4.2 Geometric algorithm

Translation of every selected element by Δ = target − base:

```
P' = P + Δ          (spec §5.1 formula)
T' = T_Δ · T        (transform composition)
```

Axis-constrained move: with unit axis â, the constrained displacement is the projection

```
Δ' = (Δ · â) â
```

Numeric displacement bypasses base-point acquisition (Δ given directly).

### 4.3 Dependency behavior

- **Hosted elements** (hosted-on / attachment relationships with follow policies): each hosted element NOT itself selected receives the same Δ in the preview (rigid follow, E5 consistent with existing `follow-source` reconnection policy). If a hosted element is also selected it is moved exactly once (de-duplication by id).
- **Connected elements**: not moved during preview; after commit, `evaluateRelationshipAfterGeometryChange` runs with the new geometry version and each record's reconnection policy decides follow / suspend / break, producing per-element actions.
- **Constraints**: a move that violates a locked persistent alignment is BLOCKED with error `MOD-MOV-010` (existing `detectAlignmentConflict` integration); the model is unchanged.
- **Quantities/schedules/views/analytical**: derived data invalidates via geometry version bump; no direct mutation in Group 1.

### 4.4 Function catalog (mandated by spec §5.1 — exact names)

`BeginMove(ids)` · `AcquireMoveBasePoint(p)` · `ResolveMoveTarget(p, opts)` · `CalculateMoveVector()` · `GenerateMovePreview()` · `EvaluateMoveDependencies()` · `ValidateMove()` · `CommitMove()` · `CancelMove()` · `UndoMove()` · `RedoMove()`.

`UndoMove`/`RedoMove` delegate to `TransactionService` when wired (undo replays inverse changes in reverse order; redo replays forward). Without a transaction service the tools still guarantee preview/commit atomicity, but persistent undo is unavailable (`MOD-MOV-020` info).

### 4.5 Transaction, undo, redo, rollback

- Commit: `start("Move")` → replay pending patches as recorded changes (each change carries before/after patches) → `commit()`.
- Failure mid-apply: replay recorded changes in reverse (rollback), return `{ok:false}`, diagnostics carry `MOD-MOV-030`.
- Undo/redo granularity: the whole move is ONE undoable unit (all selected + hosted followers).

### 4.6 Diagnostics (move)

| Code | Severity | Condition |
|---|---|---|
| MOD-MOV-001 | error | element not editable |
| MOD-MOV-002 | error | element pinned |
| MOD-MOV-003 | error | element locked by another user |
| MOD-MOV-010 | error | locked alignment conflict — move blocked |
| MOD-MOV-011 | warning | hosted element follows the moved host (info-level in previews is `info`) |
| MOD-MOV-020 | info | no transaction service wired — undo unavailable |
| MOD-MOV-030 | error | apply failure — rolled back |

---

## 5. ROTATE (spec §5.2)

### 5.1 Command metadata

| Field | Value |
|---|---|
| Command ID | `rotate` |
| Required references | rotation pivot (vertex/edge/face/grid/connector reference); axis defaults to world Z in plan |
| Numeric input | angle in radians (UI converts degrees) |
| Angular snap | optional step `s`; snapped angle `θ' = round(θ / s) · s` (default step 15° = π/12 when snapping enabled) |
| Defaults | axis = world Z, snap off for programmatic use, on for interactive |
| Transaction boundary | one transaction per commit, name `"Rotate"` |

### 5.2 Geometric algorithm

Planar rotation about pivot Q by θ (special case of the spec's Rodrigues formula with u = world Z):

```
p' = Q + R(θ)(p − Q),   R(θ) = [cosθ −sinθ; sinθ cosθ]
orientation: θ_element' = θ_element + θ
```

3-D axis rotation uses the existing `rotateAboutAxis` (Rodrigues, spec formula `R = I·cosθ + (1−cosθ)uuᵀ + [u]×sinθ`).

Two-point angle acquisition: `θ = atan2(end − Q) − atan2(start − Q)` (signed, CCW positive).

### 5.3 Dependency behavior

- **Hosted elements** rotate about the SAME pivot: position rotated by R(θ), own `rotationZ` += θ (rigid-body consistency; E5).
- **Connected elements**: post-commit relationship evaluation as in Move.
- **Connector orientation**: connector directions rotate by R(θ) (planar components).
- **Analytical axis**: rotates with the element (version bump marks it stale for Group 6 consumers).

### 5.4 Function catalog (mandated by spec §5.2 — exact names)

`BeginRotate(ids)` · `AcquireRotationAxis(axis?)` · `AcquireRotationPivot(p)` · `ResolveRotationAngle(input, opts)` · `GenerateRotationPreview()` · `ValidateRotation()` · `UpdateDependentOrientations()` · `CommitRotation()` · `CancelRotation()`.

### 5.5 Validation & diagnostics (rotate)

Zero-radius guard: any element whose position coincides with the pivot within 1e-9 is rotation-invariant (info `MOD-ROT-020`, not an error). Degenerate zero-length axis → `MOD-ROT-002` error. Angular snap only when explicitly enabled; a snapped preview records the pre-snap angle in diagnostics info. Non-zero angle required for commit (committing θ = 0 is a no-op rejection with `MOD-ROT-021` info).

| Code | Severity | Condition |
|---|---|---|
| MOD-ROT-001 | error | element not editable / pinned / locked (shared eligibility) |
| MOD-ROT-002 | error | zero-length rotation axis |
| MOD-ROT-010 | warning | rotation may violate persistent alignment |
| MOD-ROT-020 | info | element coincident with pivot — rotation-invariant |
| MOD-ROT-021 | info | zero-angle rotate rejected as no-op |

---

## 6. MIRROR (spec §5.3)

### 6.1 Command metadata

| Field | Value |
|---|---|
| Command ID | `mirror` |
| Required references | mirror line (point + direction) — acquired from edge / centerline / location-line / reference-plane / grid |
| Modes | `copy=true` (default): mirrored COPIES, originals preserved. `copy=false`: originals transformed in place (requires explicit confirmation flag in UI; E5 Revit-like default is copy) |
| Transaction boundary | one transaction per commit, name `"Mirror"` |

### 6.2 Geometric algorithm

Reflection across the line `{Q + t·d}`, `|d| = 1`:

```
direction reflection matrix (2-D):  M = 2·d·dᵀ − I
point reflection:  X' = Q + M·(X − Q)
orientation mapping: θ' = 2φ − θ,  φ = atan2(d.y, d.x)
```

Because M is orientation-reversing (det M = −1):

- mirrored elements get `rotationZ' = 2φ − rotationZ`;
- handed parameters flip: `hand` 0↔1, `facing` 0↔1 when present (`ResolveMirroredOrientation`);
- local curve re-expression (world-space mirror re-expression, existing v0.68 discipline): world endpoints are mirrored, then the local curve is recomputed in the new element frame: `local_end = R(−θ')·(X'_world − position')`.

### 6.3 Copy semantics

- New element IDs come from the injected allocator (IdentityService discipline: never reused, no external-id copying).
- Parameters cloned; type preserved; materials preserved.
- **Relationship cloning** (`CloneRelationships`): relationships touching mirrored elements are cloned for the mirrored copies with mirrored reference geometry; `origin` is preserved; reconnection policy preserved. Relationships between two mirrored elements are cloned once between the two copies (not twice).
- **Host remapping**: a mirrored copy of a hosted element is hosted on the mirrored host when the host is also mirrored; otherwise the copy detaches to the same level/work plane with a `MOD-MIR-010` warning (host geometry is not mirrorable without its own mirror).
- Mirror of a pinned element: pin state is NOT copied (copies start unpinned; E5).

### 6.4 Function catalog (mandated by spec §5.3 — exact names)

`BeginMirror(ids, copy?)` · `AcquireMirrorPlane(point, dir)` · `CalculateMirrorTransform()` · `GenerateMirrorPreview()` · `ResolveMirroredOrientation(el)` · `CloneRelationships(mapping)` · `ValidateMirror()` · `CommitMirror()`.

### 6.5 Diagnostics (mirror)

| Code | Severity | Condition |
|---|---|---|
| MOD-MIR-001 | error | element not editable / locked |
| MOD-MIR-002 | error | zero-length mirror direction |
| MOD-MIR-003 | warning | mirrored element collides with original (overlap detected) |
| MOD-MIR-010 | warning | hosted copy detached — host not mirrored |
| MOD-MIR-020 | info | move-mode mirror (originals transformed) |

---

## 7. GROUP 1 COVERAGE MATRIX (spec §12, Group 1 columns)

Legend: ✔ supported · ✖ unsupported in Group 1 (reason) · ◐ conditional.

| Category | Select | Move | Rotate | Mirror |
|---|---|---|---|---|
| Walls | ✔ | ✔ | ✔ | ✔ |
| Doors / Windows | ✔ | ✔ (with host) | ✔ (with host) | ◐ host must mirror too (MOD-MIR-010) |
| Floors / Ceilings / Roofs | ✔ | ✔ | ✔ | ✔ (boundary re-expression) |
| Stairs / Railings / Ramps | ✔ | ✔ | ✔ | ✔ |
| Rooms / Areas / Spaces | ✔ | ✔ | ◐ boundaries regenerate | ◐ |
| Columns / Beams / Braces | ✔ | ✔ | ✔ | ✔ |
| Foundations / Piles | ✔ | ✔ | ✔ | ✔ |
| Reinforcement | ✔ | ✔ (with host) | ◐ | ✖ (host-dependent layout, Group 6) |
| Pipes / Ducts / Conduits / Trays | ✔ | ✔ | ✔ | ◐ fittings regenerate (Group 6 for full topology) |
| MEP fittings / equipment | ✔ | ✔ | ✔ | ✖ handed equipment (explicit ✖ per spec §12) |
| Generic families | ✔ | ✔ | ✔ | ✔ |
| Adaptive families | ✔ | ✔ | ✔ | ◐ placement points mirror (Group 6 validation) |
| Levels / Grids / Ref planes | ✔ | ✔ | ✖ datums don't rotate ( Revit-consistent, E3/E5) | ✖ |
| Openings / Shafts / Voids | ✔ | ✔ (with host) | ◐ | ◐ |
| Curtain walls / systems | ✔ | ✔ | ✔ | ◐ grids regenerate |
| Site elements | ✔ | ✔ | ◐ | ✖ topo surfaces (Group 6) |

Unsupported entries are EXPLICIT marks per spec §12, not omissions.

---

## 8. ACCEPTANCE TESTS (spec §13 → Group 1)

| Spec §13 class | Group 1 test |
|---|---|
| 1 valid selection / 2 invalid selection | selection engine tests: priority, filters, hidden/pinned rules |
| 3 missing references | mirror without direction → MOD-MIR-002; rotate without pivot → error |
| 4 valid / 5 invalid modification | move with alignment conflict blocked (MOD-MOV-010) |
| 6 preview generation / 7 preview cancellation | preview patches computed, store unmutated; Cancel discards |
| 8 commit / 9 rollback / 10 undo / 11 redo | TransactionService-wired tools restore exact state |
| 12 host movement / 13 host rotation / 14 host deletion | hosted-follow in move; hosted rotate about same pivot; deletion cleanup is Group 4 (out of scope here) |
| 15 type change / 16 parameter change | Group 5 (out of scope) |
| 17 constraint conflict | locked alignment blocks move |
| 18 circular dependency | N/A Group 1 (dependency graph owns) |
| 19 connector compatibility / 20 MEP topology | Group 6 |
| 21 opening/void regeneration | Group 3/4 |
| 22 quantity / schedule updates | version-bump invalidation tested |
| 23 view invalidation | version bump observable |
| 24 multi-selection editing | multi-element move/rotate/mirror with de-duplication |
| 25 performance at scale | A7 budgets, Node-timed |

No Group 1 behavior is "complete" without the test evidence above (spec §13 closing rule).

---

## 9. REGISTERS (continuation)

### 9.1 Modify Behavior Evidence Register (Group 1)

| ID | Behavior | Class | Basis |
|---|---|---|---|
| E-M1-01 | selection hit priority vertex>edge>connector>datum>body | E5 | proposed engine behavior, deterministic ranking |
| E-M1-02 | window vs crossing semantics | E5 | proposed (matches common CAD semantics; no Revit-internal claim) |
| E-M1-03 | pinned selectable / not editable | E5 | platform rule from v0.68 spec 2C.9 |
| E-M1-04 | reference command-scoped non-persistence | E5 | spec §2.3 binding rule |
| E-M1-05 | move P'=P+Δ, T'=T_ΔT | E1 | closed-form math, test-verified |
| E-M1-06 | rotate Rodrigues formula | E1 | closed-form math, test-verified |
| E-M1-07 | mirror M = 2ddᵀ − I, θ' = 2φ − θ | E1 | closed-form math, test-verified |
| E-M1-08 | hosted rigid-follow policy | E5 | consistent with existing follow-source reconnection |
| E-M1-09 | mirror copies start unpinned | E5 | proposed |
| E-M1-10 | Revit moves hosted elements with host | E3 | documented product behavior (public docs); platform reproduces via follow policy |

### 9.2 Assumptions Register (continuation — starts at A-10)

- **A-10** — selection pick radius 0.05 m is adequate for plan-view interaction at typical BIM scales.
- **A-11** — hosted elements follow hosts rigidly (same Δ / same θ) in Group 1; non-rigid host deformation reactions belong to the hosting module (Group 6).
- **A-12** — angular snap default 15° for interactive rotation; programmatic API defaults to exact angles.

### 9.3 Deviation Register (continuation — starts at D-13)

- **D-13** — Revit mirrors hosted elements by mirroring within the host context; this engine detaches mirrored hosted copies whose host is not mirrored (MOD-MIR-010) rather than silently re-hosting on an unrelated host. Justification: explicit over implicit; the warning is actionable.
- **D-14** — datum elements do not rotate/mirror in Group 1. Justification: datum orientation changes are datum-edit operations, not modify-tool operations.
- **D-15** — grid snap of rotation is off by default in the programmatic API (Revit UI defaults on). Justification: engine-level determinism; the UI layer enables snapping.
- **D-16** — for hosted rigid follow the TOOL is the sole geometry writer during commit (exact same-Δ / same-pivot-θ math), and the relationship registry's stored reference geometry is refreshed afterwards via `updateRelationshipReference`; non-host relationships reconcile through the registry as before. Justification: the registry's `follow-source` evaluation rotates stored offsets about the source's *stored* reference position, which coincides with the tool's rigid-body result only for translations and rotations whose pivot is that stored reference — the tool's math is exact for arbitrary pivots, so it wins, and the refresh keeps subsequent evaluations coherent. Out-of-plane rotation axes are rejected in Group 1 (MOD-ROT-022) pending the 3-D element model (Group 6).

### 9.4 Known limitations / open questions (spec §14 items 21–22)

- Mirror relationship cloning covers relationships known to the registry; relationships stored elsewhere (e.g., future workset metadata) are out of scope until Group 6.
- 3-D rotation of hosted stacks (non-planar) is deferred to Group 6 with the analytical work.
- Open question OQ-M1: should crossing-window selection use exact curve intersection instead of aabb overlap at fine detail levels? (deferred; aabb is deterministic and fast — A7).

---

## 10. IMPLEMENTATION MAPPING (post-spec, per §15 discipline)

| Spec unit | Implementation file |
|---|---|
| Selection engine (§2) | `src/modules/selection/index.ts` (new, pure) |
| Reference service (§3) | `src/modules/references/index.ts` (new, pure) |
| Move/Rotate/Mirror catalogs (§4–6) | `src/modules/modify/group1.ts` (extends existing commands, pure) |
| Global exposure | `v68-register.ts` → `__obsSelection`, `__obsReferences`, extended `__obsModify` |
| UI wiring | `engine-ui.ts` dialogs + ribbon buttons (Selection Inspector, Reference Picker, Move/Rotate/Mirror numeric tools) |
| Tests | `tests/v71-modify-group1.test.cjs` (closed-form + §8 classes) |
