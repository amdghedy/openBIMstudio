# v0.67 — Engineering Engine Package ("Revit killer" milestone)

Four production-grade engineering engines landed in v0.67, closing the
highest-value items left in `docs/strengthening/GAP_CLOSURE_STATUS.md`.
Every engine is pure TypeScript (no DOM, no three.js), unit-tested against
closed-form solutions, and exposed on `window.__obs*` for the console,
automation, AI tools and future UI panels.

## 1. Numeric geometric constraint solver — `src/modules/constraints/`

The parametric core Revit is built on. When users drag constrained
geometry, relations hold instead of breaking.

- **Method**: damped least squares (Levenberg–Marquardt) over a flattened
  point vector, central-difference Jacobians, backtracking line search.
- **11 constraint kinds**: `coincident`, `distance`, `horizontal`,
  `vertical`, `parallel`, `perpendicular`, `equal-length`, `angle`,
  `fixed`, `point-on-line`, `midpoint`.
- **Model integration**: `solveAndApply()` turns the authoring model's
  walls into a constraint system — coincident endpoints auto-join (within
  tolerance), declared wall lengths are preserved, pinned walls stay put,
  results are written back to `params.start/params.end` (mm-rounded,
  no-op-safe).
- **Diagnostics**: converged / unconverged / over-constrained status,
  iteration count, max residual, naive DOF count.
- Tests: `tests/constraint-solver.test.cjs` (14 cases — rectangle
  restoration, wall-chain drag healing, pinned solves, over-constraint
  detection, 20-wall performance under 2 s).

Console API:

```js
__obsConstraints.solveWalls()               // heal the current model
__obsConstraints.solve(points, constraints) // ad-hoc systems
```

## 2. Structural analysis + member code checks — `src/modules/analytical-model/`

The analytical model graduated from a data stub to a working solver —
the first step toward Revit + Robot replacement.

**FEM (`fem.ts`)** — 2D frame finite elements (Euler–Bernoulli):

- 3 DOF/node (ux, uy, rz); axial + bending; `truss` flag for pin-ended
  members (rotational DOFs of truss-only nodes auto-restrained).
- Loads: nodal (fx, fy, mz), member UDLs (global axes), member point
  loads at t ∈ [0,1]. Consistent (exact) nodal load vectors.
- Outputs: displacements, support reactions, member end forces
  (N/V/M with standard beam sign conventions), exact deflection profiles
  via Hermite interpolation + UDL particular solution.
- Verified exact: SS beam `5wL⁴/384EI` and `wL²/8`, cantilever `PL³/3EI`
  and `−PL`, truss elongation `PL/AE`, inclined brace `P·cosθ`.

**Code checks (`checks.ts`)** — preliminary member verification:

- Steel: φMp = 0.9·Fy·Zx (compact, braced), φVn = 0.6·Fy·Aw, deflection
  limit L/240 — utilizations + pass/fail + notes.
- RC: singly reinforced sizing (ACI-style stress block): As required,
  stress-block depth a, φMn, φVc = 0.75·0.17·√f'c·b·d, stirrup spacing
  with d/2 and 0.6 m caps.

**Catalog (`sections.ts`)** — W-shapes (A992) + IPE/HEA (S275),
metricated; catalog values verified against AISC v15 (e.g. W14X22
Zx = 33.1 in³, W21X44 Zx = 95.4 in³, W12X40 Zx = 57.0 in³,
W16X31 Zx = 54.0 in³). Intended for preliminary design; the notes array
carries the assumptions into any report.

Tests: `tests/structural.test.cjs` (11 cases).

Console API:

```js
const r = __obsStructural.solve({ nodes, members, memberUdls });
r.reactions; r.memberForces.get("beam-1");
__obsStructural.checkSteel(section, { Mu, Vu, deflection, span });
```

## 3. MEP pressure-loss engineering — `src/modules/mep/pressure.ts`

Completes sizing.ts: the physics behind duct/pipe system inspection.

- Darcy–Weisbach with Colebrook–White friction factors (Newton, seeded
  by Swamee–Jain), laminar fallback `f = 64/Re`.
- Rectangular ducts via hydraulic diameter; roughness table (galvanized,
  spiral, flex, fiberglass, PVC, copper, steel, PEX, concrete).
- 14 fitting loss coefficients (elbows, tees, reducers, dampers,
  diffusers, valves…).
- Water systems report head loss (m) and pressure (Pa) consistently.
- `worstPath()` finds the critical branch of a distribution tree — the
  number the fan/pump must overcome; `classifyFrictionRate()` maps the
  specific drop onto the ASHRAE low-velocity design band.

Validated: 0.3 m³/s in Ø350 → ≈0.33 Pa/m (ASHRAE chart band), 1 L/s in
DN50 → ≈0.006 m/m, flex-vs-galvanized penalty, smooth-pipe Blasius limit.

Tests: `tests/mep-pressure.test.cjs` (10 cases). Also re-exported from
the `mep` barrel and merged into the `__obsMep` service.

## 4. Adaptive components — `src/modules/adaptive/`

Revit's adaptive parts: point-placed flexible families for rafters,
façade fins, mullions on divided paths.

- `AdaptiveFamily` = closed 2D profile + 2–4 placement points;
  registry + validation.
- `sweepProfile()` sweeps the section along the point polyline with a
  per-segment frame (vertical-segment fallback), producing a **closed
  indexed mesh**; `meshVolume()` recovers exact volume via the
  divergence theorem (quantity takeoff for free).
- Pattern tools: `divideLine`, `divideArc`, `repeatAlongPath` (sliding
  window = Repeater behaviour), `pathLength`.
- Verified: prism volumes = profileArea × length to 1e-9, correct
  outward winding, no NaN on vertical runs, index safety.

Tests: `tests/adaptive.test.cjs` (10 cases).

Console API:

```js
__obsAdaptive.registerFamily({ id: "fin", name: "Fin", pointCount: 2, profile });
const mesh = __obsAdaptive.instantiate("fin", [p1, p2]);
__obsAdaptive.repeatAlongPath("fin", __obsAdaptive.divideLine(p1, p2, 6));
```

## Boot & CI

- `src/modules/v67-register.ts` wires all four engines into
  `window.__obsConstraints / __obsStructural / __obsMepPressure /
  __obsAdaptive`, guarded by the boot `safe()` wrapper.
- All four test suites added to the `Unit tests` workflow.
- `npm run verify:v67` checks the milestone shape (28 checks).

## What this unlocks next

- Constraint UI overlays (dimension locks in plan views) — engine ready.
- Analytical-view visualization + utilization heat colors on members.
- Duct/pipe system inspector panel reading `__obsMep.pressure`.
- Adaptive component placement UI over divided paths.
