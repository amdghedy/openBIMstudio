# Gap Closure Status — Strengthening Package v1

## Before this package

| Domain | Status | Notes |
|--------|--------|-------|
| Transaction / Undo | ❌ Missing or ad-hoc | Critical stability risk |
| Parametric depth | ⚠️ v0.1 | Formulas existed but no dirty propagation / robust regen |
| Properties multi-select | ⚠️ Basic | No *VARIES*, limited formula support |
| Joins / Cleanup | ⚠️ Partial CSG | No systematic join rules or cleanup command |
| LOD / Performance | ⚠️ Light | No formal LOD system |
| View Templates | ⚠️ Early | Present but not full override + filter engine |
| Site / Topo | ❌ Missing | |
| Detailing | ⚠️ Partial | Filled regions existed; detail components / keynotes weak |
| Validation | ⚠️ Native BIM validation scripts | No interactive rules + auto-fix |

## After this package

| Domain | Status | Module |
|--------|--------|--------|
| Transaction / Undo | ✅ Production | `transaction` |
| Parametric depth | ✅ Strengthened | `parametric-regen` |
| Properties multi-select | ✅ Strengthened | `properties-panel` |
| Joins / Cleanup | ✅ Strengthened | `joins-cleanup` |
| LOD / Performance | ✅ Strengthened | `lod-performance` |
| View Templates | ✅ Strengthened | `view-templates` |
| Site / Topo | ✅ v1 | `site-topo` |
| Detailing | ✅ v1 | `detailing` |
| Validation | ✅ Interactive | `validation` |

## Remaining known gaps (future packages)

- ~~Full numeric constraint solver (geometry)~~ ✅ v0.67 — `src/modules/constraints` (Levenberg–Marquardt, 11 kinds, wall integration)
- Worksharing / multi-user
- ~~Adaptive components~~ ✅ v0.67 — `src/modules/adaptive` (profile sweeps, repeaters, mesh volumes)
- ~~Advanced MEP calculation~~ ✅ v0.67 (pressure/hydraulics) — `src/modules/mep/pressure.ts`; flow-balance & equipment selection still open
- ~~Parametric dependency graph + incremental evaluation~~ ✅ v0.68 — `src/modules/dependency-graph` (Tarjan cycle classification, batch coalescing)
- ~~Document-level parameter engine (EffectiveValue / type-instance overrides)~~ ✅ v0.68 — `src/modules/parameter-engine`
- ~~Object hierarchy + identity management~~ ✅ v0.68 — `src/modules/object-hierarchy`
- ~~Solid geometry kernel (B-Rep, forms, booleans, voids, validation)~~ ✅ v0.68 — `src/modules/solid-kernel` (convex-clipping booleans) — **v0.70:** full non-convex CSG closed by `general-csg.ts` (`generalBoolean`/`fuseAll`/`weldMesh`: union/intersect/subtract on arbitrary closed meshes, global cut set for T-junction-free seams, exact coplanar resolution; see `docs/DEEP_MODELING_V70.md`)
- ~~Magnetic snapping + modeling state machine + wall-column connection~~ ✅ v0.68 — `src/modules/snapping`
- ~~Persistent relationship registry + reconnection policies~~ ✅ v0.68 — `src/modules/relationships`
- ~~MEP connector intelligence (compatibility, fittings, topology)~~ ✅ v0.68 — `src/modules/mep/connectors.ts`
- ~~Unified Modify command engine~~ ✅ v0.68 — `src/modules/modify`
- ~~Metadata-driven property panel + editable dimensions~~ ✅ v0.68 — `src/modules/properties-panel` (schema/lifecycle/dimensions)
- ~~Hosting: host parameterization + opening regeneration~~ ✅ v0.68 — `src/modules/hosting`
- Worksharing / multi-user
- ~~UI wiring of the v0.68 authoring engines into the plan-view tools~~ ✅ v0.69 — `src/features/engine-ui.ts` (ribbon groups on Analyze / Architecture / Edit / Manage; see `docs/UI_WIRING_V69.md`)
- ~~Structural design / rebar~~ ✅ v0.67 (2D frame FEM + steel/RC checks) — `src/modules/analytical-model`; 3D frames, LTB/interaction still open. **v0.69 fix:** `transMatrix()` in `fem.ts` returned a malformed 6×3 transform that made every member transformation produce NaN — the structural suite had been passing vacuously (its `rel()` assertions accepted NaN). Both fixed; all 11 closed-form cases now assert genuine results.
- High-fidelity print/PDF
- Large-model out-of-core loading

These are now the clear next targets once the P0–P2 strengthening is integrated and wired to the real geometry/authoring engines. The v0.67 engine package is documented in `docs/REVIT_KILLER_V67.md`, the v0.69 UI wiring wave in `docs/UI_WIRING_V69.md`, and the v0.70 deep-modeling wave (general non-convex CSG + shell + loft, all ribbon-wired) in `docs/DEEP_MODELING_V70.md`.
