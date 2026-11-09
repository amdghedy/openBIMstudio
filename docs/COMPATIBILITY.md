# Format compatibility — openBIMstudio

Remediation program Phase 2 (product truth). This document is the
authoritative, evidence-based statement of what the platform can read and
write, how well, and what leaves your machine when you use each path. The
machine-readable mirror of feature maturity lives in
`src/features/feature-maturity.ts` and is drift-tested by
`tests/feature-registry.test.cjs`; per-entity fixture-level interop reporting
is the Phase 4 deliverable (`docs/INTEROPERABILITY_MATRIX.md`).

**Rules for changing this document**

1. A status may only change with code evidence: implementation + tests +
   runtime verification, referenced in the row (BASELINE §11).
2. `unavailable` rows must stay until a real implementation ships — no
   stubs, no commands that pretend to succeed.
3. The *leaves your machine* column is part of the platform's privacy
   contract; any new external call must also be added to the CSP
   `connect-src` inventory (`docs/CSP.md`) and to this table.

## Status vocabulary

- **verified** — implemented and runtime-verified end-to-end.
- **limited** — implemented with documented boundaries.
- **unavailable** — not implemented; the UI must not offer it.

## Format matrix

| Format | Direction | Status | Mechanism (source) | Verified by | Boundaries | Leaves your machine? |
|---|---|---|---|---|---|---|
| IFC (`.ifc`) | import | limited | web-ifc 0.0.77 via ThatOpen Fragments pipeline (`src/features/importer.ts`, worker self-hosted — `docs/CSP.md`) | End-to-end drop test under CSP (BASELINE §12 v0.74.0: exact-geometry load); test suites | Schema coverage per web-ifc 0.0.77 (IFC2x3/IFC4); no per-entity interop report yet (Phase 4) | No — parsing and conversion run locally (WASM, same-origin worker) |
| IFC (`.ifc`) | export | limited | authored-model export (`src/modules/export/native-twin-ifc.ts`) | test suites | Native-twin fidelity measured for authored models, not third-party round-trip certification | No |
| `.frag` | import | limited | ThatOpen Fragments files (`src/features/importer.ts` `loadFragFiles`) | test suites | Fragments-format coupling per ThatOpen SDK | No |
| DXF | import | limited | 2D drawing reader (`src/modules/drawings/dxf-reader.ts`) | dxf test suites | 2D scope; unsupported entities are reported, not silently dropped | No |
| DXF | export | limited | 2D drawing writer (`src/modules/drawings/dxf-writer.ts`) | dxf test suites | 2D drawing scope | No |
| DWG | import | limited | LibreDWG WASM (`src/modules/drawings/dwg-engine.ts`, `@mlightcad/libredwg-web`) | dwg test suites | DWG version coverage per LibreDWG; 2D/geometry scope per reader | No |
| DWG | export | **limited** | drawing editor DXF serialization → acadrust DWG writer in local WASM (`src/modules/drawings/acad-engine.ts`, `cad-engine-rust/src/lib.rs`) | `tests/cad-dwg-roundtrip.test.cjs` (real engine: DXF → DWG → read-back for hatches, linetypes, lineweights, true colour, layer state, text styles, first paper-space sheet, six versions, repo fixtures) and `tests/cad-dwg-export.test.cjs` | 2D drawing editor subset; version choice 2000–2018+ (`DWGVERSION`); blocks exported exploded, wipeouts as outlines, all sheets written but their names are not kept (plain DXF saves the first sheet only); never opened in desktop drafting software | No — conversion runs locally; acadrust is MPL-2.0, with no paid SDK or remote service |
| NWD / NWC / NWF | import (conversion) | limited | **openBIM NWC bridge** — local loopback service (`tools/navisworks-bridge/openbim-nwc-bridge.mjs`, client `src/features/nwc-bridge.ts`) drives the installed Navisworks Manage/Simulate 2024–2027 with the free MIT BIMCamel exporter plug-in; guided (app opens the file, one click exports) and headless (BIMCamel harness) modes | `tests/nwc-bridge.test.cjs` (24 checks: detection, loopback/CORS/name gates, job lifecycle, guided + headless e2e) | Navisworks has **no built-in IFC export** (Autodesk support); the conversion happens inside the user's own Navisworks via the plug-in | **No — files never leave the machine** |
| RVT / RFA (view only) | import (in-browser view) | experimental | rvt-rs (Apache-2.0, clean-room RVT model reader) compiled to WebAssembly, run in a same-origin worker (`src/features/rvt-viewer.ts`, `src/workers/rvt.worker.ts`, built by `scripts/build-rvt-wasm.mjs`) | `tests/rvt-viewer.test.cjs` (fake decoder; wiring, preflight, honesty of the summary); never run on a real `.rvt` here | Reconstructed geometry for viewing: may be simplified or incomplete, no native model parameters, not used for clash/authoring; decoder is an optional build step; reader supports measured geometry for BIM authoring software 2023–2025 projects, others experimental (`docs/RVT-VIEWER.md`) | **No — decoded inside the tab, nothing uploaded** |
| RVT / RFA / NWD / NWC | import (conversion, cloud fallback) | experimental | Autodesk Platform Services Model Derivative via the local collaboration server `/api/convert` (`server/index.mjs`) | `tests/server-hardening.test.cjs` (upload hardening); no network-dependent e2e | Requires your own APS credentials; for NWD/NWC/NWF the local bridge is the preferred route | **Yes — files are uploaded to Autodesk APS** by explicit user action with configured credentials; uploads are stored locally server-side (opaque ids, retention sweeps) |
| BCF 2.1 | import + export | limited | `src/modules/issues/bcf.ts` (import), `src/modules/export/bcf21.ts` (export) | issues test suites | Two-application round-trip validation pending (Phase 4 fixtures) | No |
| IDS | audit | limited | `src/features/ids.ts`, `src/features/ids-panel.ts` | ids test suites | Audit/validation scope; unsupported facets not yet itemised per spec (Phase 4) | No |
| PDF | import (underlay) | limited | bundled `pdfjs-dist` dependency on demand with a same-origin worker (`src/modules/pdf-underlay/pdf-underlay.ts`) | manual verification; CSP allows `cdn.jsdelivr.net` for the library | Underlay/reference use, not editable vector import | Only the **library code** is fetched from jsdelivr; the PDF document itself is parsed locally |
| PDF | export | limited | model + sheet export (`src/modules/export/pdf.ts`, `sheet-pdf.ts`) | test suites | Scope of the v-M3 sheet model | No |
| COBie | export | limited | `src/modules/export/cobie.ts` | test suites | Spreadsheet scope per COBie subset | No |
| CSV | export | limited | schedules, cost, clash reports, rebar BBS, measurements, IDS results (`src/modules/export/*`, `src/features/*`) | test suites | Tabular snapshots of the respective engines | No |
| Project file (`.obs.json`) | import + export | **verified** | project save/open with optional encryption (`src/modules/projects/project-crypto.ts`) | project-crypto + secret-crypto suites | Encryption keys are user-supplied; forgotten keys mean unrecoverable files | No |
| JSON (model QA, clash scenarios, 4D timeline, families, native twin) | export | limited | respective engines (`src/features/*`, `src/modules/export/native-twin-ifc.ts`) | test suites | Interchange for tooling, not a published interchange standard | No |
| PNG / images | export | limited | canvas/screenshot capture | manual verification | Viewport and sheet rasterization | No |
| Primavera P6 (`.xer`, PMXML) | import | limited | `src/modules/schedule-4d/p6-parser.ts` | `test:schedule-4d` | Activities, WBS, dates, % complete, relationships and resource cost; calendars are not applied | No |
| Microsoft Project XML (MSPDI, `.xml`) | import | experimental | `src/modules/schedule-4d/msproject-parser.ts` | `test:schedule-import` against a hand-written fixture, **not** a file exported by real MS Project | Summary tasks skipped; lags converted to calendar days (not working time); cost assumed to be hundredths of currency units; binary `.mpp` is not supported (save as XML) | No |
| Task schedule CSV (`.csv`) | import | experimental | `src/modules/schedule-4d/csv-schedule.ts` | `test:schedule-import` | Needs name, start and finish/duration columns; predecessors as `A1;A2FS+2d`; dd/mm vs mm/dd ambiguity is flagged, use yyyy-mm-dd | No |
| GeoJSON (`.geojson`) | import | experimental | `src/modules/gis/gis-core.ts` + `src/features/gis-import.ts` | `test:gis` on hand-built data | Flat outlines on the ground plane, centred at the model origin; WGS84 only (equirectangular); not georeferenced to the model | No |
| Shapefile (`.shp` + optional `.dbf`) | import | experimental | same | `test:gis` on hand-built binary files | Point, polyline, polygon (Z/M read as 2D); MultiPatch skipped; `.prj` not read, so non-lon/lat data is assumed to be metres | No |
| STEP / IGES / BREP (`.step .stp .iges .igs .brep`) | import (view) | experimental | occt-import-js 0.0.23 WebAssembly, vendored (`src/features/solid-import.ts`, `docs/THIRD-PARTY-VENDOR.md`) | `test:solids` runs the real wasm on cube fixtures; CI workflow on upstream samples | Tessellated view only, converted to metres from the file's units (BREP has none); no drawing features; main-thread decode, 200 MB cap | No |
| Rhino (`.3dm`) | import (view) | experimental | rhino3dm 8.35.0 WebAssembly, vendored | CI workflow on upstream sample files | Draws meshes and surface models saved with render meshes; curves, annotations, blocks, extrusions, SubD are reported, not drawn | No |

## Known non-goals and honest absences

- **DWG export** — limited (see matrix). The drawing editor converts its supported 2D DXF serialization to native DWG locally through acadrust (MPL-2.0); hatch fills, linetypes, lineweights and the first paper-space sheet are kept (checked by reading the DWG back with the same engine, not in desktop drafting software), you can pick the target DWG version to write, and when the local WASM engine artifact is missing, DWG export is unavailable and nothing is written.
- **Native RVT model file editing / full-fidelity import** — RVT/RFA are closed
  formats. They can be *viewed* (reconstructed, view-only) through the optional
  in-browser rvt-rs reader (`docs/RVT-VIEWER.md`), but are never edited or
  treated as complete BIM data; use IFC for that. NWD/NWC are not parsed
  in-browser. NWD/NWC/NWF are converted **locally** by the
  openBIM NWC bridge driving the user's own Navisworks + BIMCamel plug-in
  (`tools/navisworks-bridge/README.md`); the APS conversion path (which
  uploads files to Autodesk by explicit consent) remains as fallback.
- **Custom AI endpoint hosts** — a static CSP cannot enumerate user-supplied
  endpoints; deployments must extend the policy or tunnel locally
  (`docs/CSP.md`).
- **Per-entity interop reports** (which IFC entities survive import/export
  with what fidelity) are the Phase 4 deliverable and do not exist yet.

## Verification commands

```bash
npm run build && npm run preview   # production truth, not dev-server truth
node tests/dependency-safety.test.cjs   # CSP/no-CDN/worker/wasm-coherence pins
node tests/feature-registry.test.cjs    # this document's honest labels vs registry
```
