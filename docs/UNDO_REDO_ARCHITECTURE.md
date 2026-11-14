# Undo / Redo & Command Transaction Architecture

Status: implemented and verified (see `tests/undo-transaction-architecture.test.cjs`, wired into `scripts/ci-unit-tests.mjs` as `test:undo-transaction`).

## One stack per document, one algorithm per surface

Every user-visible modification is a deterministic command with exact
before/after state. The architecture has exactly two layers:

| Layer | Implementation | Covers |
|---|---|---|
| **Canonical document stack** | `src/features/history.ts` (`history`) | The BIM document: authored elements, grids/levels, MEP, annotations, Native Twins, plan view, property edits, Group-1 Move/Rotate/Mirror. Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (`global-undo.ts`), ribbon, palette and command palette all drive this one stack. |
| **Entity-surface stack** | `src/core/undo-stack.ts` (`EntityUndoStack`) | Ordered entity arrays with their own render loop: CAD quick-sketch engine (`modules/cad/cad-engine.ts`) and the drafting-2D SVG overlay (`features/drafting-2d.ts`). One shared algorithm — no per-module clones. |

The CAD drawing workspace (`features/cad-viewer.ts`) keeps its richer
`UndoAction` system (add/delete/modify/replace/order) because a DXF drawing
is a separate document with its own save format. While a drawing tab is
active, `global-undo.ts` stands down via `core/cad-hotkey-ownership.ts`, so
exactly one owner answers Ctrl+Z (previously BOTH stacks stepped on the
same keystroke).

## Command contract

```ts
interface Command {
  label: string;          // shown in toasts / undo hints
  apply(): void | Promise<void>;  // deterministic re-application (redo)
  revert(): void | Promise<void>; // exact inverse (undo)
}
```

- `history.push(cmd)` records an **already-applied** command (tools mutate
  the model themselves, then record). Returns `false` when refused — never
  silently dropped (refusals: undo/redo in flight, document transition).
- `history.exec(cmd)` applies first; on failure it auto-reverts and never
  records, so a failed operation leaves no partial state.
- `history.transaction(label, fn)` folds every push inside `fn` into ONE
  compound command. Nested transactions fold into the outermost. A failing
  inner scope rolls back to its savepoint; if a rollback itself fails the
  caller gets an `AggregateError` naming the transaction — never silence.
- Redo invalidation: any new push clears the redo branch. Depth bound 100.
- Undo/redo are serialized through one chain (key-repeat safe); a failed
  revert pushes the command back so the user can retry.

## TransactionService is a facade, not a second engine

`modules/transaction/index.ts` used to keep its own 50-deep stack over the
same `elements` array as `history` — Group-1 commits were invisible to
Ctrl+Z and the two engines could interleave out-of-order inverse patches.

Now:

- `getTransactionService()` returns the **canonical** singleton. `commit()`
  pushes one command per transaction onto the shared stack
  (`Ctrl+Z sees a Move`), `undo()/redo()/canUndo()/clearHistory()` delegate
  to `history`, and document boundaries are inherited for free
  (`beginDocumentTransition()` clears everything on open/create).
- Property-delta snapshots (`TransactionChange`: elementId / propertyPath /
  oldValue / newValue) replay through the pluggable `applyChangeFn`
  (`makeStoreApplyHandler`) — forward on redo, reverse on undo.
- `new TransactionService()` (private mode) keeps the old isolated
  synchronous behaviour only for isolated tool/test usage; production code
  must not construct instances (pinned by test).
- The D-16 skip-first-replay registry (`txnSeenChanges`) is persistent
  across tool commits, fixing the historical bug where the FIRST redo of an
  older transaction silently no-opped after a newer commit re-wired the
  apply handler.

## What is deliberately NOT undoable

Selection, camera/view state and visibility toggles do not push commands
(industry-standard CAD behaviour; selection changes would flood the stack).
Commands capture the exact element ids they mutate, so undo/redo never
depends on the current selection.

## Closed gaps (this change set)

| Gap | Fix |
|---|---|
| `cadEngine.deleteById` undo removed an unrelated entity | delete is a recorded op; undo re-inserts the deleted entity at its original index |
| TRIM / EXTEND mutated endpoints with no inverse | both record before/after modify ops; undo restores exact endpoints |
| FILLET mutated two lines + added an arc with only redo invalidation | one compound command: single undo restores both lines and removes the arc |
| drafting-2d had an add-only unbounded pop-clone | shared bounded `EntityUndoStack`, redo invalidation, load/clear wipe |
| Family type / family parameter edits in the properties palette were direct mutations | both are deterministic commands; type-scope instance re-sync replays symmetrically on undo |
| Make-native-twin had a no-op redo | redo re-runs the captured deterministic creation input (fresh id tracked per cycle) |
| MEP joint healer skipped recording when the stack was empty (untracked auto-edits) | every actual repair is recorded; no-op runs and document transitions are skipped |
| Undo did not mark the document dirty → refresh after undo could restore the pre-undo state | `persistence.ts` listens for `obs-history` and calls `markDirty()` so autosave persists post-undo state |
| Ctrl+Z double-stepped the app stack AND the CAD drawing stack | single-owner stand-down via `isCadHotkeyOwnerActive()` |

## Save / reopen semantics

`projects.ts` calls `history.beginDocumentTransition()` around open/create:
in-flight undo/redo drains, both stacks clear, pushes are refused until the
new document is ready. History intentionally does not persist across
sessions — reopening restores the saved document; `obs.nativeIfc.versions.v1`
(named snapshots) remains the durable history layer.

## Tests

`tests/undo-transaction-architecture.test.cjs` (37 assertions, sequential —
they share the canonical singleton) exercises the real compiled modules:
multi-step editing, undo-all, redo-all, failed `exec` + auto-revert,
failed transaction + savepoint rollback + `AggregateError`, cancellation,
redo invalidation, depth bounds, coalescing, document transitions,
obs-history dirty wiring, Group-1 ⇄ Ctrl+Z equivalence, the
persistent-seen redo regression, hosted-follower geometry/metadata/
relationship synchronization, and the full CadEngine command surface
(add/delete/trim/extend/fillet compound/undo-all/redo-all/bound).
