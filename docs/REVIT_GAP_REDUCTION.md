# Reducing the gap with Revit

OpenBIMStudio aims for **openBIM breadth + practical depth** on the workflows teams use every day. This note tracks where the gap vs Autodesk Revit has been narrowed.

## What just landed on `main` (P0 depth)

| Capability | Revit concept | Module |
|------------|---------------|--------|
| Transaction / undo stack | Transaction, TransactionGroup | `src/modules/transaction` |
| Dirty-flag regen + formulas | Regen, family solver | `src/modules/parametric-regen` |
| Multi-select properties (*VARIES*) | Properties palette | `src/modules/properties-panel` |
| Ctrl+Z / Ctrl+Y | Undo / Redo | wired in `critical-gaps-boot-strength.ts` |

Boot (already on main):

```ts
import "./critical-gaps-boot-strength";
```

Wire handlers after the authoring store is ready (see `docs/STRENGTHENING_PACKAGE.md`).

## Already strong (breadth)

From earlier gap-closure work:

- Parametric families, constraints, nested/arrays
- Hosted doors/windows, walls, stairs, railings, curtain walls
- Federation, clash, BCF, IDS
- Views, sheets, dimensions, schedules, 4D/5D
- Phases, design options, groups, copy/monitor

## Remaining depth gaps (honest)

| Area | Gap | Priority |
|------|-----|----------|
| Geometry joins / wall cleanup | Systematic join rules | P1 |
| View templates + graphic overrides | Full override engine | P1 |
| Worksharing (element ownership + sync) | Collaboration depth | P1 |
| Adaptive components / family editor UI | Advanced families | P2 |
| Print/PDF production fidelity | Documentation | P2 |
| Native RVT/RFA | Out of scope (openBIM path) | — |

## How to close more gap next

1. Wire `setApplyHandler` / `setRegenHandler` so undo and regen affect real geometry.
2. Land **joins-cleanup** and **view-templates** modules (P1).
3. Harden **workshare** locks against concurrent edits.
4. Keep testing on real IFC projects — maturity > feature count.

**Goal:** same daily workflows as Revit where open standards allow; never claim bit-for-bit RVT parity.
