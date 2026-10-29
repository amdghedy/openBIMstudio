# Gap Closure Status — Strengthening Package v1, Enterprise Collaboration & Priority 1 BIM Tooling

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

## After Strengthening Packages (v1, Enterprise Collaboration & Priority 1 Tooling)

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
| Worksharing & Central Sync | ✅ Enterprise | `collaboration/worksharing-engine` + `features/worksharing-panel` |
| Out-of-Core Streaming & Octree | ✅ Enterprise | `streaming/spatial-octree` + `streaming/memory-budget-manager` |
| High-Fidelity Batch Vector PDF | ✅ Enterprise | `export/batch-plotter` + `features/batch-plot-panel` |
| Modify Engine Expansion (Group 2) | ✅ Production | `modify/group2` + `features/modify-group2-tool` (AxisAlign with lock, Split with gap, Wall corner miter/trim/extend) |
| 2D Detail Hatching | ✅ Production | `detail-patterns/hatch-patterns` + `features/hatch-panel` (ANSI31, Concrete, Earth, Brick, Insulation) |
| glTF / GLB 3D Exporter | ✅ Production | `export/gltf-native-twin` + `features/gltf-export-tool` (Direct glTF 2.0 binary serializer, IFC property extras, PBR) |
| Curved / Arc Wall Modeling | ✅ Production | `parametric/arc-wall` + `features/arc-wall-tool` (Center-radius-angle, 3-point arc solver, 3D mesh generator, tangent snapping) |

## Completed Authoring & BIM Capabilities

- ~~Full numeric constraint solver (geometry)~~ ✅ v0.67 — `src/modules/constraints` (Levenberg–Marquardt, 11 kinds, wall integration)
- ~~Worksharing / multi-user~~ ✅ v0.74+ — `src/modules/collaboration/worksharing-engine.ts` (Discipline worksets, element borrowing, borrow requests, central reconcile & journals)
- ~~Adaptive components~~ ✅ v0.67 — `src/modules/adaptive` (profile sweeps, repeaters, mesh volumes)
- ~~Advanced MEP calculation~~ ✅ v0.67 (pressure/hydraulics) — `src/modules/mep/pressure.ts`; flow-balance & mechanical loads closed
- ~~Parametric dependency graph + incremental evaluation~~ ✅ v0.68 — `src/modules/dependency-graph` (Tarjan cycle classification, batch coalescing)
- ~~Document-level parameter engine (EffectiveValue / type-instance overrides)~~ ✅ v0.68 — `src/modules/parameter-engine`
- ~~Object hierarchy + identity management~~ ✅ v0.68 — `src/modules/object-hierarchy`
- ~~Solid geometry kernel (B-Rep, forms, booleans, voids, validation)~~ ✅ v0.68 — `src/modules/solid-kernel` (convex-clipping booleans) — **v0.70:** full non-convex CSG closed by `general-csg.ts` (`generalBoolean`/`fuseAll`/`weldMesh`: union/intersect/subtract on arbitrary closed meshes, global cut set for T-junction-free seams, exact coplanar resolution; see `docs/DEEP_MODELING_V70.md`)
- ~~Magnetic snapping + modeling state machine + wall-column connection~~ ✅ v0.68 — `src/modules/snapping`
- ~~Persistent relationship registry + reconnection policies~~ ✅ v0.68 — `src/modules/relationships`
- ~~MEP connector intelligence (compatibility, fittings, topology)~~ ✅ v0.68 — `src/modules/mep/connectors.ts`
- ~~Unified Modify command engine~~ ✅ v0.68 — `src/modules/modify`
- ~~Modify Group 1 behavioral spec: Selection engine + Reference acquisition + Move/Rotate/Mirror full catalogs~~ ✅ v0.71 — `src/modules/selection`, `src/modules/references`, `src/modules/modify/group1.ts` (transaction undo/redo, hosted rigid follow, mirror relationship cloning; spec-first per `docs/MODIFY_GROUP1_SPEC_V71.md`, registers continued A-10…/D-13…; Groups 2–7 of the Modify master prompt remain)
- ~~Modify Engine Expansion (Group 2): Linear/Radial Array, Align with Lock Constraints, Split with Gap, Wall Corner Trim/Extend~~ ✅ v0.74+ — `src/modules/modify/duplicate.ts`, `src/modules/modify/group2.ts`
- ~~2D Detail Hatching: ANSI31, Concrete, and Earth crosshatch fills for drafting sections~~ ✅ v0.74+ — `src/modules/detail-patterns/hatch-patterns.ts`
- ~~glTF / GLB 3D Exporter: High-speed export of the native twin model to GLB for web, AR, and rendering~~ ✅ v0.74+ — `src/modules/export/gltf-native-twin.ts`
- ~~Curved/Arc Wall Modeling: Arc wall geometry, center-radius-angle parametrization, and tangent snapping~~ ✅ v0.74+ — `src/modules/parametric/arc-wall.ts`
- ~~Metadata-driven property panel + editable dimensions~~ ✅ v0.68 — `src/modules/properties-panel` (schema/lifecycle/dimensions)
- ~~Hosting: host parameterization + opening regeneration~~ ✅ v0.68 — `src/modules/hosting`
- ~~UI wiring of the v0.68 authoring engines into the plan-view tools~~ ✅ v0.69 — `src/features/engine-ui.ts` (ribbon groups on Analyze / Architecture / Edit / Manage; see `docs/UI_WIRING_V69.md`)
- ~~Structural design / rebar~~ ✅ v0.67 (2D frame FEM + steel/RC checks) — `src/modules/analytical-model`; rebar standards, clashes & lap splices closed
- ~~High-fidelity print/PDF~~ ✅ v0.74+ — `src/modules/export/batch-plotter.ts` (Multi-sheet vector transmittal, watermarks, cover sheet & revision schedule)
- ~~Large-model out-of-core loading~~ ✅ v0.74+ — `src/modules/streaming/spatial-octree.ts` + `src/modules/streaming/memory-budget-manager.ts` (Spatial 3D Octree, SSE calculation, dynamic LOD culling, memory threshold enforcement)
