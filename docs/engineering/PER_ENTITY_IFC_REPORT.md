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
`summary.json`. 11 files, 9 reported, **69 products: 65 preserved /
2 transformed / 1 approximated / 0 unsupported / 0 skipped / 1 failed**
(94.2% preserved, 4.3% degraded, 1.4% lost).

| File | Products | Preserved | Transformed | Approximated | Failed |
|---|---|---|---|---|---|
| generated-small.ifc (IFC4) | 9 | 9 | 0 | 0 | 0 |
| generated-2x3.ifc (IFC2X3) | 9 | 7 | 2 | 0 | 0 |
| generated-structural.ifc (IFC4) | 5 | 5 | 0 | 0 | 0 |
| mep-model.ifc (IFC4) | 13 | 13 | 0 | 0 | 0 |
| arch-classified.ifc (IFC4) | 10 | 10 | 0 | 0 | 0 |
| invalid/bad-guid.ifc | 6 | 5 | 0 | 0 | 1 |
| invalid/dangling-ref.ifc | 6 | 5 | 0 | 1 | 0 |
| invalid/missing-units.ifc | 6 | 6 | 0 | 0 | 0 |
| invalid/truncated.ifc | 5 | 5 | 0 | 0 | 0 |
| malformed/truncated-in-string-min.ifc | — | — | — | — | — |
| malformed/unterminated-string-min.ifc | — | — | — | — | — |

The 2 transformed rows are the two `IFCWALLSTANDARDCASE` in
`generated-2x3.ifc`. The 1 approximated row is the wall in
`dangling-ref.ifc`, left uncontained because the file's only containment
relationship references `#99999` (dangling). The 1 failed row is the
`IFCPROJECT` in `bad-guid.ifc` (GlobalId
`!@#%^&*()!@#%^&*()!@#%`, outside the base64 alphabet). The 2 malformed
fixtures yield no readable products and are recorded as unreported, not
as zero-product passes. The truncated fixture's 5 prefix products (all
spatial) are all preserved; the wall past the cut is correctly absent.

Web-ifc cross-check (main corpus): all 9 reported files opened, **69/69
GlobalIds matched with the same type, 0 missing, 0 mismatched**. The
cross-check verifies presence + type, not GUID validity — the invalid
project GUID "matches" because web-ifc sees the same stated value;
validity is the STEP report's job.

### 4.2 Golden corpus, §12 branch (measured externally, not checked in)

The §12 corpus (`feat/golden-corpus-20`, head `381eca3`, 24 fixtures) is
unmerged local work, so its reports are **not** in this patch. The same
script was run against that work repo's fixtures
(`--corpus …/golden-corpus/repo/tests/fixtures/ifc-corpus`, output kept
in the task work dir, not committed): 24 files, 22 reported, **309
products: 299 preserved / 5 transformed / 2 approximated / 0 unsupported
/ 1 skipped / 2 failed** (96.8% preserved, 2.3% degraded, 1.0% lost).

Valid fixtures (14 `.ifc` + 1 `.ifczip`, 276 products): **271 preserved /
5 transformed / 0 lost**. The 5 transformed are `IFCWALLSTANDARDCASE`
(2 in `generated-2x3.ifc`, 3 in `arch-2x3.ifc`). `scale-grid.ifc` alone
contributes 107 products, all preserved. `model.ifczip` extracts and
reports 16/16 preserved. Invalid + malformed (33 products): 28
preserved, 1 skipped (duplicate-GUID wall `#71` in `duplicate-guid.ifc`,
first occurrence `#43` kept), 2 approximated (wall uncontained in
`dangling-ref.ifc`; building with missing placement in
`broken-enum-shift-min.ifc`), 2 failed (invalid-GUID project in
`bad-guid.ifc`; building with dangling placement in
`broken-enum-min.ifc`, the only product readable after the enum
corruption ate the rest of the file).

Web-ifc cross-check (§12 corpus): 20 of 22 reported files opened,
**307/307 GlobalIds matched with the same type, 0 missing, 0
mismatched**. The 2 exceptions are the `broken-enum-min.ifc` fixtures:
`OpenModel` **aborted** in web-ifc 0.0.77 (WASM `memory access out of
bounds` / `Aborted()`), recorded as not-opened — not as a hang, and not
as a pass. The script continued and later files cross-checked normally.
(That abort is a web-ifc observation on the 12-line minimised fixtures,
not a claim about the full files in the §2 fuzz campaign.)

### 4.3 Round-trip: import → twin export → re-import (main)

`tests/ifc-per-entity-roundtrip.test.cjs` (7 assertions): the 5 physical
products of `generated-small.ifc` through the real twin writer on main.
**Measured on main: 5/5 emitted as `IfcBuildingElementProxy` —
approximated with `PROXY_FALLBACK`, 0 preserved, 0 failed.** Geometry
survived 5/5, property sets survived 5/5 (0 lost), every emitted type
survived the re-import 5/5, and web-ifc 0.0.77 sees the same emitted
types for all 5 GlobalIds. The loss on main is purely the type: the
writer (`native-twin-ifc.ts`) discards `safeEntityName()`'s result and
hard-codes the proxy. That is the §5 defect, measured here — the report
does not hide it, and the test asserts the flagging invariant rather
than the count, so it stays green when §5 lands and the numbers improve.

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

## 6. What is NOT covered

- **No desktop-tool validation.** No exported file has been opened in
  Revit, ArchiCAD, Solibri, Navisworks or AutoCAD, and no third-party
  IFC has been put through the pipeline — the corpus is entirely
  self-authored (see §4.2's provenance note). That is item 13, not this
  one; do not describe IFC interop as certified on the basis of this
  report.
- **No per-entity FRAG proof.** The import rows are STEP/semantic
  fidelity, not web-ifc FRAG-conversion proof (§2). A browser proof
  needs per-entity instrumentation of the live import path (items 6–8).
- **Authored-model writer not measured.** The export leg was exercised
  against the native-twin writer only. The authored writer
  (`authored-ifc.ts`) has no per-entity export measurement yet.
- **No `IfcSystem` / port-connectivity fidelity.** MEP system membership
  is not in the corpus (the writer emits no `IfcSystem` grouping) and
  the report does not score it.
- **`.ifczip` on main** has no fixture (the one measured is the §12
  corpus's); the extraction path is implemented (jszip) and exercised
  there, but there is no checked-in main-corpus `.ifczip` report.

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
  `writeFederatedNativeTwinIfcWithReport()`): this branch does **not**
  depend on it and does not duplicate it. The export leg here is
  writer-agnostic and measures the exported text, so §5 changes the
  *numbers* (5/5 proxied → typed/preserved), not the *report*. No §5
  code was cherry-picked. When §5 lands, re-run §4.3 and update the
  numbers in §4.3 — the round-trip test is written to stay green.
- **§12 `feat/golden-corpus-20`**: this branch does not depend on it
  and includes none of its fixtures. §4.2 is an external measurement
  against that work repo's fixtures; when §12 lands, re-run the script
  on main and check its reports in (the drift gate will then cover all
  24 fixtures).
- **§20 `docs/final-deliverables`** (`docs/engineering/
  IFC_INTEROPERABILITY.md`, which does not exist on main): this branch
  does **not** port that file — it covers fuzz/corpus/native-ifc work
  that is itself unmerged, and porting it would misattribute it. Instead
  this document is the per-entity record, and the exact replacement for
  that file's §4 ("Per-entity reporting (issue #106)", currently
  "**Not done**") is:

  > **Done on branch `feat/ifc-per-entity-report`** (base main
  > `e8e5afb`). `src/modules/ifc-semantics/per-entity-report.ts`
  > reports per-entity import, export and round-trip fidelity with
  > status (preserved / transformed / approximated / unsupported /
  > skipped / failed) and reason codes, wired into the import queue's
  > existing Entity-inventory block. Measured: main corpus 69 products
  > (65 preserved / 2 transformed / 1 approximated / 1 failed);
  > §12 corpus 309 products (299 preserved / 5 transformed /
  > 2 approximated / 1 skipped / 2 failed); twin round-trip on main
  > 5/5 proxied (the §5 defect, reported not hidden). Full numbers in
  > `docs/engineering/PER_ENTITY_IFC_REPORT.md`. Still not covered:
  > per-entity FRAG proof, authored-writer export, desktop-tool
  > validation.
