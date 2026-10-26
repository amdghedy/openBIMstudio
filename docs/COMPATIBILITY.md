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
| DWG | export | **unavailable** | — (the former fake `ExportDWGCommand` stub was removed, remediation Stage 1) | `tests/dependency-safety.test.cjs` | The drawing export command offers DXF; no DWG writer exists and none may be faked | No |
| RVT / RFA / NWD / NWC | import (conversion) | experimental | Autodesk Platform Services Model Derivative via the local collaboration server `/api/convert` (`server/index.mjs`, `src/services/rfaImport.ts`) | `tests/server-hardening.test.cjs` (upload hardening); no network-dependent e2e | Requires your own APS credentials; hardening of the conversion UX continues (Phase 3) | **Yes — files are uploaded to Autodesk APS** by explicit user action with configured credentials; uploads are stored locally server-side (opaque ids, retention sweeps) |
| BCF 2.1 | import + export | limited | `src/modules/issues/bcf.ts` (import), `src/modules/export/bcf21.ts` (export) | issues test suites | Two-application round-trip validation pending (Phase 4 fixtures) | No |
| IDS | audit | limited | `src/features/ids.ts`, `src/features/ids-panel.ts` | ids test suites | Audit/validation scope; unsupported facets not yet itemised per spec (Phase 4) | No |
| PDF | import (underlay) | limited | PDF.js 4.4.168 on demand (`src/modules/pdf-underlay/pdf-underlay.ts`) | manual verification; CSP allows `cdn.jsdelivr.net` for the library | Underlay/reference use, not editable vector import | Only the **library code** is fetched from jsdelivr; the PDF document itself is parsed locally |
| PDF | export | limited | model + sheet export (`src/modules/export/pdf.ts`, `sheet-pdf.ts`) | test suites | Scope of the v-M3 sheet model | No |
| COBie | export | limited | `src/modules/export/cobie.ts` | test suites | Spreadsheet scope per COBie subset | No |
| CSV | export | limited | schedules, cost, clash reports, rebar BBS, measurements, IDS results (`src/modules/export/*`, `src/features/*`) | test suites | Tabular snapshots of the respective engines | No |
| Project file (`.obs.json`) | import + export | **verified** | project save/open with optional encryption (`src/modules/projects/project-crypto.ts`) | project-crypto + secret-crypto suites | Encryption keys are user-supplied; forgotten keys mean unrecoverable files | No |
| JSON (model QA, clash scenarios, 4D timeline, families, native twin) | export | limited | respective engines (`src/features/*`, `src/modules/export/native-twin-ifc.ts`) | test suites | Interchange for tooling, not a published interchange standard | No |
| PNG / images | export | limited | canvas/screenshot capture | manual verification | Viewport and sheet rasterization | No |

## Known non-goals and honest absences

- **DWG export** — unavailable (see matrix). Real DXF writing is the shipped
  capability; no DWG writer exists in the stack.
- **Native Revit file parsing** — RVT/RFA/NWD/NWC are closed formats; they
  are only reachable through the APS conversion path (which uploads files to
  Autodesk by explicit consent), never parsed in-browser.
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
