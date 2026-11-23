# PE-09 findings — property-based kernel invariants (#98)

PE-09 added the property-based invariant suite in `tests/property/`
(fast-check `^4.10.2`, 500 runs per invariant, deterministic seed
`20261122`, shared via `tests/property/seed.ts`, run with
`npm run test:property`). The suite's test files originally pointed at
this record by the bare filename `pr-description-pe09.md`, but no such
file ever existed in the repo — the pointers dangled until the #98
close-out created this file at `docs/engineering/pr-description-pe09.md`
and re-pointed them here.

This file records the three findings PE-09 observed while building the
suite, plus the corrections the #98 close-out measured for the first
one. Each finding names the test that pins it, so a future change to
the behaviour fails loudly instead of silently invalidating the
record.

## 1. Touching-contact union: non-manifold only for edge contact

`tests/property/boolean-closure.test.ts` (3a) originally skipped the
watertight assertion for every touching pair (two boxes sharing a
face, an edge, or a point with zero overlap), on the assumption that
the shared contact survives in the output mesh and the shared edge is
used four times. That assumption was never proven — and it is wrong
for two of the three contact classes.

Measured during the #98 close-out (2026-11-24), all through the
general kernel (`generalBoolean('union', …)` on `generateVoid` boxes,
volumes exact in every class):

| Contact class | Volume | `validateMeshDiagnostics(weldMesh(u))` | `gateSolid` verdict |
|---|---|---|---|
| Face (1 zero-overlap axis) | exact (2 for unit boxes) | 0 errors, 0 non-manifold edges | `ok`, no registry record |
| Point (3 zero-overlap axes) | exact | 0 errors, 0 non-manifold edges | `ok`, no registry record |
| Edge (2 zero-overlap axes) | exact | 1 non-manifold edge | `quarantined`, recorded (admitted) |

The general kernel's coplanar pass gives single-copy skin ownership
for face and point contact, so those unions are watertight. Only edge
contact leaves the shared edge used four times — the real kernel
limitation is merging coincident contact faces for that class.
Fixing it is kernel-validity work, out of scope for the invariants
item, but the class is pinned, not skipped: (3a) now asserts
closedness for face/point contact and asserts the non-manifold
signature (≥ 1 non-manifold edge, exact volume) for edge contact, so
an edge-contact union silently becoming watertight fails the property
and forces the carve-out to be removed.

The non-manifold touching-contact class still exists for producers
that keep both skins of a contact (raw soup, imported tessellation,
three-csg-ts output): concatenating two closed unit boxes that share
a face gives 4 non-manifold edges with exact volume, and the K1
validation gate (`gateSolid`, `src/modules/solid-kernel/validation-gate.ts`)
quarantines it — admitted, but recorded in the quarantine registry
(visible via `listQuarantinedSolids()`), never silently whitelisted.
That producer-side case is pinned by
`tests/property/kernel-contact.test.ts` (C4), alongside deterministic
pins of the three general-kernel contact classes (C1–C3).

For contrast, the convex kernel (`booleanOp`, `src/modules/solid-kernel/csg.ts`)
refuses coplanar face/edge contact outright by throwing
("operands have coincident (coplanar) faces; offset one operand or
use subtract"), and its point-contact union carries 8 non-manifold
edges. The convex kernel is seam-inconsistent whenever its splitter
runs (see the validation-gate header comment); its results use
quarantine-on-refusal, not hard refusal, so void cutting keeps
working.

Pinned by: `tests/property/boolean-closure.test.ts` (3a, tightened)
and `tests/property/kernel-contact.test.ts` (C1–C4).

## 2. ASCII `m2`/`m3` spellings are rejected by the unit parser

`src/core/units.ts` (`parseArea` / `parseVolume`) accepts only the
superscript spellings the formatter emits (`m²`/`m³`, `mm²`/`mm³`).
The ASCII spellings return `null`:

- `parseArea('4m2')` → `null`, `parseArea('4 m2')` → `null`,
  `parseArea('4 mm2')` → `null` — while `parseArea('4m²')` → `4`
  and `parseArea('4 mm²')` → `0.000004`.
- `parseVolume('8m3')` → `null`, `parseVolume('8 m3')` → `null` —
  while `parseVolume('8m³')` → `8`.

This is an observed parser wart, not fixed by PE-09 (accepting the
ASCII spellings is a parser change with its own ambiguity questions,
e.g. `m2` as a bare identifier). It is pinned as the current
behaviour so a parser change that silently starts accepting — or
stops accepting — either spelling fails the suite.

Pinned by: `tests/property/units-invariant.test.ts` (9f).

## 3. Redo (2d): the independent-oracle check catches a broken undo

`tests/property/redo-invariant.test.ts` (2d) pins undo through an
independent oracle: undoing the last k ops must yield exactly the
model produced by applying only the first n−k ops to a fresh model,
and redoing k must return to the post-op state. The round-trip-only
checks (2a) and (2c) cannot catch every broken undo — they compare a
state against itself after an undo/redo cycle, so a degenerate undo
passes them.

Mutation check, demonstrated 2026-11-24 during the #98 close-out:
with `undo()` in `tests/helpers/testEngine.ts` replaced by a no-op,
(2a), (2b) and (2c) all still pass (a no-op undo leaves nothing for
redo to replay, so the round trip returns the post-op state), while
(2d) fails on the first generated case (seed `20261122`,
counterexample: ops `[move, join]`, k = 2). The no-op undo never
reaches the oracle's intermediate state. `tests/property/undo-invariant.test.ts`
fails under the same mutant, as expected — it tests undo directly.
The mutant was reverted immediately after the check; no test file
was changed by it.

Pinned by: `tests/property/redo-invariant.test.ts` (2d).

## Related measurements recorded alongside PE-09

These live in the validation-gate header comment
(`src/modules/solid-kernel/validation-gate.ts`) and are summarised
here because the gate's verdicts are what the findings above are
pinned against:

- The gate is weld (PE-10 weld tolerance), then validate, then a
  typed verdict: `ok` / `quarantined` / `refused`. The quarantined
  verdict exists for exactly the junction/contact class in §1: the
  only error diagnostics are non-manifold edges used 3+ times, and
  the volume is finite and positive.
- The gate's verdicts match PE-09's
  `validateMeshDiagnostics(weldMesh(m))` assertions exactly, because
  it reuses those same two functions.
- Degenerate input to a Boolean is skip + record + return (the PE-10
  contract); a degenerate face corrupts the coplanar pass on coplanar
  operands, so those results are quarantined, not refused.
