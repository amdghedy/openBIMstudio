# Reducing the gap with Revit — COMPLETE (P0–P2 on main)

OpenBIMStudio now ships the **full strengthening package** on `main` for authoring depth, stability, and documentation parity axes.

## Modules on main

| Priority | Module | Revit equivalent | Path |
|----------|--------|------------------|------|
| **P0** | Transaction | Transaction / TransactionGroup + Undo | `src/modules/transaction` |
| **P0** | ParametricRegen | Regen, formula solver | `src/modules/parametric-regen` |
| **P0** | PropertiesPanel | Properties palette (*VARIES*) | `src/modules/properties-panel` |
| **P1** | JoinsCleanup | Wall joins / opening recut | `src/modules/joins-cleanup` |
| **P1** | LODPerformance | Display / performance | `src/modules/lod-performance` |
| **P1** | ViewTemplates | View templates + overrides | `src/modules/view-templates` |
| **P2** | SiteTopo | Topography / building pad | `src/modules/site-topo` |
| **P2** | Detailing | Detail components / keynotes | `src/modules/detailing` |
| **P2** | Validation | Warnings / errors rules | `src/modules/validation` |

Boot entry: `src/critical-gaps-boot-strength.ts` (import from `main.ts` if not already).

### Keyboard

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+Shift+V | Run validation (logs issues) |

### Globals

`window.__obsTransaction`, `__obsParametricRegen`, `__obsProperties`, `__obsJoins`, `__obsLOD`, `__obsViewTemplates`, `__obsSiteTopo`, `__obsDetailing`, `__obsValidation`

## Wire handlers (required for geometry effect)

See `docs/STRENGTHENING_PACKAGE.md` for `setApplyHandler`, `setRegenHandler`, join/recut handlers, view apply, and validation element provider.

## Still out of scope / future

- Native `.rvt` / `.rfa`
- Full adaptive component editor UI
- Enterprise worksharing ACL (element locks exist conceptually)
- Bit-identical sheet graphics vs Revit print

**Status:** Strengthening package **complete on main**. Depth gaps for daily openBIM authoring are closed at the service layer; connect handlers to existing authoring/geometry for full runtime effect.
