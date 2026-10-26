# v0.69 — Engine UI Wiring Wave

Every v0.67 / v0.68 engine is now reachable from the ribbon. Before this
package, eleven engines were only accessible from the developer console
via `window.__obs*` handles; this closes that gap with buttons, dialogs,
report cards and a dockable panel — all following the platform's existing
form-modal / toast / report-card patterns.

## Wiring map (engine → UI)

| Engine | Global | Where it appears in the UI |
|---|---|---|
| Structural FEM + code checks (v67) | `__obsStructural` | **Analyze ▸ Structural FEM**: Frame Solver, Steel Check, RC Beam |
| MEP pressure hydraulics (v67) | `__obsMepPressure` | **Analyze ▸ Hydraulics**: Duct ΔP, Pipe ΔP, Worst Path |
| Adaptive components (v67) | `__obsAdaptive` | **Architecture ▸ Adaptive**: Adaptive Sweep, Divide & Repeat |
| Solid kernel (v68) | `__obsSolids` | **Edit ▸ Solid Forms**: Extrude, Revolve, Sweep, Blend, Subtract, Cut Voids, Validate Last |
| Modify engine (v68) | `__obsModify` | **Edit ▸ Modify Engine**: Move, Rotate, Array, Mirror — running through the real command pipeline (Begin → UpdatePreview → Validate → Commit) against the live authored model via an `ElementStore` adapter |
| Hosting engine (v68) | `__obsHosting` | **Architecture ▸ Openings ▸ Hosted Opening** (validated placement, elevation range report) |
| Parameter engine (v68) | `__obsParametric` | **Manage ▸ Parameters ▸ Parameter Manager** (+ `documentParameters` singleton on `__obsEngineUi`) |
| Object hierarchy / identity (v68) | `__obsRegistry` | **Manage ▸ Model Intelligence** panel: registry + identity stats |
| Relationship registry (v68) | `__obsRelationships` | **Manage ▸ Model Intelligence** panel: counts by kind, suspended state |
| MEP connectors (v68) | `__obsMepConnectors` | **Manage ▸ Model Intelligence** panel: readiness + guidance |
| Snapping engine (v68) | `__obsSnapping` | **Manage ▸ Model Intelligence** panel: enabled snap kinds |

All dialogs also remain available programmatically via
`window.__obsEngineUi.*` for the console, automation and AI tools.

## Result display

- `showReportCard(title, rows, note)` — draggable floating result card
  used by every analysis/solid dialog (reactions, utilizations, ΔP
  breakdowns, volumes, diagnostics).
- Detailed tables (member forces, reactions) go to `console.table` for
  engineering inspection.

## Bugs fixed on the way

1. **`__obsConstraints` collision** — `parametric-constraints` registers
   the lock/equality manager; `v67-register` then overwrote it, breaking
   the ribbon *Lock Dim* / *Equality* buttons at runtime. v67 now merges
   the numeric solver into the existing object.
2. **FEM `transMatrix()` produced a 6×3 matrix** (B stacked vertically
   instead of block-diagonal diag(B, B)). Every member transformation
   yielded NaN in the stiffness matrix. The structural test suite had
   been passing **vacuously** since v0.67 because its `rel()` assertion
   accepted NaN (`NaN > tol === false`). Fixed both:
   - `src/modules/analytical-model/fem.ts` — proper 6×6 transform;
   - `tests/structural.test.cjs` — NaN-hardened `rel()`, corrected
     expectations (parallel-bar load sharing P/2, joint equilibrium
     N = P/cosθ, exact elastic-curve profile, RC hand-calc units),
     absolute-tolerance zero checks.
   All 11 FEM cases now verify genuine closed-form results, including a
   full portal frame (global equilibrium check).
3. Dialog input parsers (`parsePointList`, `parseProfile`) rebuilt:
   point separators vs coordinate separators disambiguated, profiles
   auto-closed.

## Tests

`tests/v69-engine-ui.test.cjs` (run via `npm run test:v69`, wired into
the Unit tests workflow) compiles the UI module slice and verifies the
pure layer in Node: parsing, frame building + FEM equilibrium, closed-form
beam math, branch network + worst-path selection, solid diagnostics
summaries, project-parameter registration (formula → read-only, symbol
sanitisation), and DOM-free module loading.

## Files

- `src/features/engine-ui.ts` — new: all dialogs, report card,
  intelligence panel, `ElementStore` adapter, pure helpers
- `src/shell/ribbon.ts` — new groups on Analyze / Architecture / Edit /
  Manage tabs
- `src/critical-gaps-boot.ts` — boots `setupEngineUi()`
- `src/modules/v67-register.ts` — constraint API merge fix
- `src/modules/analytical-model/fem.ts` — transform fix
- `tests/structural.test.cjs` — de-vacuated + corrected
- `tests/v69-engine-ui.test.cjs` — new
- `package.json` — 0.69.0, `test:v69`
- `.github/workflows/unit-tests.yml` — runs `test:v69`
