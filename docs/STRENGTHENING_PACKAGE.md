# OpenBIMStudio Strengthening Package v1.0

Closes remaining depth gaps vs Revit and hardens the platform for production use.

## Modules

| Priority | Module | Capability |
|----------|--------|------------|
| P0 | transaction | Transaction / Undo-Redo |
| P0 | parametric-regen | Dirty-flag regen + formulas |
| P0 | properties-panel | Multi-select Properties |
| P1 | joins-cleanup | Joins + opening recut |
| P1 | lod-performance | LOD + instancing |
| P1 | view-templates | Templates + overrides |
| P2 | site-topo | Toposolid + Building Pad |
| P2 | detailing | Detail components, keynotes |
| P2 | validation | Rules + auto-fix |

## Boot

```ts
import "./critical-gaps-boot-strength";
```

Wire handlers (transaction apply, regen, element accessors) as documented in the package README. Merge ribbon from `src/integration-strength/ribbon-strength.ts`.

Branch: `feat/strengthening-p0-p2-gap-closure`
