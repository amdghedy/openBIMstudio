# Per-entity IFC fidelity report — issue #106

> **Status:** implemented on branch `feat/ifc-per-entity-report` (base main
> `e8e5afb`), 2026-11-21. This document records the capability and the
> numbers actually measured. It is not a compatibility claim, and nothing
> in it has been opened in a desktop BIM/CAD tool — see §6.

## 1. What it is

`src/modules/ifc-semantics/per-entity-report.ts` extends the
inventory-only report (`src/modules/ifc-semantics/interop-report.ts` —
entity types + counts + `FILE_SCHEMA`) with a fidelity record per entity,
in both directions:

| Direction | Builder | What each row records |
|---|---|---|
| Import | `buildImportFidelityReport(fileName, bytes)` | Per `IfcProduct` (by IFC type + GlobalId): type mapping (typed / normalised / unknown-type), geometry present/absent/dangling, placement present/absent/dangling/broken, property sets (count + names), quantity sets, relationship kinds, containment, and any loss with a reason code. Aggregated per type (counts, % preserved / degraded / lost). |
| Export | `buildExportFidelityReport(sources, exportedText)` | Per source element: emitted IFC type, match (by GlobalId or, if the GlobalId was not preserved, by name), proxy-fallback flag, geometry survival, property-set survival (survived / lost lists). Writer-agnostic — it reads only the exported STEP text. |
| Round-trip | `buildRoundTripReport(sources, exportedText)` | Export report + re-import of the exported text, joined per GlobalId, with per-element type survival. |

Machine-readable format: deterministic JSON (`fidelityReportToJson()` —
fixed key order, rows sorted by express id, no timestamps; regenerating
the same bytes yields byte-identical output). Human-readable summary:
`formatFidelitySummary()` (Markdown-ish lines), rendered in the existing
import-queue row details block (`src/features/importer.ts` — the fidelity
lines are appended inside the existing Entity-inventory `<details>`,
no second reporting UI was built).

## 2. What it measures — and what it does not

**The import leg measures STEP/semantic-model fidelity**: what the
independent STEP reader (`step-reader.ts` + `semantic-model.ts`, no shared
code with web-ifc or any writer) recovers from the file. The live import
is a monolithic web-ifc → FRAG conversion that exposes no per-entity
callback, so a `preserved` row is **not** a claim that web-ifc imported
that entity into the FRAG model. It means: the entity is present with a
valid identity, a known product type, resolvable placement and
representation, and spatial containment — everything the semantic layer
can verify without the FRAG conversion. Every report carries this scope
statement verbatim so a bare JSON file cannot be mistaken for a FRAG
proof.

**The web-ifc leg is measured separately, in Node**, by
`scripts/ifc-per-entity-report.mjs` (per-entity GlobalId + type
enumeration through web-ifc 0.0.77) and by
`tests/ifc-per-entity-roundtrip.test.cjs`. Its numbers live in the corpus
summary (§4), not in the report rows. It verifies presence + type per
GlobalId; it does not verify FRAG geometry or the browser conversion.

**The export leg measures the exported STEP text** against the source
list with the same independent reader. A proxy fallback, a lost pset, a
changed type or a non-preserved GlobalId is reported, never hidden.

## 3. Status vocabulary and reason codes

Statuses (hardening-plan item 10 / #106): `preserved` (type, identity,
geometry, placement, containment all verified), `transformed` (same
entity, different typed class — a documented normalisation),
`approximated` (survives with loss), `unsupported` (type unknown to the
platform, or no representable source type), `skipped` (present but not
kept as its own entity — duplicate GlobalId, first occurrence kept),
`failed` (unusable as an entity). Degraded = transformed + approximated;
lost = unsupported + skipped + failed.

Import reason codes: `INVALID_GLOBALID`, `MISSING_GLOBALID`,
`DUPLICATE_GLOBALID`, `UNKNOWN_TYPE`, `TYPE_NORMALISED`,
`GEOMETRY_MISSING`, `GEOMETRY_DANGLING`, `PLACEMENT_MISSING`,
`PLACEMENT_DANGLING`, `PLACEMENT_BROKEN`, `UNCONTAINED`. Mapping to the
semantic validator (`validate.ts`): `INVALID_GLOBALID` ↔
`IFC-E-BAD-GUID`, `DUPLICATE_GLOBALID` ↔ `IFC-W-DUP-GUID`,
`UNCONTAINED` ↔ `IFC-W-ORPHAN-ELEMENT`, dangling ↔
`IFC-E-DANGLING-REF`. Property sets are reported (count + names) but
their absence alone never downgrades a row: a product with no psets in
the source has lost nothing.

Export reason codes: `PROXY_FALLBACK`, `TYPE_NORMALISED`,
`TYPE_CHANGED`, `UNKNOWN_SOURCE_TYPE`, `NO_SOURCE_TYPE`,
`GUID_NOT_PRESERVED`, `EXPORTED_ENTITY_MISSING`,
`INVALID_EXPORTED_GLOBALID`, `GEOMETRY_LOST`, `PSETS_LOST`.

Rules worth knowing: `IfcWallStandardCase` / `IfcWallElementedCase`
normalise to `IfcWall` and are reported `transformed`, not `preserved`
(a tessellated reader cannot satisfy StandardCase's SweptSolid+Axis or
ElementedCase's subordinate aggregation). `IfcProject` has no placement
or representation, and spatial elements normally have no representation —
neither is counted as geometry loss. `IfcOpeningElement`s hang off their
host wall via `IfcRelVoidsElement`, so they are exempt from the
containment rule (their `voids` relationship is recorded instead). A
duplicate GlobalId fails only the later occurrence(s). Unknown
product-shaped classes (22-char GlobalId, ≥6 arguments) are reported
`unsupported`, never dropped.

## 4. Corpus numbers (measured, not claimed)

Environment: this VM, Node v24.22.1, web-ifc 0.0.77, 2026-11-21.
Regenerate with `npm run report:ifc-per-entity`
(`node scripts/ifc-per-entity-report.mjs`); the drift gate is
`npm run test:ifc-per-entity-corpus`.

### 4.1 Main corpus (checked in with this branch)

`tests/fixtures/ifc-corpus/per-entity-reports/` — one JSON per fixture +
`summary.json`. 26 files, 24 reported, **1,579 products: 1,510 preserved /
61 transformed / 5 approximated / 0 unsupported / 1 skipped / 2 failed**
(95.6% preserved, 4.2% degraded, 0.2% lost), plus **707 definitions**
(type objects, styles and property definitions — counted, never rows;
see §4.2). The corpus is the merged golden corpus (§12, 24 fixtures) plus
the two buildingSMART Duplex files (§4.2).

| File | Products | Preserved | Transformed | Approximated | Unsupported | Skipped | Failed |
|---|---|---|---|---|---|---|---|
| arch-2x3.ifc (IFC2X3) | 15 | 12 | 3 | 0 | 0 | 0 | 0 |
| arch-classified.ifc (IFC4) | 10 | 10 | 0 | 0 | 0 | 0 | 0 |
| generated-2x3.ifc (IFC2X3) | 9 | 7 | 2 | 0 | 0 | 0 | 0 |
| generated-small.ifc (IFC4) | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| generated-structural.ifc (IFC4) | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| geometry-complex.ifc (IFC4) | 15 | 15 | 0 | 0 | 0 | 0 | 0 |
| invalid/bad-guid.ifc | 6 | 5 | 0 | 0 | 0 | 0 | 1 |
| invalid/dangling-ref.ifc | 6 | 5 | 0 | 1 | 0 | 0 | 0 |
| invalid/duplicate-guid.ifc | 8 | 7 | 0 | 0 | 0 | 1 | 0 |
| invalid/missing-units.ifc | 6 | 6 | 0 | 0 | 0 | 0 | 0 |
| invalid/truncated.ifc | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| malformed/broken-enum-min.ifc | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| malformed/broken-enum-shift-min.ifc | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| malformed/truncated-in-string-min.ifc | — | — | — | — | — | — | — |
| malformed/unterminated-string-min.ifc | — | — | — | — | — | — | — |
| mep-model.ifc (IFC4) | 13 | 13 | 0 | 0 | 0 | 0 | 0 |
| mep-systems.ifc (IFC4) | 15 | 15 | 0 | 0 | 0 | 0 | 0 |
| model.ifczip (IFC4) | 16 | 16 | 0 | 0 | 0 | 0 | 0 |
| property-sets.ifc (IFC4) | 11 | 11 | 0 | 0 | 0 | 0 | 0 |
| relationships.ifc (IFC4) | 13 | 13 | 0 | 0 | 0 | 0 | 0 |
| scale-grid.ifc (IFC4) | 107 | 107 | 0 | 0 | 0 | 0 | 0 |
| spatial-hierarchy.ifc (IFC4) | 16 | 16 | 0 | 0 | 0 | 0 | 0 |
| structural-2x3.ifc (IFC2X3) | 14 | 14 | 0 | 0 | 0 | 0 | 0 |
| third-party/duplex-a.ifc (IFC2X3) | 296 | 237 | 56 | 3 | 0 | 0 | 0 |
| third-party/duplex-mep.ifc (IFC2X3) | 974 | 974 | 0 | 0 | 0 | 0 | 0 |
| units-imperial.ifc (IFC4) | 8 | 8 | 0 | 0 | 0 | 0 | 0 |

Valid fixtures (16 `.ifc` + 1 `.ifczip`, 1,546 products): **1,482 preserved /
61 transformed / 3 approximated / 0 lost**. The 61 transformed are all
`IFCWALLSTANDARDCASE` → `IfcWall` (2 in `generated-2x3.ifc`, 3 in
`arch-2x3.ifc`, 56 in `duplex-a.ifc`). The 3 approximated are the `IFCSTAIR`
(2) and `IFCROOF` (1) in `duplex-a.ifc`, all with `GEOMETRY_MISSING`.
Invalid + malformed (33 products): 28 preserved, 1 skipped (duplicate-GUID
wall `#71` in `duplicate-guid.ifc`, first occurrence `#43` kept), 2
approximated (wall uncontained in `dangling-ref.ifc`; building with missing
placement in `broken-enum-shift-min.ifc`), 2 failed (invalid-GUID project
in `bad-guid.ifc`; building with dangling placement in
`broken-enum-min.ifc`, the only product readable after the enum corruption
ate the rest of the file). The 2 unreported malformed fixtures yield no
readable products and are recorded as unreported, not as zero-product
passes. The truncated fixture's 5 prefix products (all spatial) are all
preserved; the wall past the cut is correctly absent. `model.ifczip`
extracts and reports 16/16 preserved.

Web-ifc cross-check (main corpus): 22 of 24 reported files opened,
**1,577/1,577 GlobalIds matched with the same type, 0 missing, 0
mismatched**. The 2 exceptions are the `broken-enum-min.ifc` fixtures:
`OpenModel` did not return within the 120 s per-file budget in a fresh
process on this VM (recorded as not-opened — not as a hang, and not as a
pass); the same inputs aborted in web-ifc 0.0.77 with WASM
`memory access out of bounds` / `Aborted()` in the earlier §12 run, so
the non-return is a web-ifc observation on the 12-line minimised
fixtures, not a claim about full files. The cross-check verifies presence
+ type, not GUID validity — the invalid project GUID "matches" because
web-ifc sees the same stated value; validity is the STEP report's job.

### 4.2 Third-party files: buildingSMART Duplex (CC BY 4.0)

The corpus now includes two real Revit exports, not just self-authored
fixtures: `Duplex_A_20110907.ifc` (2,380,763 bytes, 38,898 records,
IFC2X3, Revit Architecture 2011) and `Duplex_MEP_20110907.ifc`
(17,871,432 bytes, 311,480 records, IFC2X3, Revit MEP 2011), from the
buildingSMART Community Sample Test Files, CC BY 4.0 (attribution in
`tests/fixtures/ifc-corpus/third-party/README.md`). They live under
`third-party/` so the fuzz gate does not seed on a 17.9 MB file; they are
covered by the manifest test, this report, and the browser timeout spec.

- `duplex-a.ifc`: 296 products — **237 preserved / 56 transformed /
  3 approximated / 0 lost**. The 56 transformed are `IFCWALLSTANDARDCASE`
  → `IfcWall`; the 3 approximated are `IFCSTAIR` (2) and `IFCROOF` (1)
  with `GEOMETRY_MISSING`.
- `duplex-mep.ifc`: 974 products — **974 preserved, 0 lost**. Every
  placed product in the file survives the STEP read.

**Definitions, not lost products.** The first run against these files
reported 582 `unsupported` rows and a 35.7% lost rate for `duplex-mep.ifc`
— almost entirely type objects and property definitions, not lost
products: 407 `IFCPIPESEGMENTTYPE`, 59 `IFCPIPEFITTINGTYPE`, 25
`IFCFURNITURETYPE`, 12 `IFCCABLESEGMENTTYPE`, plus styles and `*PROPERTIES`
definitions. The report's product heuristic treated any entity with a
22-char first argument and 6+ arguments as product-shaped, and type
objects are product-shaped. They are now excluded from rows and counted
in a separate `definitions` tally (707 across the corpus: 123 in
`duplex-a.ifc`, 518 in `duplex-mep.ifc`, top entries `IFCPIPESEGMENTTYPE`
407, `IFCSURFACESTYLE` 33, `IFCCURVESTYLE` 31, `IFCFURNITURETYPE` 25).
Three genuine product classes the known set was missing were also added:
`IFCSTAIRFLIGHT` (2 in `duplex-a.ifc`), `IFCENERGYCONVERSIONDEVICE` (16
in `duplex-mep.ifc`), `IFCDISTRIBUTIONCONTROLELEMENT` (2). Post-fix the
corpus has **0 unsupported products**.

**Two real-world bugs the Duplex files surfaced, fixed in this branch:**

- *Pre-flight rejected real Revit coordinates.* The STEP pre-flight
  capped any digit run at 18 digits, counting fractional digits too.
  Revit writes coordinates with 19–22 fractional digits
  (`-0.0009000000000002357`, `0.0005690557380592822`), so both Duplex
  files were rejected at import before web-ifc ever saw them. The cap
  now applies to the integer part only; a 19-digit bare integer (or a
  19-digit integer part) is still rejected.
- *Semantic validation flagged property names as bad GlobalIds.* The
  model treated any quoted 22-char first argument as a GlobalId
  candidate, and 22-char property names (`'Top Extension Distance'`,
  `'Actual Exhaust Airflow'`) were flagged `IFC-E-BAD-GUID` — 107 false
  errors in `duplex-a.ifc`, 429 in `duplex-mep.ifc`. Only IfcRoot
  subtypes carry a GlobalId as argument 0; non-root name-first families
  (`IFCPROPERTY*` except set/template, `IFCQUANTITY*`, profile defs,
  presentation styles, `IFCMATERIAL`, conversion-based units, document
  references) are now excluded from GlobalId candidacy.

Neither file carries an `IfcSystem`, so MEP system-membership coverage
is still open anywhere in the corpus (§6).

### 4.3 Round-trip: import → twin export → re-import (main)

`tests/ifc-per-entity-roundtrip.test.cjs` (7 assertions): the 5 physical
products of `generated-small.ifc` through the real twin writer on main.
**Measured on main (eabab92): 1/5 emitted as `IfcBuildingElementProxy` —
approximated with `PROXY_FALLBACK`, 4 preserved, 0 failed.** Geometry
survived 5/5, property sets survived 5/5 (0 lost), every emitted type
survived the re-import 5/5, and web-ifc 0.0.77 sees the same emitted
types for all 5 GlobalIds. The writer used to proxy all 5
(`native-twin-ifc.ts` discarded `safeEntityName()`'s result); #246
(native IFC typed entities) made it emit typed entities, and 1/5 is what
remains. The test asserts the flagging invariant rather than the count,
so it stays green as the writer improves further.

## 5. Findings the report surfaced (not fixed here)

- `generated-structural.ifc` is documented as "1 beam + 1 column" but
  contains no `IFCCOLUMN` (5 products, beam only). Recorded in
  `tests/fixtures/ifc-corpus/README.md`; fixing the fixture or its
  description is separate work.
- The semantic model's "not contained" warning also fires for
  `IfcOpeningElement`s (e.g. `arch-2x3.ifc`: "2 physical element(s) not
  contained"), which are contained via voids, not spatially. The report
  carries the model warning verbatim and the rows carry the truth
  (openings preserved, `voids` relationship recorded) — no warning is
  silently filtered.
- The twin writer drops property sets that end up with zero emittable
  properties; the export report would flag such a pset as `PSETS_LOST`
  rather than silently losing it.
- web-ifc 0.0.77 does not return on the two `broken-enum-min.ifc`
  fixtures: `OpenModel` spun past a 120 s budget in a fresh process on
  this VM (twice, deterministic here), while the same inputs aborted fast
  with WASM `memory access out of bounds` in the earlier §12 run. Both
  behaviours are "not opened", recorded as such in `summary.json` — never
  as a pass. The drift gate regenerates with web-ifc in one process, so
  on a loaded box this is a hang risk for the gate; the job-level
  `timeout-minutes: 60` bounds it, and the gate's STEP part can always be
  checked alone with `node scripts/ifc-per-entity-report.mjs --check
  --no-webifc`.
- Measurement method, for the record: a single full-corpus run WITH
  web-ifc OOMs on this VM (three attempts killed; the WASM heap
  high-water mark grows across `OpenModel`/`CloseModel` cycles even
  though every model is closed). The checked-in reports were produced as
  one full `--no-webifc` run for the STEP part plus one fresh process per
  fixture for the web-ifc cross-check (`runs/collect-webifc.cjs` in the
  task work dir), merged by `runs/merge-per-entity-summary.cjs`, which
  asserts STEP agreement and per-file byte identity across the runs.
  Each file's cross-check is independent (open, check, close), so the
  split yields the same per-file sections a single run would.

## 6. What is NOT covered

- **No desktop-tool validation.** No exported file has been opened in
  Revit, ArchiCAD, Solibri, Navisworks or AutoCAD. Two third-party IFC
  files (the buildingSMART Duplex pair, §4.2) have now been put through
  the pipeline, but no issued deliverable has been opened in the tool it
  was issued for — that is item 13, not this one; do not describe IFC
  interop as certified on the basis of this report.
- **No per-entity FRAG proof.** The import rows are STEP/semantic
  fidelity, not web-ifc FRAG-conversion proof (§2). A browser proof
  needs per-entity instrumentation of the live import path (items 6–8).
- **Authored-model writer not measured.** The export leg was exercised
  against the native-twin writer only. The authored writer
  (`authored-ifc.ts`) has no per-entity export measurement yet.
- **No `IfcSystem` / port-connectivity fidelity.** MEP system membership
  is not in the corpus (the writer emits no `IfcSystem` grouping, and
  neither Duplex file carries one) and the report does not score it.

## 7. Regeneration and the drift gate

```
npm run report:ifc-per-entity          # rewrite per-entity-reports/ + summary.json
npm run test:ifc-per-entity-corpus     # fail on drift (also in CI via ci-unit-tests.mjs)
node scripts/ifc-per-entity-report.mjs --check
node scripts/ifc-per-entity-report.mjs --corpus <dir> --out <dir> [--no-webifc]
```

`--check` compares the STEP-derived part always; the web-ifc section is
compared only when web-ifc is available in the run, so a missing
web-ifc install cannot fail the gate. The generator is deterministic:
no timestamps, sorted rows, fixed key order.

## 8. Relationship to the §5 / §12 / §20 branches

- **§5 `fix/native-ifc-entities`** (typed twin export + its own
  `writeFederatedNativeTwinIfcWithReport()`): §5 has landed on main
  (#246, eabab92). The export leg here is writer-agnostic and measures
  the exported text, so §5 changed the *numbers* (5/5 proxied → 1/5
  proxied), not the *report* — §4.3 was re-run and records 1/5.
- **§12 `feat/golden-corpus-20`**: the 24 §12 fixtures are checked in
  on this branch (rebased onto eabab92), plus the two buildingSMART
  Duplex files (§4.2). The drift gate now covers all 26 fixtures.
- **§20 `docs/final-deliverables`** (`docs/engineering/
  IFC_INTEROPERABILITY.md`, which does not exist on main): this branch
  does **not** port that file — it covers fuzz/corpus/native-ifc work
  that is itself unmerged, and porting it would misattribute it. Instead
  this document is the per-entity record, and the exact replacement for
  that file's §4 ("Per-entity reporting (issue #106)", currently
  "**Not done**") is:

  > **Done on branch `revit-2-ifc-import`** (base main
  > `eabab92`). `src/modules/ifc-semantics/per-entity-report.ts`
  > reports per-entity import, export and round-trip fidelity with
  > status (preserved / transformed / approximated / unsupported /
  > skipped / failed) and reason codes, wired into the import queue's
  > existing Entity-inventory block. Measured: corpus 1,579 products
  > (1,510 preserved / 61 transformed / 5 approximated / 0 unsupported /
  > 1 skipped / 2 failed), plus 707 definitions counted separately;
  > twin round-trip on main 1/5 proxied (post-#246; the remaining proxy
  > is flagged, reported not hidden). Full numbers in
  > `docs/engineering/PER_ENTITY_IFC_REPORT.md`. Still not covered:
  > per-entity FRAG proof, authored-writer export, desktop-tool
  > validation.
