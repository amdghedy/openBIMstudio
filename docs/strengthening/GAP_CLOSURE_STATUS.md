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
- ~~Structural design / rebar~~ ✅ v0.67 (2D frame FEM + steel/RC checks) — `src/modules/analytical-model`; 3D frames, LTB/interaction still open
- High-fidelity print/PDF
- Large-model out-of-core loading

These are now the clear next targets once the P0–P2 strengthening is integrated and wired to the real geometry/authoring engines. The v0.67 engine package is documented in `docs/REVIT_KILLER_V67.md`.
