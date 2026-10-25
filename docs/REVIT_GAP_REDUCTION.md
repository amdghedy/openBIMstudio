# Platform depth modules

OpenBIMStudio ships a strengthening package for authoring depth, stability, and documentation workflows.

## Modules on main

| Priority | Module | Role | Path |
|----------|--------|------|------|
| **P0** | Transaction | Undo/redo transaction groups | `src/modules/transaction` |
| **P0** | ParametricRegen | Dirty regen + formulas | `src/modules/parametric-regen` |
| **P0** | PropertiesPanel | Multi-select properties (*VARIES*) | `src/modules/properties-panel` |
| **P1** | JoinsCleanup | Wall joins + opening recut | `src/modules/joins-cleanup` |
| **P1** | LODPerformance | Display LOD / instancing | `src/modules/lod-performance` |
| **P1** | ViewTemplates | View templates + overrides | `src/modules/view-templates` |
| **P2** | SiteTopo | Topography / building pad | `src/modules/site-topo` |
| **P2** | Detailing | Detail components / keynotes | `src/modules/detailing` |
| **P2** | Validation | Rules / warnings engine | `src/modules/validation` |

Boot: `src/critical-gaps-boot-strength.ts` (imported from `main.ts`).

### Keyboard

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+Shift+V | Run validation |

### Globals

`window.__obsTransaction`, `__obsParametricRegen`, `__obsProperties`, `__obsJoins`, `__obsLOD`, `__obsViewTemplates`, `__obsSiteTopo`, `__obsDetailing`, `__obsValidation`

Wire handlers after authoring is ready (see `docs/STRENGTHENING_PACKAGE.md`).
