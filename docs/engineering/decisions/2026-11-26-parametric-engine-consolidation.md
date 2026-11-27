# Decision: one parametric stack, four layers — fold parametric-regen in

**Proposed:** 2026-11-26, against `main` `e033829`.
**Status:** proposal, pending the validation pass listed at the end. Nothing is deleted yet.

## Decision

The consolidation target is not one module but one stack with four named
layers, and the fifth module (`parametric-regen`) folds into it:

1. **`constraints/solver.ts` (418 lines) — math kernel.** Numeric
   Levenberg-Marquardt geometric solver. No UI, no document state. Unchanged.
2. **`parametric-constraints/` (888 lines) — geometric-constraint layer.**
   The constraint store (`types.ts`: locked dimensions, equality, alignment,
   parallel, perpendicular), the store→solver bridge (`solver-bridge.ts`),
   and live re-enforcement after edits (`auto-solve.ts`). This is the layer
   with real consumers: `projects.ts` persists `exportConstraints()` on
   save, and `engineering-engines`, `constraint-solver`, `constraint-tools`
   and `parametric-tools` all import it.
3. **`parameter-engine/` — parameter semantics.** Document-level parameter
   evaluation: type vs instance parameters and EffectiveValue (Design spec
   MODULE 1.6 / 2.3). Imported by `authoring-core`, the properties panel
   and `engine-ui`. Unchanged in role.
4. **`shared-params/` — definitions.** Shared/project parameter definitions
   (GUID + name + type, bound onto families or categories). Feeds layer 3;
   it is not an evaluation engine and stays separate by design.

**`parametric-regen/` (2 importers: `parametric/wire-authoring.ts`,
`critical-gaps-boot-strength.ts`) is the generation that folds in.** Its
formula evaluation duplicates layer 3's job, and its `ConstraintNode` graph
duplicates layer 2's store. Migration: move formula evaluation behind one
`evaluate()` API in `parameter-engine`, point the dirty-flag graph at the
`parametric-constraints` store instead of its own node type, migrate the
two importers, then delete the module.

## Evidence (2026-11-26)

- `ARCHITECTURE.md` lists "several generations of the same feature" as
  known debt; the five modules above are that debt in the parametric area.
  The overlap is real but partial — these are different layers, not five
  copies of one engine, which is why "pick one and delete four" would
  break working behavior (constraint persistence on save, auto-solve after
  drag, family type/instance evaluation).
- The one module with near-zero adoption is `parametric-regen`: two
  importers, one of them a boot file. Every other module has a distinct,
  consumed role.
- Precedent for the fold-in order: `parametric-constraints/index.ts` notes
  its own setup was dead until the `require()` bug was fixed — wiring
  through one owner with real importers is how these modules stay alive.

## Ratchet

Once the migration starts: no new imports of `parametric-regen` (guard in
`tests/ui-honesty.test.cjs` or a CI grep), and the `wire-authoring` equal-
length hook moves to the consolidated API first, since it sits on the live
edit path (`transformElements` → `syncEqualLengthAfterTransform`).

## Validation required before deletion

- Read both formula implementations (`parametric-regen` vs
  `parameter-engine`) and diff their semantics: evaluation order, cycle
  handling, units. The fold-in must not change evaluated values.
- Confirm `parametric-regen`'s dirty graph has no consumer that the
  `parametric-constraints` store cannot serve (search for its event/API
  surface beyond the two importers).
- Browser proof after migration: a locked-dimension edit round-trips
  through save/reload (covered by the persistence specs) and auto-solve
  still re-enforces after a move (extend an existing e2e spec if needed).
