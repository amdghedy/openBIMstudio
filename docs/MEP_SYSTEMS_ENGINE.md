# Native MEP Systems Engine

This document describes the native MEP code currently available in openBIMstudio and the acceptance boundary for engineering workflows.

## Implemented foundations

- 3D voxel/A* routing with obstacle and waypoint inputs in `src/modules/mep/router.ts`.
- System-based sizing and velocity checks in `sizing.ts`.
- Duct and pipe pressure-loss calculations in `pressure.ts`.
- Geometric connectivity for linear runs, fittings and equipment in `connectivity.ts`.
- Connector compatibility, route/fitting preview, relationship records and network diagnostics in `connectors.ts`.
- Electrical circuit validation and panel schedule generation in `electrical.ts`.

The connector route generator now uses connector-direction stubs and selects the shortest deterministic orthogonal core route. Connector relationships validate compatibility, finite 3D route points, route endpoints and engagement state before changing connector state.

## Electrical distribution API

The public MEP barrel exports `ElectricalLoad`, `ElectricalCircuit`, `ElectricalPanel`, `validateElectricalDistribution`, `currentFromVA`, `effectiveDemandVA` and `buildPanelSchedule`.

- Loads specify connected apparent power (VA), nominal voltage, phase, required poles and optional demand factor.
- Circuits specify panel/circuit identity, load membership, breaker rating, nominal supply and optional design current/conductor ampacity.
- Panels specify supply, bus rating, optional main breaker and usable circuit spaces.
- Schedule rows report connected VA, demand VA, calculated current, breaker/conductor values and diagnostic codes.
- Diagnostics include duplicate circuit numbers, missing loads/panels, supply or pole mismatches, breaker/conductor conflicts and panel overloads.

Calculation convention: single-phase current is `VA / V`; three-phase current is `VA / (sqrt(3) × line voltage)`. This is nominal apparent-power current, not a complete electrical design.

## Engineering boundary

These APIs are calculation and model-validation aids. They do **not** claim to certify compliance with a jurisdiction's electrical code. Before construction issue, a qualified engineer must validate the project standard and load assumptions, continuous-load rules, conductor derating, ambient/grouping corrections, voltage drop, fault current, interrupting ratings, protective-device coordination, earthing, discrimination, and any applicable diversity rules. Demand factors are explicit input data, not automatically inferred from building use.

Likewise, connector proximity alone is not sufficient to establish a physical connection. Production routing still needs full integration with native model transactions, geometry regeneration, obstacle/clearance checks, fitting-family geometry, system ownership/flow semantics and save/reload persistence.

## Regression tests

Run:

- `npm run test:mep`
- `npm run test:mep-connectors`
- `npm run test:mep-electrical`

The connector and electrical tests are also included in the CI batch runner.

## Next acceptance gates

1. Wire connector relationships into the native model transaction/undo and save/reload path.
2. Regenerate connected runs and fitting geometry after moving, resizing or replacing a component.
3. Replace heuristic fitting reach with connector-port geometry and family-specific fitting rules.
4. Add true graph-based system assignment and continuity checks that distinguish intentional terminal branches from disconnected runs.
5. Add phase-aware panel load balancing, short-circuit/fault-current inputs, voltage-drop and code-profile checks.
6. Wire the circuit/panel data model to authoring UI, schedules, IFC property sets and round-trip persistence.
7. Run large-model, undo/redo, reload and model-edit regression tests before claiming production parity.
