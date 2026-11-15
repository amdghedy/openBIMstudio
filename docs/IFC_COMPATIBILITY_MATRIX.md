# IFC Compatibility Matrix

Transparent, evidence-backed capability statement for OpenBIMStudio's IFC
data model and semantic intelligence. Every row names the test(s) that prove
it — nothing on this page is aspirational. Last verified: 2026-11-15.

## Stack inventory

| Layer | Component | Version | Role |
|---|---|---|---|
| Parse / geometry | `web-ifc` (vendored, `public/web-ifc/`) | 0.0.77 | IFC2X3 / IFC4 / IFC4X1–4X3 schema decoding, geometry streaming |
| Model runtime | `@thatopen/fragments` + `components` | 3.4.7 / 3.4.9 | FRAG model container, `getItemsData`, `getSpatialStructure` |
| Writer — authored model | `src/modules/bim-gaps/authored-ifc.ts` | — | Full-model IFC4 **and** IFC2X3 SPF writer (pure TS, no three.js) |
| Writer — native twins | `src/modules/export/native-twin-ifc.ts` | — | Federated IFC4 writer for Native Twin edits |
| Semantic intelligence | `src/modules/ifc-semantics/` | — | Independent STEP reader + typed semantic index + validation |
| Golden gate | `scripts/golden-roundtrip.mjs` | — | Parse-twice + snapshot diff over the corpus (CI: `unit-tests.yml`) |
| Fuzz gate | `scripts/fuzz-ifc-corpus.mjs` | — | Mutated-corpus parser robustness in isolated capped children |

## Read path (linked IFC → viewport / twins)

| Capability | Support | Mechanism | Evidence |
|---|---|---|---|
| IFC2X3 / IFC4 geometry | Yes | web-ifc → FRAG conversion | `test:webifc-abi` (executes vendored bytes), importer pipeline |
| Attributes, names, types | Yes | `model.getItemsData` | `test:bulk-native-twin`, `test:digital-twin-capabilities` |
| Property sets (psets) | Yes | `getItemsData({ psetsDefault: true })` with graceful fallback | `ids.ts readElementRecords`; fallback verified by graceful-degradation tests |
| Spatial structure (Site→Building→Storey) | Yes | `getSpatialStructure()` awaited + name enrichment; category fallback preserved | `model-tree/tree.ts` (openbim-fix: the v3 Promise return is now awaited — the native path previously never fired) |
| Raw preservation of unknown data | Yes | `source-archive` rawItem + `discoveredPaths` + `preserved-unmapped` field map | `test:bulk-native-twin`, `source-archive.ts` |
| Unit awareness of linked models | Partial | web-ifc converts geometry to metres internally; property-value units from third-party files are not yet converted on the FRAG path | Honest limit — see below |
| Classifications of linked models | Via file tools | Archive carries classification stubs when present in source item data | `source-archive.ts extractClassifications` |

## Write path — authored model (`authored-ifc.ts`)

| Capability | IFC4 | IFC2X3 | Evidence |
|---|---|---|---|
| Project / Site / Building / Storeys + aggregation | Yes | Yes | `test:bim-gaps` → `ifc.test.cjs` (STEP-structural parse, attribute counts) |
| Elements: wall, slab/roof/ceiling, column, footing, beam, member, brace, stairs, railing, ramp, curtain-wall, door, window (with real openings: voids + fills), MEP segments (duct/pipe/tray/conduit), equipment proxy, spaces | Yes | Yes (class-mapped: IfcWall↔IfcWallStandardCase, IfcDuctSegment↔IfcFlowSegment, …) | `test:bim-gaps`; `test:ifc-exchange` |
| Property sets + `IfcRelDefinesByProperties` | Yes | Yes | `test:ifc-semantics` (typed values re-read) |
| Quantity sets (`IfcElementQuantity` BaseQuantities: length/area/volume) | Yes | Yes | `test:ifc-semantics` (quantity signatures) |
| Materials (`IfcRelAssociatesMaterial`) | Yes | Yes | `test:bim-gaps` |
| Units (`IfcUnitAssignment`, SI metre/m²/m³/radian) | Yes | Yes | `test:ifc-exchange` |
| Classifications (`IfcClassification` + References + `IfcRelAssociatesClassification`) | Yes (7-attr) | Yes (4-attr) | `test:ifc-semantics` classification round-trip; corpus `arch-classified.ifc` |
| Placement chains (quaternion→`IfcLocalPlacement`) | Yes | Yes | `test:ifc-semantics` (world-matrix resolution) |
| Deterministic GlobalIds (`stableIfcGuid`) | Yes | Yes — same GUID in both schemas | `test:ifc-exchange` (GUID determinism across exchanges) |
| Tessellated bodies for non-analytic types | `IfcTriangulatedFaceSet` | `IfcFacetedBRep` | `test:bim-gaps` counts |
| Honest skip reporting (`stats.skipped`) | Yes | Yes | `test:bim-gaps` |

## Write path — Native Twin federation (`native-twin-ifc.ts`)

| Capability | Support | Evidence |
|---|---|---|
| Federated IFC4 (one Project/Site/Building/Storey) + containment | Yes | `test:ifc-semantics` twin writer checks |
| Lineage pset (`Pset_NativeTwinLineage`) | Yes | `test:ifc-semantics` |
| **Valid GlobalIds** — real 22-char buildingSMART base64; valid source GUIDs preserved, junk replaced deterministically | Yes (fixed this milestone — previously truncated-hex GUIDs) | `test:ifc-semantics` "every emitted GlobalId is valid" |
| Property sets incl. native overrides | Yes | `test:ifc-semantics` |
| Typed element entities (IfcWall/IfcSlab/…) | No — `IfcBuildingElementProxy` bodies (typed writer reserved) | Honest limit |

## Semantic intelligence (`src/modules/ifc-semantics/`)

Independent reader (no shared code with web-ifc or the writers) → typed
semantic model: entity classes, GlobalId validity/duplicates, unit
assignment (SI prefixes + conversion-based chains), spatial tree,
containment, voids/fills, psets, quantity sets, classifications, placement
world matrices, preserved unknown classes. Browser surface:
`ctx.features.ifcSemantics` + command **“IFC: Validate semantics of the
authored model”**.

Validation codes (all additive — findings, never mutations):

| Code | Severity | Meaning |
|---|---|---|
| `IFC-E-BAD-GUID` | error | GlobalId fails the 22-char base64 buildingSMART charset/length |
| `IFC-E-DANGLING-REF` | error | entity reference resolves to a missing `#id` |
| `IFC-W-DUP-GUID` | warning | same GlobalId on multiple entities |
| `IFC-W-UNITS-MISSING` | warning | no unit assignment / no LENGTHUNIT |
| `IFC-W-ORPHAN-ELEMENT` | warning | physical element not contained in any spatial node (openings exempt — hosted via IfcRelVoidsElement) |
| `IFC-W-EMPTY-PSET` / `IFC-W-EMPTY-QTO` | warning | property/quantity set without members |
| `IFC-W-CLASSIF-DANGLING` | warning | classification reference without a parent classification |
| `IFC-I-UNKNOWN-CLASS` | info | unknown classes preserved (never dropped) |

Evidence: `test:ifc-semantics` (30 checks) — including the four invalid
fixtures below producing exactly the codes above.

## Test corpus (`tests/fixtures/ifc-corpus/`)

| Fixture | Schema | Content | Gate |
|---|---|---|---|
| `generated-small.ifc` | IFC4 | 2 walls + hosted door + slab | golden round-trip |
| `generated-2x3.ifc` | IFC2X3 | same model, 2x3 | golden round-trip |
| `generated-structural.ifc` | IFC4 | beam + column | golden round-trip |
| `mep-model.ifc` | IFC4 | 2 ducts, pipe, cable tray, conduit, AHU equipment, 2 storeys | golden round-trip + `test:ifc-semantics` |
| `arch-classified.ifc` | IFC4 | arch model + Uniclass-style classification of 4 elements | golden round-trip + `test:ifc-semantics` |
| `invalid/bad-guid.ifc` | IFC4 | GlobalId outside the base64 alphabet | must yield `IFC-E-BAD-GUID` |
| `invalid/dangling-ref.ifc` | IFC4 | relationship → missing `#99999` | must yield `IFC-E-DANGLING-REF` |
| `invalid/missing-units.ifc` | IFC4 | unit assignment removed | must yield `IFC-W-UNITS-MISSING` |
| `invalid/truncated.ifc` | IFC4 | file cut mid-DATA | must stay readable, no crash |

Golden snapshots live in `snapshots/` and must be committed together with
fixtures (`unit-tests.yml` fails if CI regenerates them). Regenerate via
`node scripts/generate-ifc-corpus.mjs` then `node scripts/golden-roundtrip.mjs`
(currently **5/5 pass**).

## Cross-exchange comparison

`test:ifc-exchange` exports the same model to IFC4 **and** IFC2X3 and
compares, via the independent reader: element totals under an explicit
schema-class map, writer stats vs re-read, GlobalId determinism, unit
assignment, pset/quantity signatures, relationship topology, spatial
structure, per-element geometry presence. A machine-readable summary is
emitted to `docs/ifc-exchange-report.json` on each run.

## Parser robustness (fuzz gate)

`test:fuzz-ifc` mutates corpus bytes (valid + invalid fixtures) and parses
each buffer in an isolated child process with a capped address space
(`ulimit -v`), so adversarial over-allocation aborts are contained.
Taxonomy: `ok` · `typed-error` (controlled) · `contained-crash` (gate fails
above 20 %) · `hang` (release blocker). Current baseline: 60 deterministic
mutations — 0 hangs, 0 crashes.

## Known limitations (stated honestly)

1. **Units on the FRAG/linked-model path**: geometry is converted to metres
   by web-ifc during import, but property values read from third-party files
   via `getItemsData` are not yet unit-converted; unit intelligence currently
   operates on SPF files (writers, exports, corpus) through the semantic
   module.
2. **Twin bodies are proxies**: Native Twin export uses
   `IfcBuildingElementProxy` + tessellation; typed entities remain a
   reserved future writer.
3. **No IFC4X3 writing**: web-ifc reads IFC4X1–4X3, but the writers target
   IFC4 / IFC2X3 only.
4. **Property write-back scope**: native edits mark changed dimension keys
   in the source archive (`markNativeDimensionModified`) and flow into the
   twin/live-link IFC writers; arbitrary third-party pset editing is not
   provided.
5. **Material/style fidelity**: materials are associated by name/color;
   full material layer/style round-trip fidelity is not claimed.
6. **Fuzz aborts**: web-ifc may abort on heavily mutated files; the gate
   contains this in isolated children rather than claiming universal parse
   success.
