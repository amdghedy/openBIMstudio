# MEP Engine Capabilities

Status: current as of the `fix/mep-engineering` workstream (base `e8e5afb`).
This document is the honest capability statement for the MEP engine. It
replaces any looser claim made elsewhere: where this document and a UI
label disagree, this document wins until the code catches up.

## What is genuinely engineered

| Area | State | Evidence |
| --- | --- | --- |
| Typed connectors | Connectors carry domain, shape, size, system classification and flow direction; compatibility is checked (domain / shape / size / system / flow direction) before any connection is offered or created; topology validation covers duplicate definitions, dangling/self/multiple connections, engagement mismatch, size jumps without fittings, and closed loops. | `src/modules/mep/connectors.ts`; `tests/mep-connectors.test.cjs` (13 assertions) |
| Connector persistence | Family/equipment connectors are tracked by `MepModelLifecycle`, survive in the project snapshot (`mepLifecycle`), and are revalidated on element edits (invalid edges dropped, routes regenerated). | `src/modules/mep/model-lifecycle.ts`; `src/modules/projects/projects.ts` (`current.mepLifecycle = lifecycle.snapshot()`); `src/features/authoring.ts:2637,2653` |
| System classification | One connected cluster carries exactly one declared system. Two or more distinct declared `properties.system` values in one cluster are **rejected as a system conflict** (system null, diagnostic naming the members) — never resolved by majority vote. Undeclared members fall back to per-type defaults (duct → supply-air, pipe → domestic-cold). | `src/modules/mep/system-tree.ts`; `tests/mep-system-tree.test.cjs` (27 assertions, incl. 4 conflict tests) |
| Network graph | Connected components via union-find; branch vs network selection (branch stops at tee/cross/wye junctions); cycle detection with diagnostics in the network audit; terminals identified from equipment design flows; source selection (marked `isSource` or sole equipment). | `src/modules/mep/connectivity.ts`, `network.ts`, `flow-assignment.ts`; `tests/mep-network.test.cjs`, `tests/mep-flow-assignment.test.cjs` |
| Connectivity performance | Pair search is grid-indexed (2 m plan cells over touch regions, oversize fallback) — exactly the old O(n²) scan, pruned. Equivalence with brute force is pinned by a property test on seeded random models. A 1,500-element sparse model indexes in ~47 ms on the dev VM. | `src/modules/mep/connectivity.ts` (`connectedPairs`); `tests/mep-connectivity-index.test.cjs` (31 assertions) |
| Persisted named systems | System names are stamped onto member properties (`mepSystemId` / `mepSystemName`) and survive refreshes and project reloads; joining two named systems keeps the earliest name with a merge diagnostic; re-classifying invalidates the old stamp. | `src/modules/mep/system-tree.ts` (`MepSystemRegistry`, `stampSystemNames`); `tests/mep-system-tree.test.cjs` (8 registry tests) |
| IFC MEP reconstruction | `IfcRelConnectsPorts` + `IfcRelNests` are recorded as typed relationships by the semantic model and reconstructed into element clusters (union-find) with domain classification and per-domain default system suggestions. Dangling/ownerless/self connections are diagnostics, not edges. | `src/modules/ifc-semantics/semantic-model.ts`; `src/modules/mep/ifc-reconstruction.ts`; `tests/mep-ifc-reconstruction.test.cjs` (10 assertions) |
| Flow / pressure / sizing | Darcy–Weisbach + Colebrook–White (Newton, Swamee–Jain seed), fitting loss coefficients, velocity/friction/static-regain sizing, network audit with critical path and fan/pump duty. | `src/modules/mep/pressure.ts`, `sizing.ts`, `sizing-methods.ts`, `network.ts`; `tests/mep-pressure.test.cjs`, `tests/mep-sizing-methods.test.cjs`, `tests/mep-network.test.cjs` |
| Electrical | Panel schedules, demand factors, voltage drop, conductor selection, Ib ≤ In ≤ Iz checks; **breaker selectivity screening** (1.6× rule of thumb, "likely" vs "not demonstrated") and **breaking-capacity checks** (Icu/Ics vs caller-supplied fault current) in `protection-coordination.ts`. | `src/modules/mep/electrical.ts`, `electrical-calc.ts`, `demand-factors.ts`, `distribution.ts`, `protection-coordination.ts`; `tests/mep-electrical-calc.test.cjs`, `tests/mep-protection-coordination.test.cjs` (14 assertions) |
| Calculation disclosure | Every calculation area has a basis record (method, standard, units, assumptions, limitations, validation status) in `calculation-basis.ts`, enforced by test: no area claims validation stronger than unit tests, and no record claims code compliance. | `src/modules/mep/calculation-basis.ts`; `tests/mep-calculation-basis.test.cjs` (5 assertions) |

## What is NOT genuinely engineered (honest list)

- **No code compliance, anywhere.** No MEP calculation is validated
  against a reference implementation, a code, or measured data for any
  jurisdiction. Methods follow generic practice and named tables
  (ASHRAE, IEC 60228/60364, NEC 220, IPC DFU); the adopted local code
  always governs. See `calculation-basis.ts` — every area is
  `unit-tested-only`.
- **Geometry-derived connectivity for plain runs.** Duct/pipe runs
  connect by ends touching within tolerance (0.12 m plan / 0.25 m
  vertical). There are no stored port-to-port edges for plain linear
  runs; connectivity is re-derived on every recompute. A run end landing
  on another run's body counts as connected even without a junction
  fitting, and near-misses within tolerance connect.
- **Selectivity is screening only.** The 1.6× ratio is a same-family
  thermal-magnetic MCCB rule of thumb. Real selectivity is proven only
  by manufacturer time-current curves (IEC 60947-2). Fault currents are
  inputs from a fault study — this codebase computes none. No arc-flash,
  zone-selective, or earth-fault analysis.
- **No physical circuit wiring.** Electrical work covers calculations,
  schedules and protection screening — not physical circuit routing,
  cable containment fill, or breaker coordination against real
  manufacturer curves.
- **IFC reconstruction is semantic-layer only.** The reconstruction
  works on STEP text through the semantic model. The live fragment-based
  System Browser still groups imported IFC by category; wiring
  reconstruction into the fragment browser (which uses web-ifc
  fragments, not the semantic model) is unfinished work.
- **Imported files without ports cannot be reconstructed.** Many
  exporters omit `IfcDistributionPort` / `IfcRelConnectsPorts` entirely;
  those elements are reported unconnected, not guessed.
- **System suggestions for imports are defaults, not file data.** A
  reconstructed duct cluster suggests supply-air only because that is
  the per-domain default for undeclared members — the file carries no
  system classification.
- **HVAC loads, drainage, fire, lighting, insulation are foundations.**
  Simplified heat balance (not a code load calc), DFU sizing (IPC
  tables only), K-factor sprinkler hydraulics (not NFPA 13), lumen
  method (no glare/daylight), steady-state insulation. None is a
  verified design workflow.
- **No region-specific sizing/pressure codes.** Methods are generic
  velocity/friction and ASHRAE-style table practice.
- **System Browser panel interaction is unproven in a browser.**
  Tree computation, conflicts and persisted names are proven at the data
  layer in Node; expand/click/select in the live panel has not been
  driven in a browser session.

## Calculation basis

The authoritative per-area record is code, not prose:
`src/modules/mep/calculation-basis.ts` (`MEP_CALCULATION_BASIS`,
`calculationBasisFor(area)`), exposed on the MEP service as
`.calculationBasis`. Reports and UI panels should quote `method`,
`standard`, `units`, `assumptions` and `limitations` from there rather
than restating them.

## Test evidence (this workstream)

| Suite | Assertions |
| --- | --- |
| `tests/mep-system-tree.test.cjs` | 27 passed (16 baseline + 4 conflict + 8 registry − 1 replaced tie-break) |
| `tests/mep-connectivity-index.test.cjs` | 31 passed (new; property test vs brute force) |
| `tests/mep-ifc-reconstruction.test.cjs` | 10 passed (new) |
| `tests/mep-protection-coordination.test.cjs` | 14 passed (new) |
| `tests/mep-calculation-basis.test.cjs` | 5 passed (new) |
| `tests/mep-connectivity.test.cjs` | 11 passed (unchanged) |
| `tests/mep-connectors.test.cjs` | 13 passed (unchanged) |
| `tests/mep-network.test.cjs` | 10 passed (unchanged) |
| `tests/mep-flow-assignment.test.cjs` | 10 passed (unchanged) |
| `tests/mep-electrical-calc.test.cjs` | see run log (unchanged) |
| `tests/mep-pressure.test.cjs` | 10 passed (unchanged) |
| `tests/mep-sizing-methods.test.cjs` | 11 passed (unchanged) |
| `tests/ifc-semantics.test.cjs` | 30 passed (unchanged by the new relationship kinds) |
| `tests/ifc-roundtrip-compare.test.cjs` | 10 passed (unchanged) |

## Maturity

Both MEP registry entries stay `limited` (`mep-engineering-suite`,
`mep-system-browser`): the engine is materially more honest and more
capable, but code compliance, stored run connectors, browser-proven
panel interaction, and fragment-browser IFC reconstruction are still
open. See `src/features/feature-maturity.ts`.
