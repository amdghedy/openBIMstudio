/**
 * Feature maturity registry (remediation program Phase 2 — product truth).
 *
 * This file is the single machine-readable source for what the platform
 * actually supports, how well, and with which verified boundaries. It mirrors
 * and is drift-tested against `docs/engineering/BASELINE.md` §9 and the
 * honest labels surfaced in `docs/COMPATIBILITY.md`.
 *
 * Rules (BASELINE §11):
 *  - `verified`     = implemented + runtime-verified by the referenced tests.
 *  - `limited`      = implemented with documented boundaries.
 *  - `experimental` = present but not fully hardened; not for production data.
 *  - `unavailable`  = honestly labelled absence (no stubs, no fake success).
 *  - `planned`      = scoped by the remediation program, not yet started.
 *  - `limited` / `experimental` / `unavailable` entries MUST document at
 *    least one limitation; `verified` entries SHOULD document residual ones.
 *  - Every `source` and `evidence` path must exist (drift test).
 *
 * The drift test lives in `tests/feature-registry.test.cjs`.
 */
import { APP_VERSION } from "../version";

export type MaturityStatus =
  | "verified"
  | "limited"
  | "experimental"
  | "unavailable"
  | "planned";

export interface FeatureMaturityEntry {
  id: string;
  area: string;
  status: MaturityStatus;
  /** Code paths that implement the feature (repo-root relative). */
  source: string[];
  /** Test suites / verify scripts that runtime-verify the status. */
  evidence: string[];
  /** Honest, user-visible boundaries. */
  limitations: string[];
  /** App version when this status was last affirmed with evidence. */
  affirmedIn: string;
}

export const MATURITY_STATUSES: readonly MaturityStatus[] = [
  "verified",
  "limited",
  "experimental",
  "unavailable",
  "planned",
] as const;

export const FEATURE_MATURITY: readonly FeatureMaturityEntry[] = [
  {
    id: "schedule-import-formats",
    area: "4D/5D scheduling",
    status: "experimental",
    source: ["src/modules/schedule-4d/msproject-parser.ts", "src/modules/schedule-4d/csv-schedule.ts", "src/modules/schedule-4d/p6-parser.ts"],
    evidence: ["tests/schedule-import.test.cjs", "tests/schedule-4d.test.cjs"],
    limitations: [
      "Microsoft Project XML and CSV readers are tested against hand-written fixtures only, never a file exported by real MS Project; binary .mpp is not supported",
      "Lags become calendar days (working calendars are not applied) and MSPDI cost is assumed to be stored in hundredths of the currency unit",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "adaptive-native-integration",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/adaptive/index.ts",
      "src/modules/adaptive/native-integration.ts",
      "src/modules/engineering-engines.ts",
      "src/features/engine-ui.ts",
      "src/shell/ribbon.ts",
    ],
    evidence: ["tests/adaptive.test.cjs", "tests/adaptive-native.test.cjs"],
    limitations: [
      "Native adaptive elements persist their profile and ordered 1–8 placement points and regenerate through the existing authoring mesh-builder hook; the placement dialog currently accepts coordinate text rather than interactive 3D point picking",
      "Editing supports the stored point list and cross-section profile; project-persistent geometric constraints, live 3D grips, shared family-catalog/type propagation and IFC entity mapping remain follow-up work",
      "The native integration test uses a mock authoring service and JSON serialization; browser placement, real project save/reopen and a representative building model still require end-to-end validation",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "export-views-to-cad",
    area: "Interoperability",
    status: "experimental",
    source: ["src/modules/export/view-to-cad.ts", "src/features/export-cad-views.ts"],
    evidence: ["tests/view-to-cad.test.cjs", "tests/model-to-dxf3d.test.cjs", "tests/export-cad-dwg.test.cjs"],
    limitations: [
      "2D views: plan, RCP, section, elevation. A separate 3D model → DXF writes 3DFACE triangles for authored elements and loaded IFC models (4M-triangle cap, no solids; DXF or DWG, where the DWG is re-read in a real browser test on one IFC wall (12 faces survive) and not opened in AutoCAD; the IFC path is unit-checked only in its layer mapping and has not been run on a real IFC in a browser); the current 3D camera view can be exported as hidden-line 2D lines (depth-buffer sampling, about 1/1600 of the view width; browser-tested on one IFC wall seen from the front, 5.04 m × 3.03 m for a 5 m × 3 m wall) with geometry behind the camera clipped at a 2 cm near plane (unit-tested only); it has not been compared with a CAD package's hidden-line output",
      "Layers are by view layer (cut, projected, grid, annotation, symbols), not by element category; symbols are circles plus a label, with no blocks or xrefs",
      "The DXF text is checked for completeness; AutoCAD, BricsCAD and Revit have not been used to open the DWG/DXF, and the dialog has not been used by a person",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-sketch-editor",
    area: "Families",
    status: "experimental",
    source: ["src/modules/families/sketch-core.ts", "src/features/family-sketch-editor.ts"],
    evidence: ["tests/family-sketch.test.cjs"],
    limitations: [
      "Plan outlines only: one straight-edged outline per extrusion (free circles are polygons), holes only as fixed polygons inside an outline, no arcs, splines, sweeps, revolves, reference planes or dimension-driven sketch constraints",
      "Free polygons are fixed data (only depth and elevation are parameters); rectangles and circles drawn as parametric shapes resize through width/length/radius parameters, but not when holes are present",
      "The core is tested, and the 3-D result (footprint, height, elevation, orientation) is checked only where real three.js is installed (CI); the drawing window was never used in a real browser",
      "Built-in families are copied before a sketch is added, so the original stays intact",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "solid-model-view",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/solids/solid-core.ts", "src/modules/solids/solid-reader-worker.ts", "src/modules/solids/solid-reader-protocol.ts", "src/features/solid-import.ts", ".github/workflows/vendor-drawing-readers.yml"],
    evidence: ["tests/solids.test.cjs", "tests/solid-reader-isolation.test.cjs", "real browser (2026-11-16): a STEP cube dropped on the production-style app opened through the isolated solid reader worker — toast 'Opened cube-mm.step (STEP): 1 shape(s), 12 triangles' with metre conversion, and the tessellated cube rendered shaded in the 3D viewport (screenshot verified); before the fix every import failed with a CSP 'Evaluating a string as JavaScript' error, found by exactly this real-browser run"],
    limitations: [
      "STEP, IGES, BREP and Rhino 3dm open as tessellated, view-only geometry (no native drawing features, no parametric edit, not part of clash tests); colours come from STEP only",
      "3dm: only meshes and surface models saved with render meshes are drawn; curves, annotations, block instances, extrusions and SubD are counted and reported, not drawn",
      "Tests run the real occt-import-js wasm on small cube fixtures and the Rhino reader only in CI on upstream samples; no real assembly or building-scale STEP file is in the suite, and only the occt STEP path has a live-browser screenshot so far (3dm/IGES/BREP verified by the same worker path plus CI, not by a screenshot)",
      "Parsing runs in an isolated reader worker (200 MB cap) so the tab no longer freezes on big files, but a huge assembly still takes its time inside the worker; the readers are prebuilt third-party WebAssembly vendored under public/vendor/ (docs/THIRD-PARTY-VENDOR.md)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "gis-site-context",
    area: "Interoperability",
    status: "experimental",
    source: ["src/modules/gis/gis-core.ts", "src/features/gis-import.ts"],
    evidence: ["tests/gis-core.test.cjs"],
    limitations: [
      "GeoJSON and Shapefile open as flat outlines on the ground plane, centred at the model origin: context only, not georeferenced to the model and not part of clash tests",
      "Lon/lat data uses an equirectangular approximation; projected data is assumed to be in metres because the .prj file is not read, so the CRS and units are not verified",
      "Tested on hand-built files, not on real municipal datasets; the UI path was never run in a real browser",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "rvt-view-only",
    area: "Interoperability",
    status: "experimental",
    source: ["src/modules/rvt/rvt-core.ts", "src/features/rvt-viewer.ts", "src/features/rvt-view.ts", "src/workers/rvt.worker.ts", "scripts/build-rvt-wasm.mjs"],
    evidence: ["tests/rvt-model-viewer.test.cjs"],
    limitations: [
      "The RVT view is read-only: geometry is reconstructed by the third-party rvt-rs reader (Apache-2.0), shapes can be simplified or missing, and only the properties the decoder can read are shown (not every native model parameter). Editing happens on a Native Twin made from an element, which is a tessellated copy (not the source application's parametric definition) and cannot be written back to the .rvt",
      "Tests run the real WebAssembly decoder and the real glTF loader only on synthetic data (a 20 KB fixture and a synthetic wall); no real project .rvt is in the test suite. Decoder confidence is shown on every open",
      "The decoder is an optional build step (npm run build:rvt, docs/RVT-VIEWER.md): a deployment without it says so and points to IFC export",
      "The reader's own support matrix applies (stable measured geometry for RVT projects from supported 2023–2025 releases; other releases experimental); large files need a lot of memory",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "authoring-tools",
    area: "Modeling",
    status: "verified",
    source: ["src/features/authoring.ts", "src/features/plan-view-panel.ts"],
    evidence: ["tests/", "tests/openings-chain.test.cjs", "npm run verify:v68", "npm run verify:v73", "real browser: plan wall → hosted door + window → door/window schedules 1 row each → 3D mesh volume drops by the punched openings (10.384 vs 11.098 solid m³)", "real browser (v54 re-run after +354 commits): Wall tool → 2 chained walls → Door tool click on wall → door element with hostId + offsetAlongHost + swing panel", "browser chain spec (document-chain.spec.ts, production bundle): ribbon Wall click → 2 canvas points → Enter authors a wall (authored elements 0→1); Door/Window tools insert on the wall with zero page errors"],
    limitations: [
      "Doors/windows host on in-app walls (straight and curved); openings cut compound layers; linked-IFC hosts still limited",
      "Plan-placed doors/windows used to be authored as unhosted 'equipment' (schedules 0 rows, no 3D cut) — fixed and guarded; projects saved before the fix are repaired on load only when a wall lies under the old point",
      "The ribbon 'Hosted Opening' dialog (engine-ui.ts) is validation-only: it runs placeOpening() checks and shows a success report card, but discards the result — no opening is written to the model. The real hosted path is the Door/Window tools; the dialog must not be presented as a placement feature",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "modeling-panel",
    area: "Modeling",
    status: "verified",
    source: [
      "src/features/tool-panels.ts",
      "src/features/property-palette.ts",
      "src/modules/justification/index.ts",
      "src/modules/snapping/magnetic.ts",
    ],
    evidence: ["tests/", "npm run verify:v73"],
    limitations: [
      "Tangent snap not applicable (no arc-based elements yet)",
      "Rotation propagation reports registry updates rather than re-solving all dependents",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "modify-engine",
    area: "Modeling",
    status: "verified",
    source: ["src/modules/modify/"],
    evidence: ["tests/", "npm run verify:v71"],
    limitations: [
      "Covers move/copy/rotate/mirror/array/offset and modify Group 1; remaining modify groups are separate deliveries",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "viewcube-navigation",
    area: "Navigation",
    status: "verified",
    source: ["src/modules/navigation/", "src/features/viewcube.ts"],
    evidence: ["tests/", "npm run verify:v72"],
    limitations: [
      "Home views are per-browser (localStorage), not synced through collaboration",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "solid-kernel",
    area: "Modeling",
    status: "verified",
    source: ["src/modules/solid-kernel/"],
    evidence: ["tests/"],
    limitations: [
      "Boolean robustness documented for the v70 test corpus; pathological inputs may still require verification per case",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ifc-import-export",
    area: "Interoperability",
    status: "limited",
    source: ["src/features/importer.ts", "src/modules/export/native-twin-ifc.ts"],
    evidence: ["tests/", "docs/CSP.md (end-to-end import verified under CSP, v0.74.0)",
      "Interop-report unit suite tests/ifc-interop-report.test.cjs — 9 assertions: instance counting, whitespace tolerance, cap/truncated flag, FILE_SCHEMA extraction, latin1 byte decoding, non-STEP rejection, format lines with the honest caveat",
      "The report is a single linear scan of the STEP instance table (src/modules/ifc-semantics/interop-report.ts) — no extra web-ifc WASM pass; it runs on fresh conversions AND FRAG-cache hits, and the import queue row exposes it as an expandable Entity inventory block"],
    limitations: [
      "Schema coverage per web-ifc 0.0.77 (IFC2x3/IFC4); per-entity interop report v1 ships a STEP instance inventory per imported file (entity types + counts + FILE_SCHEMA, shown per import-queue row and via the importer service) — counts come from the STEP table and are NOT a per-type conversion guarantee: the FRAG conversion is monolithic, so which types rendered is not yet itemised per type",
      "Round-trip fidelity measured only for the native-twin path, not arbitrary third-party IFC",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dxf-import-export",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/drawings/dxf-reader.ts", "src/modules/drawings/dxf-writer.ts"],
    evidence: ["tests/"],
    limitations: ["2D drawing scope; unsupported entities are reported, not silently dropped"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dwg-import",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/drawings/dwg-engine.ts", "src/modules/cad-link/index.ts", "src/modules/cad-link/dwg-reader-worker.ts"],
    evidence: ["tests/dwg-reader-isolation.test.cjs", "tests/cad-dwg-roundtrip.test.cjs"],
    limitations: [
      "DWG version coverage per LibreDWG WASM (@mlightcad/libredwg-web); fixtures verified AC1009/AC1015/AC1024/AC1032",
      "Reader runs in an isolated worker: LibreDWG embind needs dynamic invoker generation, forbidden by the main-document CSP (no 'unsafe-eval')",
      "Entity types the reader cannot map (for example SHAPE and ATTDEF in old R11 files) are counted and reported as skipped, not imported; see the DWG export entry for the write side",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dwg-export",
    area: "Interoperability",
    status: "limited",
    source: [
      "src/features/cad-viewer.ts",
      "src/modules/drawings/acad-engine.ts",
      "src/modules/drawings/dxf-writer.ts",
      "cad-engine-rust/src/lib.rs",
    ],
    evidence: ["tests/cad-dwg-roundtrip.test.cjs", "tests/cad-dwg-export.test.cjs", "tests/cad-acad-engine.test.cjs"],
    limitations: [
      "Local DXF-to-DWG conversion through acadrust (MPL-2.0); no paid SDK, remote service or API key",
      "Verified by reading the written DWG back with the same engine (hatch fills, linetypes, lineweights, true colour, layer state, text styles, the first paper-space sheet with its viewports, all six offered versions, and the repo's DWG fixtures). Cross-application validation has not been performed, so DWG interoperability beyond the automated local round-trip remains unverified; the CI round-trip test passes",
      "Version choice (DWGVERSION): DWG versions 2000 through 2018+; version 2000 converts true colour to the nearest ACI colour index",
      "Blocks are written exploded and wipeouts as outlines; every paper-space sheet is written (with its viewports) but sheet names are not kept in DWG, and plain DXF still saves only the first sheet; dimension styles may be simplified",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "aps-conversion",
    area: "Interoperability",
    status: "experimental",
    source: ["server/index.mjs", "src/services/rfaImport.ts", "src/services/bimRoundTrip.ts"],
    evidence: ["tests/server-hardening.test.cjs"],
    limitations: [
      "Requires user-configured Autodesk Platform Services credentials; model files are uploaded to APS by explicit user action only",
      "UX flow and failure states still being completed (Phase 3)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "bcf-21",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/issues/bcf.ts", "src/modules/export/bcf21.ts"],
    evidence: ["tests/"],
    limitations: ["Two-application round-trip validation pending (Phase 4 fixtures)"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ids-audit",
    area: "Interoperability",
    status: "limited",
    source: ["src/features/ids.ts", "src/features/ids-panel.ts"],
    evidence: ["tests/"],
    limitations: ["Unsupported IDS facets are not yet itemised per spec (Phase 4)"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "sheets-views-pdf",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/views/", "src/modules/export/pdf.ts", "src/modules/export/sheet-pdf.ts", "src/features/sheets-2d-panel.ts"],
    evidence: ["tests/", "real browser: + Sheet → + Viewport renders the authored plan into the viewport; Export SVG issues a real download (A-001.svg); 'Place on sheet' from the Schedules panel lands on sheet A-001", "real browser (v54 re-run): saved Wall Schedule E2E → 'Placed ... on sheet A-001' → Export SVG (9.9 KB) + Export PDF (PDF 1.7) both contain the full 4-row table (Wall 001–004, grand totals 264.793 m / 1588.758 m² / 202.566 m³) — PDF text-extraction verified", "browser chain spec (document-chain.spec.ts, production bundle): Sheets panel '+ Sheet' creates a sheet row, and Export IFC4 from the File tab downloads a real 7,694-byte ISO-10303-21 STEP file of the authored model"],
    limitations: [
      "Sheet composition covers the v M3 scope; not a full drawing-sheet editor",
      "Viewport fit is extent-based, not content-tight — an 18 m wall renders small on a 40 × 28 m default window",
      "The panel was invisible behind the Floor Plan (z=36 vs 200) and 'Toggle Sheets' dead (unregistered service key) — both fixed; sheet PDF/DWG output itself is exercised by tests, not opened in a reader here",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "schedules-cost",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/schedules/", "src/modules/cost/"],
    evidence: ["tests/", "tests/schedule-totals.test.cjs", "tests/openings-chain.test.cjs", "Rule-engine unit suite tests/qto-rules.test.cjs — 26 assertions",
      "Property-filter unit suite tests/qto-property-filters.test.cjs — 20 assertions: editor text format (= ~ exists), validation, equals/contains/exists matching, AND-composition with source/token filters, IFC aggregate uniformity semantics, row property shaping (element bag + psets, Qto_* sets skipped)",
      "Element-classification roll-up suite tests/qto-classification-rollup.test.cjs — 7 assertions: rules without a classification decompose onto assigned element codes (Uniclass/any system), waste-scaled buckets sum to the rule quantity, same-code accumulation across rules with rule ids, explicit-classification rules excluded, uncoded rows excluded; panel block + Rules CSV rows",
      "Property filters in the editor: a 'Property filters' field parses 'Name = value; Name ~ text; bare name' clauses into the filter — every clause must match; authored rows carry their element properties, IFC rows carry pset properties uniform across the aggregate (divergent values omitted, so a clause only matches what is true for every element in the row)", "real browser: Door/Window/Wall schedules return 1 row for authored geometry and the wall take-off equals the cut-mesh volume", "real browser (v54 re-run): Wall Schedule over 4 authored walls → Length/Area/Volume per row, Volume = L×H×t exact (30.420 × 3 × 0.255 ≈ 23.271 m³), Area = both faces, grand total row rendered; Snapshot/Diff and 'Save the schedule first' guardrail live", "browser chain spec (document-chain.spec.ts, production bundle): out-of-box default is now the all-elements Quantity Takeoff (tpl-qto) — a single authored wall renders Wall 001 with Length/Area/Volume (84.683 m / 508.099 m² / 64.783 m³) on FIRST open, where it previously fell back to the Door Schedule and showed '0 rows · 0 authored'; after inserting a door + window the panel regenerates on reopen (authored-count staleness trigger) and the wall recuts to 63.872 m³ — 0.911 m³ of real geometry removed", "5D QTO rules engine (src/modules/cost/qto-rules.ts): 12 built-in work-item rules (concrete per class net of openings, wall formwork = both faces, paint +5% waste, rebar at a generic 100 kg/m³ → kg, door/window counts, centreline length) that FILTER takeoff rows, DERIVE quantities through the same safe AST formula compiler schedules use (no eval), apply waste factors, roll up by classification code and price against the rate book by cost CODE with strict unit matching — unit mismatch is an error, never silently-wrong money; one broken rule lands in run.errors and cannot abort the batch", "Rule editor UI (cost panel → QTO Rules tab): create/edit/delete custom rules and copy built-ins as starting points; 10-field form (name, formula with live validation, unit, waste %, classification, source, match/exclude tokens, level filter, cost code, description) validated by the pure normalizeQtoRuleInput — every problem reported at once, invalid rules never reach localStorage; draft state survives panel re-renders; takeoff rows now carry height/thickness/width dims and the level name, so rule formulas can reference Height/Thickness/Width (0 where the type or IFC has none — never estimated) and filters can pin a rule to level names"],
    limitations: [
      "5D rules v3: formulas see the base quantities plus Height/Thickness/Width dims; filters pin match/exclude tokens, source, level names AND per-property clauses (authored element properties; IFC pset properties uniform across the whole category aggregate — divergent values are omitted, so a clause can only match what is true for every element in that aggregate row), and IFC rows carry no dims (dim-based rules evaluate them as 0)",
      "Rebar built-in uses a generic 100 kg/m³ ratio and rule classification strings stay free text — published systems (UniFormat II / Uniclass 2015 EF / OmniClass Table 21) live in the classification-systems feature and their codes are offered in the rule editor datalist, but element assignments do not yet drive rule roll-up; unit-price escalation, per-level cost totals and cost-essay download formats (CostX etc.) are absent",
      "Wall volume/area now deducts hosted door/window openings (matches the cut 3D mesh); curtain/arc-wall take-offs stay chord-based approximations",
      "Hosted door/window rows show 0 for the all-elements take-off's Length/Area/Volume columns (host geometry quantities are carried by the wall row); dedicated Door/Window templates still expose width/height",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "p6-4d-5d-6d",
    area: "Analysis",
    status: "experimental",
    source: ["src/modules/schedule-4d/", "src/modules/timeline/", "src/features/timeline-panel.ts", "src/modules/cost/qto-rules.ts", "src/features/cost-panel.ts"],
    evidence: ["tests/schedule-4d.test.cjs", "Rule-engine unit suite tests/qto-rules.test.cjs — 26 assertions covering filtering, formula derivation, dimension variables (Height/Thickness/Width), level filters, waste factors, batch-resilient errors, strict-unit pricing, classification roll-up, rule-input normalization and custom-rule persistence", "cost panel ships a 4th tab 'QTO Rules' with a full rule editor: create/edit/delete custom rules, copy built-ins, live formula validation, classification roll-up block, per-rule pricing from the rate book and a Rules CSV export; rule tooltips carry the formula + assumption text"],
    limitations: [
      "P6 import covers XER and PMXML activities, WBS, relationships and resource-assigned cost; calendars, resource loading and baselines are not read",
      "Activity-to-element links use element properties (activityId, wbs) or name/level vocabulary; only authored elements are linked, imported IFC objects are not yet",
      "6D carbon uses generic indicative factors (editable) - not project EPDs",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "clash-detection",
    area: "Analysis",
    status: "limited",
    source: [
      "src/features/clash-engine.ts",
      "src/features/clash-authored.ts",
      "src/modules/clash/clash-core.ts",
      "src/modules/clash/mesh-queries.ts",
      "src/modules/clash/selection-plan.ts",
      "src/workers/clash.worker.ts",
    ],
    evidence: ["tests/clash-engine.test.cjs", "tests/clash-selection-plan.test.cjs", "tests/clash-review-dock.test.cjs"],
    limitations: [
      "Pair maths (surface crossing, element fully inside another, touching within tolerance, clearance, A-vs-B selection inside one model, across models and linked models) is tested on real triangle meshes in Node; the panel, IFC loading and linked-model placement have not been run in a browser against real files",
      "Containment and inside tests assume closed solids; open or badly modelled meshes can be mis-judged",
      "Elements with no usable geometry, or more than 120,000 triangles, are tested by bounding box only (may over-report); the status line counts them",
      "Hard clash ignores contact up to the tolerance (default 5 mm): a wall resting on a slab is 'touching', not a clash",
      "Native (authored) elements are tested from their render meshes; hidden ones are still included",
      "Clashes cannot be guaranteed 100% complete: the report states how many elements were tested and which were not",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "classification-systems",
    area: "Modeling",
    status: "limited",
    source: ["src/modules/classification/index.ts", "src/features/property-palette.ts", "src/modules/bim-gaps/bim-gaps-boot.ts", "src/features/cost-panel.ts"],
    evidence: [
      "tests/classification.test.cjs",
      "tests/ifc.test.cjs",
      "Seed tables are verified starter subsets, not invented: UniFormat II ships the full Level 1-3 list from NISTIR 6389 (Charette & Marshall, NIST 1999, implementing ASTM E1557) including the Building Sitework chart — 108 codes (7 groups, 22 level-2, 79 elements, e.g. B2010 Exterior Walls, C1010 Partitions, A1010 Standard Foundations, G2030 Pedestrian Paving); Uniclass 2015 table EF ships a 35-code subset checked against the published NBS table (EF_25_10_25 External walls, EF_25_30_97 Windows, EF_30_20_93 Upper floors, EF_35_10_40 Internal stairs) with the buildingsmart identifier URI; OmniClass Table 21 ships an 11-code verified subset (21-02 20 10 Exterior Walls, 21-01 10 10 10 Wall Foundations)",
      "ifc.test.cjs locks the export contract: assignments render as IfcClassification (7 attrs IFC4 / 4 attrs IFC2X3) + IfcClassificationReference + IfcRelAssociatesClassification, non-exported classified elements land in stats.skipped, and no option means zero classification entities",
    ],
    limitations: [
      "Bundled tables are starter subsets — full Uniclass (all 12 tables) and OmniClass (all 15 tables) editions are not redistributed; importCodesFromCsv extends the built-in systems from 'Code,Title' rows at runtime with a 2000-code-per-system cap",
      "One classification code per (element, system): assignments are per element instance with no type-level inheritance and no multi-code assignment within one system",
      "Assignments travel to IFC export and are visible in the property palette; the QTO rules engine now resolves element classification codes (rules without their own classification decompose onto the element's assigned code — byElementClassification roll-up + panel block + CSV rows), but SCHEDULES still group by their own free-text rule/category strings",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "collaboration",
    area: "Platform",
    status: "limited",
    source: ["server/index.mjs", "src/modules/collaboration/realtime-client.ts"],
    evidence: ["tests/server-hardening.test.cjs", "tests/server-security.test.cjs"],
    limitations: [
      "Persistence is whole-file JSON, not transactional (Phase 5)",
      "Conflict semantics are last-writer-wins via Yjs updates; no formal CRDT guarantee audit",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ai-assistant",
    area: "Platform",
    status: "limited",
    source: ["src/features/ai-providers.ts", "src/features/ai-privacy.ts", "src/features/anthropic-messages.ts", "src/features/ai-presets.ts"],
    evidence: ["tests/ai-privacy.test.cjs", "tests/anthropic-messages.test.cjs", "tests/ai-presets.test.cjs"],
    limitations: [
      "Cloud providers receive redacted prompts by design; local providers (Ollama) use a separate path",
      "Claude uses the user's own Anthropic API key (billed to their account); a Claude.ai free/Pro login is not an API credential and cannot be used. Request/stream mapping is unit-tested but has not been run against the live Anthropic API",
      "Custom endpoint URLs require deployment-side CSP extension (docs/CSP.md)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "plugin-system",
    area: "Platform",
    status: "limited",
    source: ["src/plugins/loader.ts", "src/plugins/api.ts", "src/plugins/types.ts"],
    evidence: ["tests/plugins-api.test.cjs"],
    limitations: [
      "Plugins are same-origin trusted code — no sandbox (documented trust model, docs/PLUGIN_SDK.md)",
      "Manifest integrity pins are optional and enforced only when declared",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "encrypted-projects",
    area: "Platform",
    status: "verified",
    source: ["src/modules/projects/project-crypto.ts"],
    evidence: ["tests/"],
    limitations: [],
    affirmedIn: APP_VERSION,
  },
  {
    id: "project-persistence",
    area: "Platform",
    status: "limited",
    source: ["src/modules/projects/projects.ts", "src/modules/projects/store.ts", "src/shell/status-bar.ts", "src/shell/ribbon.ts"],
    evidence: [
      "tests/",
      "real browser (v54): project created → Wall tool + Door tool → Ctrl+S → IndexedDB 'projects' store holds the doc → reload → reopen from the welcome screen recents restores wall + door (getElementCount 2)",
      "Auto-reopen: boot step 'project-auto-reopen' reopens the last opened/created project after every setup step — unit suite tests/project-auto-reopen.test.cjs — 12 assertions (decision matrix, pointer round-trip, stale-pointer silent clear, live-session guard, missing-service and storage-failure bail-outs)",
    ],
    limitations: [
      "Auto-reopen matches intent because there is no 'close project' action — a session always ends with its last project; if you delete that project the pointer is cleared and the welcome screen shows",
      "Auto-reopen is decision-matrix unit-tested; the live boot → reopen → overlay-hides path has not been driven in a browser yet",
      "Ribbon pill used to render a green 'SAVED' next to 'No project' while unprojected modeling lived only in memory and died on reload — fixed: unprojected content now reads 'NO PROJECT — UNSAVED' (verified live)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "browser-e2e-chain",
    area: "Platform",
    status: "verified",
    source: ["tests/e2e/document-chain.spec.ts", "playwright.config.ts", "src/features/drawing.ts", "src/modules/schedules/schedule-templates.ts"],
    evidence: [
      "Browser chain spec (tests/e2e/document-chain.spec.ts) — the full document chain in a REAL browser against the PRODUCTION vite preview bundle (chromium, 35–38 s): boot with zero page errors → Authoring workspace card closes the home overlay → Wall ribbon click activates the tool (contextual strip swaps to Chain) → 2 canvas clicks + Enter author a wall (authored elements 0 → 1) → Schedules opens with the all-elements Quantity Takeoff (Wall 001: Length 84.683 m / Area 508.099 m² / Volume 64.783 m³) → Door + Window inserted on the wall → Schedules regenerate on reopen (authored-count staleness trigger) → Door 001 + Window 001 rows appear and the wall recuts to Volume 63.872 m³ (0.911 m³ of real geometry removed) → Sheets panel '+ Sheet' creates sheet (1 row) → Export IFC4 downloads a real 7,694-byte ISO-10303-21 STEP file. Uncaught page errors asserted at every step",
      "Dev-mode white-screen boot bug found and fixed during this check: authoring.ts ↔ drawing.ts form an import cycle, and drawing.ts eagerly snapshotted authoring's activeToolLabel at module-evaluation time — when the entry graph reached drawing.ts while authoring.ts was still mid-evaluation the read hit the TDZ ('Cannot access activeToolLabel before initialization' → blank page). Fixed as a pure lazy re-export (`export { activeToolLabel } from \"./authoring\"`), which is cycle-safe and always live. Unit tests could not catch this; only a real browser boot could — the reason this spec exists",
      "Schedules out-of-box default fixed: the panel cloned BUILT_IN_TEMPLATES[0] (Door Schedule) and reused a stale run on reopen, so a wall-only model opened on '0 rows · 0 authored' with no volume column. The default is now the all-elements Quantity Takeoff (tpl-qto) and reopening regenerates when the authored element count changed (verified by the chain spec's 64.783 → 63.872 m³ assertion)",
      "Ribbon File tab rendered two identical Issues buttons (copy-paste duplicate) — removed",
      "All 6 affected unit suites re-run green after the schedules changes: schedule-totals 8, schedule-sheet 16, schedule-4d 55, schedule-4d-ui 27, schedule-import 35, ribbon-collapse 24 assertions",
    ],
    limitations: [
      "Chain spec covers the happy path of the core chain; edit/undo/parametric-change branches remain covered by unit tests and the other e2e specs",
      "Two WALK MODE specs in orbit-rtl.spec.ts fail on slow headless renderers (frame-pacing sensitive: 'no shaking while pressed against the wall' reproduces on a pristine checkout; 'Space raised the eye' is flaky) — pre-existing, unrelated to the chain; browser-smoke CI is continue-on-error so they do not block",
      "browser-smoke CI job is non-blocking by design; a red chain does not fail the pipeline yet",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "web-security",
    area: "Platform",
    status: "verified",
    source: ["index.html", "docs/CSP.md", "server/security.mjs"],
    evidence: ["tests/dependency-safety.test.cjs", "docs/engineering/BASELINE.md §12 (v0.74.0 boot verification)"],
    limitations: [
      "Static CSP cannot enumerate user-supplied custom endpoint hosts (documented workaround)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "pwa-offline",
    area: "Platform",
    status: "limited",
    source: ["public/sw.js", "vite.config.ts"],
    evidence: ["tests/"],
    limitations: [
      "Offline precache covers built assets; no automated browser E2E of offline flows yet (Phase 7)",
      "Runtime-fetched wasm assets (web-ifc) require a full cache refresh on re-pin — see BASELINE §12 v0.74.0",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "performance-budgets",
    area: "Platform",
    status: "planned",
    source: [],
    evidence: ["docs/engineering/BASELINE.md §5"],
    limitations: ["Large-model performance budgets and benchmarks are Phase 6 scope"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "native-joins",
    area: "Modeling",
    status: "limited",
    source: ["src/modules/native-bim/linear-follow.ts", "src/features/authoring.ts"],
    evidence: ["tests/magnet.test.cjs"],
    limitations: [
      "Join/follow planning is unit-tested as pure logic; interactive behaviour has not been browser-tested",
      "Straight linear elements join with miter/butt; arc walls join at chord endpoints; compound layers receive shared openings",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "vertical-openings",
    area: "Modeling",
    status: "verified",
    source: [
      "src/modules/vertical-openings/vertical-openings.ts",
      "src/features/authoring.ts",
      "src/modules/bim-gaps/authored-ifc.ts",
    ],
    evidence: ["tests/vertical-openings.test.cjs"],
    limitations: [
      "Cuts polygon slab/roof/ceiling hosts; generator-built roofs (hip/gable/shed/valley in m2-geometry) are not cut yet",
      "Openings crossing a slab edge are clipped to the slab interior and reported, not resolved as edge splits",
      "Clipping assumes a convex opening footprint (rectangles); concave openings would need polygon boolean",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "wall-sweeps",
    area: "Modeling",
    status: "limited",
    source: ["src/modules/wall-sweeps/geometry.ts", "src/features/authoring.ts"],
    evidence: ["tests/ui-honesty.test.cjs", "tests/wall-sweep-ifc.test.cjs", "tests/wall-reveal-cutter.test.cjs"],
    limitations: [
      "Built-in profiles only (baseboard, cornice, wainscot, reveal); no custom profile editor",
      "Baseboards, cornices and wainscots export to IFC as IfcCovering (tessellated); the IFC export has not been opened in a third-party viewer",
      "Reveals are cut into straight walls with the same CSG used for door openings and export to IFC as IfcOpeningElement (RECESS); curved walls do not get reveals, and the cut has not been checked on screen or in a third-party viewer",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "shortcut-editor",
    area: "Interface",
    status: "limited",
    source: ["src/features/shortcut-editor.ts", "src/modules/shortcuts/shortcut-keys.ts", "src/features/shortcuts.ts"],
    evidence: ["tests/shortcut-keys.test.cjs", "tests/shortcut-sequences.test.cjs"],
    limitations: [
      "Key matching is unit-tested; the editor window itself has not been browser-tested",
      "Sequences of up to three letters; typing speed window is fixed",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-wall-detection",
    area: "Linking",
    status: "experimental",
    source: ["src/modules/cad-link/wall-detect.ts", "src/features/ai-tools.ts"],
    evidence: ["tests/wall-detect.test.cjs"],
    limitations: [
      "Works from line geometry on wall-like layers; hatches, blocks and xrefs are not interpreted",
      "Curved walls are not detected; results need review before use",
      "Capped at 3000 walls per run; tested on synthetic drawings only",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "point-cloud-linking",
    area: "Linking",
    status: "limited",
    source: ["src/modules/point-cloud/parsers.ts", "src/features/link-tools.ts"],
    evidence: ["tests/point-cloud-parsers.test.cjs"],
    limitations: [
      "Reads PLY, XYZ, PTS, PCD, LAS (1.0-1.4) and PTX",
      "LAZ, E57, RCP/RCS, RWCX and FLS cannot be decoded in a browser; export to LAS or E57-to-LAS first",
      "Whole cloud is loaded in memory; no level-of-detail streaming for very large scans",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-insert-tab",
    area: "Drawings",
    status: "experimental",
    source: [
      "src/modules/drawings/cad-blocks.ts",
      "src/modules/drawings/svg-import.ts",
      "src/modules/drawings/cad-fields.ts",
      "src/features/cad-viewer.ts",
    ],
    evidence: ["tests/cad-insert.test.cjs"],
    limitations: [
      "Block, insert, scale/rotation, write-block, SVG flattening and field maths are unit-tested; the dialogs, ghost placement and ribbon have not been run in a browser",
      "Inserted blocks are ordinary editable copies (like INSERT then EXPLODE): there is no block-reference identity, redefinition, attributes, dynamic blocks or non-uniform scale",
      "The block library is shared by all drawings in this browser and is not written into saved DWG / DXF files",
      "SVG import flattens curves to polylines; text, images, gradients, clip paths and <use> are skipped and reported",
      "Fields are evaluated once when inserted and do not update afterwards",
      "Not available: raster image attach, XREF / underlays, PDF import, point clouds, hyperlinks, data links, OLE",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-editor-styles",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/drawings/cad-styles.ts",
      "src/features/cad-style-ui.ts",
      "src/modules/drawings/dxf-writer.ts",
      "src/features/cad-viewer.ts",
    ],
    evidence: ["tests/cad-styles.test.cjs", "tests/cad-save.test.cjs", "tests/cad-hatch-save.test.cjs", "tests/cad-layout-save.test.cjs"],
    limitations: [
      "DXF write/read round trip (linetypes, lineweights, true colour, text font/style/anchor, layer lock/off) is tested; the editing dialogs have not been browser-tested",
      "Fonts are system fonts; SHX stroke fonts are drawn with a similar-looking font on screen and keep their names in saved DXF files",
      "Linetypes are dash/dot patterns only; complex linetypes with embedded text or shapes are not supported",
      "Saved DXF keeps solid and patterned hatches (pattern lines are written only when the file provided them, so a pattern known only by name may need the receiving program to supply it); blocks are saved exploded, wipeouts as outlines, and only the first paper-space layout (with its viewports) is saved, with a notice for the rest; plot/PDF output has not been verified to honour per-object lineweights",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "plan-annotations",
    area: "Drawings",
    status: "limited",
    source: ["src/features/plan-view-panel.ts", "src/modules/views/tools.ts", "src/modules/views/plan-dim-geometry.ts"],
    evidence: [
      "tests/openings-chain.test.cjs",
      "tests/parametric-wiring.test.cjs",
      "real browser (v54 chain check): Wall tool draws a wall that renders with two parallel face lines (poché) on a fresh boot; Aligned dimension completes the 3-pick flow (pick1 → pick2 → place) and renders the measured value 11024 with architectural tick marks and extension lines; Section Line drawn from the main plan canvas creates a section view listed in the Views panel; Wall schedule over the drawn wall returns 1 row with Volume = L×H×t exact (18.50 × 3.0 × 0.2 = 11.10 m³)",
      "four breaks found by the same browser pass and fixed: plan footer status was wiped by every re-render (multi-pick prompts like 'Click to place the dimension line' disappeared instantly), the Annotate ▸ Section Line tool accepted canvas clicks only in the Views panel preview (the main plan canvas never forwarded picks), the section-line state machine gated every pick behind a model-reference hit (an empty model could never produce a section), and the plan footer/status strings carried U+FFFD tofu from a historical byte corruption (795 occurrences across the plan panel and all 9 i18n catalogs, restored to house-style separators)",
    ],
    limitations: [
      "Dimension text is paper-scaled (2.5 mm at 1:100 = 0.25 m world) and therefore tiny at fit-to-window zoom; it grows when zooming in but has no minimum on-screen size",
      "The section cut line is stored on the created view but is not yet drawn as a section marker in the plan; opening the section view routes through the Views panel",
      "Tag creation pushes to the annotation store and re-renders, but the tag symbol render was not pixel-confirmed in this pass",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "plan-command-line",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/plan/plan-commands.ts",
      "src/features/plan-command-line.ts",
      "src/features/plan-view-panel.ts",
    ],
    evidence: ["tests/plan-commands.test.cjs"],
    limitations: [
      "Command table, aliases and coordinate parsing (x,z  @dx,dz  d<angle  length) are unit-tested; the command bar is visible in the plan workspace (WA/L/DI/Z/O/P hints) and Esc cancel-all was observed live ('Cancelled — all commands ended'), but typed command execution has not been driven in a browser",
      "Direct coordinates are metres and only drive Place tools (linear paths and point elements), not dimensions, tags or Move",
      "Esc no longer closes the plan view; use the Close button or the CLOSE command",
      "SELECTALL and box selection pick authored elements on every level, not only the level shown in the plan",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "critical-workflow-pack",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/bim-gaps/critical-workflow-pack.ts",
      "src/features/command-palette.ts",
    ],
    evidence: [
      "Unit suite tests/critical-workflow-pack.test.cjs — 15 assertions: 10 palette registrations, zero window globals, fixture math for schedules/takeoff/match-prop/space/column-grid/sheet-pack/view-pack",
      "The 10 commands were originally wired through dead channels (a window registry method that did not exist plus an event with no listener); they now register directly into the command palette, which the unit suite captures",
    ],
    limitations: [
      "The three schedules and the material takeoff print via console.table and persist under the obs.schedule.* localStorage keys; there is no dedicated viewer panel for them — sheet-based schedules use the separate schedule feature",
      "matchProperties copies only wallTypeId/family/layers/Material and thickness/height between same-category elements; other instance parameters are not matched",
      "columnsOnGrid intersects grid segments only (needs 2+ grids); no wall-face or manual override placement",
      "spaceElementsEvenly spaces point elements along the implicit x-then-z sorted line between first and last; arbitrary paths are not supported",
      "Palette interaction (searching the 10 commands and running them live) has not been driven in a browser; registration is proven by unit test",
    ],
    affirmedIn: APP_VERSION,
  },
] as const;

/** Look up a feature's maturity by id. */
export function getFeatureMaturity(id: string): FeatureMaturityEntry | undefined {
  return FEATURE_MATURITY.find((f) => f.id === id);
}

/** Features grouped by their area label (order of first appearance). */
export function featureAreas(): { area: string; features: FeatureMaturityEntry[] }[] {
  const areas: { area: string; features: FeatureMaturityEntry[] }[] = [];
  for (const f of FEATURE_MATURITY) {
    let bucket = areas.find((a) => a.area === f.area);
    if (!bucket) {
      bucket = { area: f.area, features: [] };
      areas.push(bucket);
    }
    bucket.features.push(f);
  }
  return areas;
}
