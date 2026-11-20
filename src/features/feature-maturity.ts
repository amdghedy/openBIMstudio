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
      "The report is a single linear scan of the STEP instance table (src/modules/ifc-semantics/interop-report.ts) — no extra web-ifc WASM pass; it runs on fresh conversions AND FRAG-cache hits, and the import queue row exposes it as an expandable Entity inventory block",
      "Per-entity fidelity report (#106, src/modules/ifc-semantics/per-entity-report.ts): import + export + round-trip rows per GlobalId with status (preserved / transformed / approximated / unsupported / skipped / failed) and reason codes; tests/ifc-per-entity-report.test.cjs — 20 assertions; tests/ifc-per-entity-roundtrip.test.cjs — 7 assertions incl. web-ifc 0.0.77 cross-check; tests/ifc-per-entity-corpus.test.mjs — drift gate on the checked-in reports; main corpus measured 69 products (65 preserved / 2 transformed / 1 approximated / 1 failed, tests/fixtures/ifc-corpus/per-entity-reports/summary.json)"],
    limitations: [
      "Schema coverage per web-ifc 0.0.77 (IFC2x3/IFC4); the per-entity report itemises STEP/semantic-model fidelity per imported file (type mapping, geometry, placement, property sets, relationships, reason codes — shown per import-queue row and via the importer service), but it is NOT a per-entity web-ifc FRAG-conversion claim: the FRAG conversion is monolithic, so which types rendered into the FRAG model is not yet itemised per type. The web-ifc leg is a Node cross-check (presence + type per GlobalId) in the corpus summary, not a browser proof",
      "Round-trip fidelity measured only for the native-twin path, not arbitrary third-party IFC; no issued file has been opened in a desktop BIM/CAD tool",
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
    source: ["src/modules/issues/bcf-markup.ts", "src/modules/issues/bcf.ts", "src/modules/export/bcf21.ts"],
    evidence: [
      "tests/",
      "BCF 2.1 markup round-trip suite tests/bcf21-roundtrip.test.cjs — 22 assertions: the shared writer (src/modules/issues/bcf-markup.ts, used by BOTH the issues panel exportBCF and the clash/standards bcf21 writer) emits the spec dialect — Topic carries only Guid/TopicType/TopicStatus as attributes while Title/Priority/Labels/CreationDate/CreationAuthor/ModifiedDate/ModifiedAuthor/DueDate/AssignedTo/Description are child elements, comments are Guid attribute + Date/Author children + nested <Comment> text, labels are <Labels><Label> children, and topic guids are RFC 4122 UUIDs (internal \"issue-…\" ids are regenerated to keep GuidType valid); XML escaping, optional-element omission, header/viewpoint placement and parseBcfMarkup round-trip of every field to second precision are all asserted",
      "Dual-dialect reader: files written by older builds in the legacy attribute dialect (Title=…/Priority=… attributes, <DescriptionText>, comment Date/Author attributes with <Text> text) still import unchanged, and malformed markup throws per topic folder while importBCF keeps the rest of the batch",
      "Honesty note: before this suite the repo shipped two writers in two dialects with one reader — the issues writer's markup was not BCF 2.1 markup.xsd-conformant (external consumers drop or reject attribute titles and <Text> comments) and the conformant clash writer's output could not be re-imported by our own importer (which read attributes), so titles, priorities, descriptions and comment text/authors were silently lost in both directions; both writers now share one canonical dialect and the round trip is unit-verified",
    ],
    limitations: [
      "The round trip is unit-verified at the markup.xml level in Node with an injected minimal parser shim; the full-zip importBCF path (JSZip + viewpoint.bcfv camera/components/clipping parsing) and both panels are exercised only in the browser, not in this suite",
      "No third-party application round trip yet — Navisworks/Solibri/BIMcollab fixtures are still pending, so the Header provenance and IfcGuid → local-fragment viewpoint resolution remain untested against another tool's writer/reader",
      "The writer emits BCF 2.1 only (the BCF 3.0 schema reference in src/modules/bcf/bcf3-schema.ts is not implemented on the write side), and snapshot.png is written without a thumbnail reference in markup (consumers read it by folder convention)",
    ],
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
      "Rebar built-in uses a generic 100 kg/m³ ratio; unit-price escalation, per-level cost totals and cost-essay download formats (CostX etc.) are absent",
      "Wall volume/area now deducts hosted door/window openings (matches the cut 3D mesh); curtain/arc-wall take-offs stay chord-based approximations",
      "Hosted door/window rows show 0 for the all-elements take-off's Length/Area/Volume columns (host geometry quantities are carried by the wall row); dedicated Door/Window templates still expose width/height",
      "Schedules now carry each element's assigned classification code/title/system as row values and can group by full code or hierarchical prefix (see classification-systems); IFC-imported rows carry no classification because the fragments API does not expose IfcClassificationReference",
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
      "src/modules/clash/scenario-io.ts",
      "src/workers/clash.worker.ts",
    ],
    evidence: [
      "tests/clash-engine.test.cjs", "tests/clash-selection-plan.test.cjs", "tests/clash-review-dock.test.cjs",
      "Scenario persistence suite tests/clash-scenarios.test.cjs — 21 assertions: fully-populated scenario (id/name/testName/tolerances/scope/method/A-B selections/per-clash status-comment-assignee snapshot/last-run summary) survives serialize → JSON → parse byte-identically, writer and reader share one dialect, malformed rows and duplicate or missing ids dropped without throwing, unknown statuses reset to 'new', comment rows without text dropped with positional fallback ids, 200-scenario and 500-selection-key caps enforced, negative/non-finite numbers clamp, {clashScenarios:[…]} wrapper accepted, scope whitelist, run summaries keep unknown kind buckets; clash matrix: wall×duct and duct×wall collapse into one order-normalized cell, same-category pairs on the diagonal, categories and cells sorted, totals honest, missing categories bucketed as 'Uncategorized', deterministic JSON; source guards: scenario-io is DOM-free (no window/document/three), projects.ts save/restore wiring pinned, ClashService interface declares the pair",
      "Saved scenarios (named clash tests) now travel with the project document: saveProject flushes clashScenarios through the clash service and openProject restores them (legacy documents without the field keep their localStorage working copy); scenarios were previously localStorage-only, so a project opened on another machine lost every saved test",
      "The HTML clash report ships a category × category clash matrix with heat shading, order-normalized pairs (A×B = B×A) and diagonal same-category cells; the grid collapses to a top-pairs list beyond 15 categories",
    ],
    limitations: [
      "Pair maths (surface crossing, element fully inside another, touching within tolerance, clearance, A-vs-B selection inside one model, across models and linked models) is tested on real triangle meshes in Node; the panel, IFC loading and linked-model placement have not been run in a browser against real files",
      "Scenario project persistence is proven at the data layer in Node (serialize/parse wiring pinned in source); the restore path itself has not been driven in a browser session — save a scenario, reload the project, see it back",
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
      "tests/schedule-classification.test.cjs — 33 assertions: cumulative code prefixes for all three published systems (Uniclass EF_25_10_25 → EF/EF_25/EF_25_10/EF_25_10_25, OmniClass '21-02 20 10' → space cuts, UniFormat B2010 → B/B2/B2010), depth clamps and full-code fallback, deterministic first-assignment resolution (unknown system or code skipped, junk tolerated, never throws), coded vs uncoded row values, assignment persistence serialize → JSON → restore byte-identical with tolerant restore (junk/unknown/duplicates dropped, legacy null no-op, [] clears), hierarchical group/subtotal roll-up where per-group sums add up to the grand total, and source pins for generator wiring / bucket union / template / project hooks / CI registration / DOM-free guard",
      "Assignments travel with the project document: saveProject flushes classificationAssignments and openProject restores them (legacy documents without the field keep their working copy); assignments were previously browser-storage-only, so a project opened on another machine lost every code — and with it the IFC export payload and the schedules grouped by classification",
      "Seed tables are verified starter subsets, not invented: UniFormat II ships the full Level 1-3 list from NISTIR 6389 (Charette & Marshall, NIST 1999, implementing ASTM E1557) including the Building Sitework chart — 108 codes (7 groups, 22 level-2, 79 elements, e.g. B2010 Exterior Walls, C1010 Partitions, A1010 Standard Foundations, G2030 Pedestrian Paving); Uniclass 2015 table EF ships a 35-code subset checked against the published NBS table (EF_25_10_25 External walls, EF_25_30_97 Windows, EF_30_20_93 Upper floors, EF_35_10_40 Internal stairs) with the buildingsmart identifier URI; OmniClass Table 21 ships an 11-code verified subset (21-02 20 10 Exterior Walls, 21-01 10 10 10 Wall Foundations)",
      "ifc.test.cjs locks the export contract: assignments render as IfcClassification (7 attrs IFC4 / 4 attrs IFC2X3) + IfcClassificationReference + IfcRelAssociatesClassification, non-exported classified elements land in stats.skipped, and no option means zero classification entities",
    ],
    limitations: [
      "Bundled tables are starter subsets — full Uniclass (all 12 tables) and OmniClass (all 15 tables) editions are not redistributed; importCodesFromCsv extends the built-in systems from 'Code,Title' rows at runtime with a 2000-code-per-system cap",
      "One classification code per (element, system): assignments are per element instance with no type-level inheritance and no multi-code assignment within one system",
      "Schedules now group and subtotal by the assigned code (full code, 2-level and 3-level prefixes with an 'Uncoded' bucket) — proven at the data layer in Node; the browser run of a classification-grouped schedule has not been driven end to end, and IFC-imported elements resolve no classification references (only authored elements carry assignments)",
      "Assignments persist per project document but the restore path has not been driven in a browser session (save, reload, see the codes back)",
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
      "Documents now also carry classificationAssignments (UniFormat II / Uniclass 2015 EF / OmniClass rows): saveProject flushes them from the classification module, openProject restores them with legacy-document guard — 33-assertion suite tests/schedule-classification.test.cjs pins the hooks in source",
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
  {
    id: "mep-engineering-suite",
    area: "MEP",
    status: "limited",
    source: [
      "src/modules/mep/index.ts",
      "src/modules/mep/router.ts",
      "src/modules/mep/sizing.ts",
      "src/modules/mep/sizing-methods.ts",
      "src/modules/mep/pressure.ts",
      "src/modules/mep/network.ts",
      "src/modules/mep/flow-assignment.ts",
      "src/modules/mep/connectivity.ts",
      "src/modules/mep/hvac-loads.ts",
      "src/modules/mep/electrical.ts",
      "src/modules/mep/plumbing.ts",
      "src/modules/mep/drainage.ts",
      "src/modules/mep/fire.ts",
      "src/modules/mep/lighting.ts",
      "src/modules/mep/insulation.ts",
      "src/modules/mep/protection-coordination.ts",
      "src/modules/mep/ifc-reconstruction.ts",
      "src/modules/mep/calculation-basis.ts",
      "src/modules/ifc-semantics/semantic-model.ts",
      "src/features/mep-fabrication.ts",
      "src/features/mep-coloring.ts",
    ],
    evidence: [
      "tests/mep-connectivity.test.cjs",
      "tests/mep-connectors.test.cjs",
      "tests/mep-flow-assignment.test.cjs",
      "tests/mep-network.test.cjs",
      "tests/mep-pressure.test.cjs",
      "tests/mep-router.test.cjs",
      "tests/mep-sizing-methods.test.cjs",
      "tests/mep-hvac-loads.test.cjs",
      "tests/mep-electrical-calc.test.cjs",
      "tests/mep-plumbing.test.cjs",
      "tests/mep-lifecycle.test.cjs",
      "tests/mep-stretch.test.cjs",
      "tests/mep-connectivity-index.test.cjs — 31 assertions: grid-indexed connectedPairs equal the brute-force O(n²) scan on seeded random models (5 seeds × 5 sizes, dense cluster, oversize 600 m run), expandConnected/connectedSelection match brute-force BFS, 1,500-element sparse model indexes in ~47 ms",
      "tests/mep-ifc-reconstruction.test.cjs — 10 assertions: duct/pipe port-graph chains round-trip to one cluster, dangling/ownerless/self port connections are diagnostics, port-less files report unconnected, mixed-domain clusters suggest no system",
      "tests/mep-protection-coordination.test.cjs — 14 assertions: selectivity likely (2×) vs not-demonstrated (1.26×) vs invalid (upstream ≤ downstream), Icu/Ics vs fault current, chain and panel-link audits, missing ratings never silently pass",
      "tests/mep-calculation-basis.test.cjs — 5 assertions: every calculation area discloses method/standard/units/assumptions/limitations; no area claims validation stronger than unit tests; no record claims code compliance",
      "System-tree unit suite tests/mep-system-tree.test.cjs — 27 assertions (see mep-system-browser)",
    ],
    limitations: [
      "Connectivity is geometry-derived (free ends touching within tolerance), not stored connector semantics for plain runs; a run whose end lands on another run's body counts as connected even without a junction fitting. The pairwise pass is now grid-indexed (connectedPairs — exactly the old O(n²) scan, pruned), not O(n²) per recompute",
      "A connected cluster mixing two or more declared properties.system values is REJECTED as a system conflict (system null, diagnostic naming the members) — majority-vote acceptance was removed. Undeclared members still fall back to per-type defaults (duct → supply-air, pipe → domestic-cold)",
      "Sizing, pressure and load methods follow generic velocity/friction and ASHRAE-style table practice — not region-specific codes; electrical now includes breaker selectivity screening (1.6× rule of thumb, manufacturer curves govern) and breaking-capacity checks against caller-supplied fault currents, but still covers calculations rather than physical circuit wiring or manufacturer-curve coordination",
      "Imported IFC MEP connectivity is reconstructed at the semantic layer from IfcRelConnectsPorts/IfcRelNests where the file carries ports; files without ports report unconnected, and the live fragment-based System Browser still groups imported IFC by category (reconstruction is not yet wired into it)",
      "No MEP calculation is validated against a reference implementation, a code, or measured data for any jurisdiction — every area is unit-tested-only (see src/modules/mep/calculation-basis.ts); no code compliance is claimed",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "mep-system-browser",
    area: "MEP",
    status: "limited",
    source: [
      "src/features/system-browser.ts",
      "src/modules/mep/system-tree.ts",
    ],
    evidence: [
      "System-tree unit suite tests/mep-system-tree.test.cjs — 27 assertions: elbow- and tee-joined clusters form ONE named system, equipment heads the member list, declared-system conflicts are REJECTED (no majority vote, incl. a 3-to-1 majority), invalid system values ignored, unconnected singletons, non-MEP exclusion, per-system numbering by first appearance, fitting-only clusters via parentType, cable-tray/conduit labels, determinism, unique cluster ids, empty-tree shape, plus 8 registry tests (names survive recompute/reload via stamped properties, no renumbering on add/remove, merge keeps earliest name with a diagnostic, re-classification invalidates the old stamp, conflicts get no persistent identity)",
      "Panel v2 ships the tree: 'Model systems' built from real connectivity (click a system selects all members via setSelectedAuthored, expandable per-member rows, unconnected flagged), conflict clusters render red with their diagnostic and are counted in the summary, and an honest 'Imported (IFC)' category section",
    ],
    limitations: [
      "The real-system tree covers authored MEP elements; imported IFC elements stay grouped by IFC category in the fragment browser (port-graph reconstruction exists at the semantic layer — src/modules/mep/ifc-reconstruction.ts — but is not wired into the live fragment browser)",
      "Tree interaction (expand, member click, selection) is proven at the data layer in Node; the panel itself has not been driven in a browser session",
      "System names are persisted via mepSystemId/mepSystemName stamps on member properties (survive refreshes and project reloads); a name is only as durable as the next project save, and clusters that become conflicts lose their persistent identity until fixed",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "critical-workflow-pack-2",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/bim-gaps/critical-workflow-pack-2.ts",
      "src/features/command-palette.ts",
    ],
    evidence: [
      "Unit suite tests/critical-workflow-pack-2.test.cjs — 10 assertions: zero window globals in the compiled pack, all 11 commands (rg-modelcheck, rg-softclash, rg-ifc-export, rg-json-dump, rg-ortho-walls, rg-align-x, rg-align-z, rg-split-mid, rg-mirror-x, rg-select-sim, rg-purge) register into the REAL command palette, zero-length/unhosted model-check heuristics, merged validation diagnostics, duct-through-wall soft clash, select-similar, purge-degenerate",
      "The pack originally published results on dead window globals and dispatched its commands through a CustomEvent nobody listens to; it now registers directly into the palette and surfaces MODELCHECK/SOFTCLASH results on the workflowPack2 service getters",
    ],
    limitations: [
      "Soft clash is AABB pair-of-interest only (duct/pipe vs wall/beam/column and wall/beam self-overlap) — the mesh-level clash engine lives in the clash-detection feature",
      "MODELCHECK heuristics cover zero-length elements and unhosted doors/windows plus the native-model validation rules; it is not a full IFC validation suite",
      "Palette interaction has not been driven in a browser; registration is proven by unit test",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "critical-workflow-packs-3-7",
    area: "Platform",
    status: "limited",
    source: [
      "src/modules/bim-gaps/critical-workflow-pack-3.ts",
      "src/modules/bim-gaps/critical-workflow-pack-4.ts",
      "src/modules/bim-gaps/critical-workflow-pack-5.ts",
      "src/modules/bim-gaps/critical-workflow-pack-6.ts",
      "src/modules/bim-gaps/critical-workflow-pack-7.ts",
      "tests/critical-workflow-packs-34567.test.cjs",
    ],
    evidence: [
      "Unit suite tests/critical-workflow-packs-34567.test.cjs — 32 assertions over packs 3–7 (51 commands): every pack registers its commands into the REAL command palette (11+10+10+10+10), cost takeoff priced on fixtures (63 m² walls ×45 + 80 m² slab ×120 + 3 doors + 1 window + 0.945 m³ columns), flat topo pads model bounds by 5 m and places a terrain slab, matchline runs through bounds centre, generative grid study scores spacings (best 7.5 m on the fixture), group/ungroup stamps groupId, GIS origin is the exact element centroid, fine snaps drive the real snapping engine at 50 mm, wall justification sets exterior face with a thickness/2 shift, workshare locks stamp selection, Uniclass stamps per-type codes (11 on the fixture), materials seed six valid categories, mass uses the positional createMass(basePolygon, height, name) signature, model tree payload complete, zero window.__obs* globals",
      "Packs 3–7 originally shipped all 51 commands through a window CustomEvent (\"obs-register-command\") that no code in the repo listens to — the commands were invisible in the palette. They now register directly via registerCommand(), the same correction pack 1 and pack 2 went through",
      "Three shipped-defect repairs are pinned by this suite: pack-7's checker writes used to clobber the module-globals checker API the ribbon calls, materials used an invalid \"Generic\" category, and placeBoundingMass passed an object to a positional signature",
    ],
    limitations: [
      "Pack 3/4 behaviour is pinned at registration level plus the round-14 repairs (phases/issues/COBie/worksets/keynotes wiring, real (scheme, rooms) autoAssignColors); the full command bodies of packs 3 and 4 are not exercised on fixtures yet",
      "Pack-6 module fallbacks (families/fabrication/daylight/GIS/locks/details/justification/marketplace stubs) are exercised against stubbed engines; the real engines' own behaviour is covered by their module suites where those exist",
      "Palette interaction has not been driven in a browser; registration is proven by unit test",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "critical-workflow-pack-8",
    area: "Platform",
    status: "limited",
    source: [
      "src/modules/bim-gaps/critical-workflow-pack-8.ts",
      "src/modules/bim-gaps/bim-gaps-boot.ts",
      "tests/critical-workflow-pack-8.test.cjs",
    ],
    evidence: [
      "Unit suite tests/critical-workflow-pack-8.test.cjs — 13 assertions over the 10 automation/nav/query commands: every command registers into the REAL command palette, the dead window CustomEvent channel is gone from source AND compiled output, zero window-global mentions, runNlQuery passes the RAW STRING to the real executor contract and selects executor hits through setSelectedAuthored + saves the query, hierarchy totals/byType/hosted counts on a fixture (3 doors → 2 hosted + 1 unhosted), model curves draw through the real host-bound addModelCurve(hostId, faceIndex 0, 2-point polyline) with slab preferred, shared parameters seed exactly the 5 BIM params through the real store (idempotent), parameter engine ping drives the real parse→format roundtrip plus the symbol resolver, CDE providers and twin capability rows land on module getters, automation seeds/runs through the real rules module",
      "The pack originally shipped broken: 5 window globals (honesty-ratchet violations), all 10 commands on the listener-less CustomEvent channel, calls to module paths that do not exist (../shared-params/index, ../parameter-engine/engine) and an evaluate() the parameter engine has no such export of, an addModelCurve options bag instead of the positional (host, face, points) signature, and 8 compile errors that turned CI + the production build red — every one repaired against the real signatures",
    ],
    limitations: [
      "Frame selection is proven only at registration level; its camera path needs a live scene and has not been driven in a browser",
      "The parameter-engine ping exercises parse/format/symbols — the engine deliberately has no free-form evaluate()",
      "Model-curve axes are reference curves on a host face (the module is host-bound by design); the original 'axes at ±50 m with no host' concept cannot exist in this model",
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
