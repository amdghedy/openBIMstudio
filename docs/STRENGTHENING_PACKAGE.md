# OpenBIMStudio Strengthening Package v1.0

**Deepens authoring, stability, and documentation capabilities for production use.**

Target: openBIMstudio ≥ 0.66.x  
Date: 2026-10-25

---

## What this package delivers

| Priority | Module | Capability |
|----------|--------|------------|
| **P0** | `transaction` | Transaction groups + Undo/Redo |
| **P0** | `parametric-regen` | Dirty-flag propagation, constraint solving, live formulas |
| **P0** | `properties-panel` | Multi-select, *VARIES*, formulas, type/instance |
| **P1** | `joins-cleanup` | Wall/floor/roof joins + host opening recut |
| **P1** | `lod-performance` | LOD levels, instancing, performance stats |
| **P1** | `view-templates` | Templates, filters, graphic overrides |
| **P2** | `site-topo` | Toposolid + Building Pad |
| **P2** | `detailing` | Detail components, repeating details, keynotes |
| **P2** | `validation` | Rules engine + severity levels |

Pattern: `types.ts` + `index.ts`, singleton `getXxxService()`, window globals, transaction-aware mutations.

Boot: `import "./critical-gaps-boot-strength";` in `main.ts`.

See handler wiring examples in earlier package docs; connect `setApplyHandler`, `setRegenHandler`, joins, view apply, and validation element provider after the authoring store is ready.

## Keyboard

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+Shift+V | Run validation |

## Architecture notes

- **Transaction** is the source of truth for undo/redo.
- **ParametricRegen** drives geometry rebuild from dirty flags; formulas use a restricted expression language.
- **Properties Panel** is multi-select aware and shows `*VARIES*` for mixed values.
