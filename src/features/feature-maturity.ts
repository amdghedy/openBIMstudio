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
    evidence: ["tests/adaptive.test.cjs", "tests/adaptive-native.test.cjs", "tests/e2e/adaptive-placement.spec.ts"],
    limitations: [
      "Native adaptive elements persist their profile and ordered 1–8 placement points and regenerate through the existing authoring mesh-builder hook; placement defaults to interactive 3D point picking in the viewport (canvas clicks), with coordinate text as a fallback — proven in a real browser by tests/e2e/adaptive-placement.spec.ts (two clicks place an adaptive sweep)",
      "Editing supports the stored point list and cross-section profile, and live 3D grips drag points in the viewport (grip spheres are screen-constant 8 px; a 0.16 m size cap that shrank them to ~1 px when zoomed out was removed in the same change); project-persistent geometric constraints, shared family-catalog/type propagation and IFC entity mapping remain follow-up work",
      "The native integration test uses a mock authoring service and JSON serialization; browser placement is now proven end-to-end (tests/e2e/adaptive-placement.spec.ts), but real project save/reopen and a representative building model still require end-to-end validation",
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
    id: "mass-to-elements",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/parametric/mass-to-elements.ts",
      "src/modules/in-place-mass/types.ts",
      "src/shell/ribbon.ts",
    ],
    evidence: ["tests/mass-to-elements.test.cjs", "tests/e2e/mass-to-elements.spec.ts"],
    limitations: [
      "A 4×4×3 mass converts to 4 walls + roof + foundation slab in a real browser (tests/e2e/mass-to-elements.spec.ts); the converter classifies faces by normal and area (bottom → foundation slab, small top → roof, large top → floor slab, sides → wall or curtain-wall by area) and reports refused faces instead of failing",
      "The mass itself is data-only — createMass stores a footprint + height and renders nothing, so there is no mass geometry to see before conversion; type-\"roof\" elements rendered nothing until this change added roofs and ceilings to the polygon slab builder",
      "No sloped-mass or multi-storey conversion: one height per mass, flat top only; conversion is one-shot with no live link back to the mass (editing the mass does not update the elements)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-sketch-editor",
    area: "Families",
    status: "experimental",
    source: ["src/modules/families/sketch-core.ts", "src/features/family-sketch-editor.ts"],
    evidence: ["tests/family-sketch.test.cjs", "tests/e2e/sketch-constraints.spec.ts"],
    limitations: [
      "Plan outlines only: one straight-edged outline per extrusion (free circles are polygons), holes only as fixed polygons inside an outline, no splines, sweeps or revolves; sketch arcs, reference planes and dimension-driven constraints exist at node level (tests/sketch-arcs-constraints.test.cjs) but the editor exposes no constraint controls or arc tool yet",
      "Free polygons are fixed data (only depth and elevation are parameters); rectangles and circles drawn as parametric shapes resize through width/length/radius parameters, but not when holes are present",
      "The core is tested, and the 3-D result (footprint, height, elevation, orientation) is checked only where real three.js is installed (CI); the drawing window is now driven in a real browser by tests/e2e/sketch-constraints.spec.ts (rectangle sketch → parametric family → the width dimension drives the rebuild)",
      "Built-in families are copied before a sketch is added, so the original stays intact",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "parametric-engine",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/families/parametric-engine.ts",
      "src/modules/families/registry-parametric.ts",
      "src/modules/families/parametric-geometry.ts",
      "src/modules/families/families-parametric-boot.ts",
      "src/critical-gaps-boot.ts",
    ],
    evidence: [
      "tests/parametric-closure.test.cjs",
      "tests/parametric-wiring.test.cjs",
      "No test in tests/ references buildParametricFamily, so the full rebuild path (resolve, formulas, constraints, extended geometry) is unproven as a whole even though its parts are unit-tested",
    ],
    limitations: [
      "The parametric engine is the live family service (setupParametricFamilies replaces the base service at boot and seeds the sample parametric door), but no test exercises buildParametricFamily and no browser proof exists that editing a parameter regenerates a family end to end",
      "Rebuild is from scratch on every call; there is no incremental or dirty-flagged rebuild inside the families modules",
      "Three separate engines coexist and are not the same system: the families engine, parametric-regen (dirty flags, used from parametric/wire-authoring) and parameter-engine (EffectiveValue, circular detection); the latter two still carry the core-geometry audit bugs on main (scientific-notation safeEval failure, circular-detection stack overflow) — their fixes live only on the unmerged fix/core-geometry-reliability branch, not on main",
      "Constraints solve parameter values, not geometry: there is no locked dimension, no alignment / parallel / perpendicular over sketch geometry, and no dimension-driven sketch constraint in the family-local graph",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-type-instance-model",
    area: "Families",
    status: "limited",
    source: [
      "src/modules/families/types.ts",
      "src/modules/families/registry.ts",
      "src/modules/families/registry-parametric.ts",
      "src/modules/families/placement.ts",
      "src/modules/projects/types.ts",
    ],
    evidence: [
      "tests/parametric-closure.test.cjs",
      "tests/seed-families.test.cjs",
    ],
    limitations: [
      "An instance is an AuthoredElement carrying familyId / familyTypeId, and its params object doubles as the instance-override store: after placement a type value and an instance override are indistinguishable in the element itself, there is no separate override record",
      "Families are stored per project in localStorage (obs.families.v1.<projectId>) and are not part of the saved project document: a project opened on another machine loses its user families while its instances keep dangling familyIds, and resolveParams then returns null while syncFamilyInstances returns 0 silently",
      "resolvePlacement filters new elements to GEOMETRY_KEYS only, so non-geometry family parameters never reach a new element's params",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-type-propagation",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/families/parametric-engine.ts",
      "src/modules/families/registry-parametric.ts",
      "src/modules/families/placement.ts",
      "src/features/authoring.ts",
    ],
    evidence: [
      "tests/",
      "No test in tests/ references propagateTypeChange or buildParametricFamily: type propagation is entirely unproven by any test on this base",
    ],
    limitations: [
      "The live path (editFamilyParameter to authoring.syncFamilyInstances) re-resolves every instance with no overrides and writes only six hard-coded keys (thickness, height, width, depth, sillHeight, frameThickness), so a type edit wipes instance overrides and never syncs elevation, offsetAlongHost or any other family parameter",
      "The six synced keys are a different set from GEOMETRY_KEYS in placement.ts, so the two modules disagree about which parameters are geometry",
      "A type-scope edit on an element with no type silently degrades to an instance write (applied: instance) instead of reporting that there is no type to edit",
      "The pure propagateTypeChange function re-resolves with overrides preserved, but nothing on the live path calls it and no browser proof exists that a type edit updates all instances while an instance edit updates only one",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-formula-engine",
    area: "Families",
    status: "limited",
    source: [
      "src/modules/families/formula-engine.ts",
      "src/modules/families/formula-dimensions.ts",
      "src/modules/families/constraint-graph.ts",
      "src/modules/families/safe-expr.ts",
    ],
    evidence: [
      "tests/formula-engine.test.cjs",
      "tests/dimensional-analysis.test.cjs",
      "tests/parametric-closure.test.cjs",
      "tests/parametric-wiring.test.cjs",
      "Dedicated formula-engine suite tests/formula-engine.test.cjs — 20 assertions: deterministic evaluation order (topo by dependency), = prefix, ternary/modulo/nested functions/units, scientific-notation literals (1e-7), safe-expr rejection, constraint solving order, and a dead-code gate keeping the retired enhanced engine deleted and unreferenced",
    ],
    limitations: [
      "Parameter scope is enforced fail-soft (9fa2e6a): a type value that targets an instance-scope or undeclared parameter is IGNORED with a warning, never fatal — family files from user sources cannot break a build, but silent data loss in a bad type entry is possible until the warning is surfaced in UI",
      "Formula errors inside one computed parameter mark that parameter failed and continue the batch; there is no per-family diagnostic report listing every failed formula across the seed library",
      "Dimensional analysis is enforced in evaluateParameters and in the typed evaluateFormula overload; the untyped one-off path (geometry NumberRef expressions via parametric-geometry's resolveNumber) still evaluates without dimensions, and a 'number'-typed target accepts any result dimension — the corpus declares section inertia (L^4) as number, so a number target cannot demand dimensionlessness",
      "Bare numeric literals are polymorphic: 'Width - 0.08' reads 0.08 as metres in the formula's implicit SI context; a literal carries no unit of its own, so a mistyped literal is not caught",
      "A dimensional parameter with no declared unit is read as SI (the repo's internal-storage convention), not rejected; only a unit string that names no unit of the parameter's type is rejected as unit-confusion",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-nested-arrays",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/families/nested-families.ts",
      "src/modules/families/array-expander.ts",
      "src/modules/families/parametric-engine.ts",
    ],
    evidence: [
      "tests/",
      "No test in tests/ references nested-families.ts or array-expander.ts, and there is no browser proof for either",
    ],
    limitations: [
      "Nested refs with param maps and the shared flag, and linear / rotational / grouped arrays, exist in code and are wired into buildExtendedGeometry, but no test proves a parent parameter change reaches a nested child, a shared nested instance schedules independently, or circular nesting is rejected",
      "The only composed / conditional / array geometry in the repo is the sample parametric door (seeded at boot, uses conditional not nested) and the single composed seed family (steel-beam-i: flange + web + flange)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-geometry-kinds",
    area: "Families",
    status: "experimental",
    source: [
      "src/modules/families/parametric-engine.ts",
      "src/modules/families/parametric-geometry.ts",
      "src/modules/families/sample-parametric-door.ts",
    ],
    evidence: [
      "tests/",
      "No test in tests/ exercises sweep, revolve, loft, void, array or conditional geometry; PARAMETRIC_ENGINE.md marks sweeps/revolves done, but that table describes the engine code existing, not a proven workflow",
    ],
    limitations: [
      "Void does not cut: the void case only marks userData.isVoid = true, and the composed case just adds children — no CSG call exists in either module — so a void is currently a visible solid",
      "Loft is an approximate stacked-slice extrusion between consecutive profiles; the code itself says full NURBS loft is future work",
      "No arc profile kind exists: ProfileSpec is rect / circle / polygon with fixed-number points, and a sweep path is a list of fixed points, so there is no way to author an arc-driven profile",
      "Sweep uses a CatmullRom path with ExtrudeGeometry and revolve uses LatheGeometry, but profile orientation and sweep behaviour are unproven by any test",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-library",
    area: "Families",
    status: "limited",
    source: [
      "src/modules/families/builtin-families.ts",
      "src/modules/families/library-loader.ts",
      "src/modules/families/store.ts",
      "public/families/index.json",
    ],
    evidence: [
      "tests/seed-families.test.cjs",
    ],
    limitations: [
      "10 built-in families (wall, slab, column, beam, door, window, duct, pipe, cable tray, conduit, equipment) plus a 56-family seed catalog in public/families/ (57 JSON files incl. the index); 55 of the 56 seed families are a single box and 1 is composed — there is no loadable family library comparable to Revit's",
      "The built-ins carry the formula-engine data bugs: pipe formulas reference an undeclared diameter and slab types set an undeclared thickness",
      "The seed-families type check reads t.parameters while the real schema uses t.values, so that particular assertion is vacuous",
      "No sync exists between a type catalog and a family: importing a catalog does not create or update family types, and no family exports its types as a catalog",
      "No family versioning or migration beyond schemaVersion 1 with no migrator",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "family-type-catalogs-shared-params",
    area: "Families",
    status: "limited",
    source: [
      "src/modules/families/type-catalog.ts",
      "src/modules/families/shared-parameters.ts",
    ],
    evidence: [
      "tests/shared-parameters.test.mjs",
    ],
    limitations: [
      "Type catalogs parse and serialize ##TYPE CSV with typed headers, quoted fields and validation, but no sync exists between a catalog and a family: importing a catalog does not create or update family types",
      "The shared-parameters manager is storage-only with no in-memory cache, so with a null storage handle writes are silently dropped and every read returns empty",
      "No shared-parameter .txt file import (Revit's format) exists",
      "The shared-parameters test file has no npm script and no CI entry (test:shared-parameters does not exist in package.json and it is not in scripts/ci-unit-tests.mjs), so its failures are not gated",
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
      "In-browser conversion/link ceiling raised to 550 MB (was 350): browserSafeMaxMB defaults to 550 so IFC files up to 550 MB convert and link without the unsafe flag — existing installs migrate off the old 350 default, settings copy and docs/engineering/IFC_IMPORT_TIMEOUT.md state the real number; the hard skip limit stays 1500 MB and 11-assertion suite tests/ifc-link-limits.test.cjs pins defaults, migrations, copy and gate wiring",
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
    id: "review-links",
    area: "Collaboration",
    status: "limited",
    source: ["src/modules/review/review-links.ts", "src/modules/review/review-links-core.ts", "src/modules/review/review-state.ts"],
    evidence: [
      "tests/review-links.test.ts",
      "7 assertions in tests/review-links.test.ts: link building (https model URL, encoding, non-http rejection), ?review parsing (URL, bare, absent), read-only tool sets per surface",
      "Browser chain spec tests/e2e/review-links.spec.ts — the full loop in real Chromium against the PRODUCTION vite preview bundle: author page authors a wall and snapshots the model (the exact bytes the Save-to-file command writes, read through the review feature's snapshot — a headless browser cannot drive the native file picker that command opens); a static server hosts the .obsproj; a second browser opens the review link and the wall is in the scene with the review banner visible; activating the wall tool and createElementByType in review mode are both refused and the model is unchanged; the reviewer selects the wall, creates an issue, and exports the review as BCF; the downloaded .bcfzip re-parses (JSZip) to one topic carrying the title, author, viewpoint camera and snapshot; the author page imports that .bcfzip and the issue appears with its viewpoint",
    ],
    limitations: [
      "The author hosts the .obsproj file — the app is the viewer, not the host. The host must serve the file over https when the app is https (mixed content is blocked) and must allow cross-origin reads (CORS) unless the file is served from the app's own origin",
      "The return path is a file: the reviewer downloads the .bcfzip and sends it back. There is no live sync — that is the share-links item",
      "Review mode gates the tool setters and the create/delete/transform choke points; it is view-only enforcement, not a sandbox — a reviewer with devtools open can poke the in-memory model, and saving in review mode writes the reviewer's own local copy only, never the author's",
      "Encrypted projects cannot be reviewed from a link — the link fails closed with a plain message; the reviewer must open the file in the app with its password instead",
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
    id: "open-audit",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/audit/open-audit.ts", "src/modules/audit/open-audit-core.ts"],
    evidence: ["tests/open-audit.test.ts", "tests/e2e/open-audit.spec.ts"],
    limitations: [
      "IDS runs over imported IFC models only (runIdsValidation reads ctx.fragments); authored elements are not covered and the report says so instead of passing them",
      "Property facets fail when a required property is absent from a readable model; they report unverifiable only when the model cannot expose properties at all — unverifiable checks are listed, never issued as BCF topics",
      "Clash always runs all-vs-all with the live rules; saved clash scenarios are not honoured by the audit pass",
      "One BCF 2.1 topic per clash and per failed IDS check (no clustering into one topic per group); BCF 3.0 write side not implemented",
      "The audit's BCF has no viewpoint camera or snapshot (topics carry component references only)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "sheets-views-pdf",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/views/", "src/modules/export/pdf.ts", "src/modules/export/sheet-pdf.ts", "src/features/sheets-2d-panel.ts"],
    evidence: ["tests/", "real browser: + Sheet → + Viewport renders the authored plan into the viewport; Export SVG issues a real download (A-001.svg); 'Place on sheet' from the Schedules panel lands on sheet A-001", "real browser (v54 re-run): saved Wall Schedule E2E → 'Placed ... on sheet A-001' → Export SVG (9.9 KB) + Export PDF (PDF 1.7) both contain the full 4-row table (Wall 001–004, grand totals 264.793 m / 1588.758 m² / 202.566 m³) — PDF text-extraction verified", "browser chain spec (document-chain.spec.ts, production bundle): Sheets panel '+ Sheet' creates a sheet row, and Export IFC4 from the File tab downloads a real 7,694-byte ISO-10303-21 STEP file of the authored model", "real browser (revit-8, tests/e2e/revit-8-documentation.spec.ts): exported sheet PDF (10,408 bytes, 1 page A1) opened in a real reader — poppler pdfinfo reports 1 page, pdftotext extracts 'Level 0 Plan (+0.00 m)', the 'Wall 001' tag, the revision table row 'Rev 01 / 2026-11-21 / Rev8: relocate door D-101 / AM' and 'Drawn: — Scale: 1:100'; pdftoppm renders page 1 at 100 dpi (3312×2339) with 42,767 drawn pixels including 730 reddish revision-cloud pixels"],
    limitations: [
      "Sheet composition covers the v M3 scope; not a full drawing-sheet editor",
      "Viewport fit is extent-based, not content-tight — an 18 m wall renders small on a 40 × 28 m default window",
      "The panel was invisible behind the Floor Plan (z=36 vs 200) and 'Toggle Sheets' dead (unregistered service key) — both fixed",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "view-templates-vg",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/view-templates/", "src/modules/visibility/visibility-filter.ts", "src/modules/drawings/plan-generator.ts", "src/modules/views/generators/plan.ts", "src/features/views-panel.ts", "src/modules/documentation/documentation-persistence.ts"],
    evidence: [
      "tests/view-templates.test.cjs",
      "real browser (revit-8, tests/e2e/revit-8-documentation.spec.ts): applying the built-in 'Structural Plan' template to the Level 0 Plan hides the duct (effective VG Ducts.visible false) and halftones the wall (Walls.halftone true) — the wall poché fill fades from 1002 to 247 pixels on clean paper (556 to 151 in an 80×80 box on the wall), and the plan SVG census goes from 9 dark cut strokes / 0 halftone strokes / 0 fills at 0.35 opacity to 0 dark / 5 halftone strokes / 1 fill at 0.35 opacity",
      "Views-panel template dropdown now writes the store binding and syncs the 3D visibility filter (previously it only set ViewDef.templateId and visibly did nothing); VG dialog saves re-render the current view via obs:vg-changed; the dropdown is populated on first open (it was empty until a view row was clicked — currentViewId was defaulted after the population block); window.__obsViewTemplates now points at the persisted seeded store — boot used to overwrite it with the legacy ViewTemplatesService (src/modules/view-templates/index.ts), a second, empty, unseeded template system with no getEffectiveVg, so every global consumer saw zero templates",
    ],
    limitations: [
      "ViewFilterRule evaluation is not wired at render time — only category visibility, halftone, showModel and showAnnotations are applied",
      "lineColor/surfaceColor overrides are stored but not applied at render time",
      "Linked-IFC fragments are not VG-filtered in the plan generator; section/elevation generators are not VG-wired",
      "The main plan canvas does not apply view templates — VG rendering is proven in the Views-panel plan, sheet SVG and sheet PDF",
      "At fit-to-window zoom the 0.15 pt halftone outline is sub-pixel: the visible halftone effect is the poché fill fading to 0.35 opacity, not a #9ca3af line — the outline only becomes a visible line when zoomed in",
      "The legacy ViewTemplatesService (src/modules/view-templates/index.ts) still exists as a second, empty, unseeded template system; nothing in the app consumes it — it should be deleted or merged into the store",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "revisions-clouds",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/revisions/", "src/features/revision-cloud.ts", "src/modules/export/sheet-pdf.ts", "src/modules/sheets/sheet-composer.ts", "src/modules/documentation/documentation-persistence.ts"],
    evidence: [
      "tests/revisions.test.cjs",
      "real browser (revit-8, tests/e2e/revit-8-documentation.spec.ts): a revision record + cloud placed through ctx.features.revisions renders red on the plan (reddish pixels 0 → 201) and lands in the exported sheet PDF — poppler pdftotext extracts the revision table row 'Rev 01 / 2026-11-21 / Rev8: relocate door D-101 / AM' and the rendered PDF page carries 730 reddish cloud pixels",
      "The two parallel revision stores (obs.revisions.v1 panel store vs obs.revisions.records.v2 model store) are unified: the panel layer now delegates to modules/revisions/model.ts with a one-time v1→v2 migration; renderCloudsSvg and injectRevisionTableIntoSvg finally have callers (plan annotation layer, sheet SVG composer, sheet PDF)",
    ],
    limitations: [
      "Revision clouds render in the Views-panel plan, sheet SVG and sheet PDF — not on the main plan canvas",
      "Keynotes (src/modules/keynotes/) remain a module with no registry entry, no tests and no browser proof — recorded as remaining work",
      "Phases and design options have panels and their predicates feed the plan VG resolver, but no dedicated browser proof or workflow work was done in this rank",
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
    source: ["server/index.mjs", "server/central-model.mjs", "server/central-store.mjs", "src/modules/collaboration/central-client.ts", "src/modules/collaboration/central-binding.ts", "src/modules/collaboration/authoring-adapter.ts", "src/modules/collaboration/edit-guard.ts", "src/modules/collaboration/central-binding-setup.ts", "src/modules/collaboration/realtime-client.ts"],
    evidence: ["tests/central-model.test.cjs", "tests/central-sync.test.cjs", "tests/central-binding.test.cjs", "tests/e2e/central-worksharing.spec.ts", "tests/server-hardening.test.cjs", "tests/server-security.test.cjs"],
    limitations: [
      "Central sync is server-authoritative with a durable fsynced journal, field-level three-way merge, borrowing, roles, history/restore and an audit trail (two real clients against a real server, incl. restart recovery), bound to the live authoring model: local edits push to the room, remote edits materialise/apply locally, borrows and workset ownership refuse edits in the authoring path with a named reason, and a two-user Chromium E2E drives join → propagate → borrow-refuse → offline conflict → panel resolve (tests/central-binding.test.cjs 13 passed, tests/e2e/central-worksharing.spec.ts)",
      "Only an explicit field set syncs (18 keys: scalar params, plan geometry, level constraints); sweeps, hosted-opening cuts, properties, families and anything outside the set stays local-only, and a remote field the local project cannot apply is pinned, never echoed back",
      "Roles are enforced at the API for the claimed clientId, but identity is a single shared OBS_SERVER_TOKEN, so roles are a coordination discipline for a trusted team, not an access-control boundary against mutually untrusted users",
      "The local WorksharingEngine (src/modules/collaboration/worksharing-engine.ts) is in-memory only: its syncWithCentral moves transactions between local arrays and never talks to the server; the durable path is server/central-model.mjs + central-client.ts + central-binding.ts",
      "yjs and y-websocket are declared dependencies but are imported nowhere in src/ or server/ — no CRDT is in use and none is claimed; the consistency model is server-sequenced deterministic merge (see docs/engineering/COLLABORATION_SYNC.md)",
      "Persistence is whole-file JSON snapshots plus an append-only journal (last 500 entries retained); clients behind the window re-sync from full state",
      "Small-team scope only: single Node process, whole-state snapshots, no load test — Revit-scale worksharing (hundreds of users, enterprise permissions/audit) is out of reach for this run",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "share-links",
    area: "Platform",
    status: "limited",
    source: ["server/index.mjs", "server/share-tokens.mjs", "src/modules/collaboration/share-links.ts", "src/modules/collaboration/share-session.ts", "src/modules/collaboration/realtime-client.ts"],
    evidence: ["tests/share-links.test.cjs", "tests/e2e/share-link.spec.ts"],
    limitations: [
      "Live updates are snapshot-based: the newest published version wins; concurrent edits to the same model are last-publish-wins, not merged — there is no CRDT here",
      "A share link works wherever the collab server is reachable from the joiner's browser; on localhost it is localhost-only — a public link needs the collab server on a public URL with a strong token and an origin allow-list",
      "In tokenless loopback mode the signing secret is ephemeral per process, so shares do not survive a server restart",
      "Sharing an encrypted project requires the joiner to know the project password",
      "View-only is enforced server-side; the client mirrors it with a banner and disabled tools",
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
    id: "ai-modelling",
    area: "Platform",
    status: "limited",
    source: ["src/modules/nl-model/parse.ts", "src/modules/nl-model/plan.ts", "src/modules/nl-model/execute.ts", "src/modules/bim-gaps/critical-workflow-pack-8.ts", "src/features/ai-tools.ts", "src/modules/nl-query/executor.ts"],
    evidence: ["tests/nl-model.test.ts", "tests/nl-query-authored.test.ts", "tests/critical-workflow-pack-8.test.cjs", "tests/ai-native-modeling.test.cjs", "tests/e2e/ai-models.spec.ts"],
    limitations: [
      "Natural-language modelling is keyless and local, but the room grammar is small: one rectangular room per sentence, doors on the south wall, windows filling north/east/west; anything outside the grammar is refused, not guessed.",
      "The cloud AI chat that can call create_room still needs the user's own provider API key (see ai-assistant); only the words-to-model path itself needs no key.",
      "NL query over authored elements maps live params (Height/Width/Length) — IFC property criteria (FireRating, Material, LoadBearing) still need real IFC properties and stay soft-matched when absent.",
      "The generative grid study scores five spacings deterministically (best 7.5 m on the fixture); it does not drive the evolutionary engine in generative-design.ts (runGridSpacingStudy passes it a mismatched config, so the engine throws and the inline scoring runs instead), and it does not lay out rooms — there is no generative room-layout study yet.",
      "Packs 5 and 8 are wired into main.ts boot by this change — before it, setupBimGaps() was never invoked anywhere (docs/engineering/BASELINE.md:83), so runNlQuery, runNlModel and the grid study existed only in node tests, not in the shipped app. Packs 1–4, 6, 7, 9, 10 and the rest of setupBimGaps are still unwired.",
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
    id: "model-history",
    area: "Platform",
    status: "limited",
    source: ["src/modules/history/model-timeline.ts", "src/modules/history/model-timeline-core.ts", "src/modules/projects/project-journal.ts"],
    evidence: ["tests/model-timeline.test.ts", "tests/e2e/model-timeline.spec.ts"],
    limitations: [
      "Versions are the last 10 journal checkpoints (saves, autosaves every 25 s while dirty, model imports, restores) plus manual versions — history.ts itself is undo/redo only, not a version store",
      "A checkpoint records the state BEFORE the save/import/restore, so the newest version is always one step behind the live state; the live state itself is shown as the 'Current' row, not a version",
      "Restoring clears the undo/redo stacks (a project transition); the current state is kept as a version first, so a restore is reversible",
      "Diffs compare element records by id and content only — a moved element with identical parameters shows as unchanged",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "pwa-offline",
    area: "Platform",
    status: "limited",
    source: ["public/sw.js", "vite.config.ts"],
    evidence: ["tests/service-worker.test.cjs", "tests/e2e/offline-first.spec.ts"],
    limitations: [
      "Offline load / model / save / reload and a second IFC import after a rebuild are E2E-proven (offline-first.spec.ts), but only against the locally served production build — the hosted deploy is not part of the proof",
      "Versioned web-ifc WASM lives in a version-keyed cache (obs-webifc-<version>) and survives app rebuilds; a pin move still fetches the new WASM once, and the FIRST IFC import must happen online (the WASM is fetched on demand, not precached)",
      "Install-prompt UX and OS file launch (.obsproj/.ifc double-click) are implemented but not covered by the offline E2E",
      "Icon loading is offline: the mdi set used by the shell and the vendor UI ships as a local collection registered at boot (src/features/iconify-offline.ts) — no third-party icon CDN is contacted at runtime",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "publish-web",
    area: "Platform",
    status: "limited",
    source: ["src/modules/publish/publish-web.ts", "src/modules/publish/publish-web-core.ts", "vite.config.ts"],
    evidence: ["tests/publish-web.test.ts", "tests/e2e/publish-web.spec.ts"],
    limitations: [
      "A published page is a frozen snapshot, not a live model — edits made in it are local-only and are replaced by the published model on the next load (a backup is kept by the app's recovery)",
      "Publish runs from the app's own production build; in dev (no asset-list.json) it refuses rather than building a broken page",
      "Encrypted projects cannot be published — publish needs an unencrypted snapshot",
      "The published page registers no service worker, so it is not installable/offline beyond the browser cache",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "performance-budgets",
    area: "Platform",
    status: "limited",
    source: ["bench/check-budgets.mjs", "scripts/budget.json"],
    evidence: ["bench/BENCHMARKS.md §9", "docs/engineering/BASELINE.md §5"],
    limitations: ["Only the bundle budget is enforced in CI on main; import/parse budgets are measured but not gated until item 11 lands (branch fix/perf-budgets-fail-on-missing, unmerged)", "Largest tested fixture is 2,036 elements / 2.4 MB; the 20,398-element scale target (bench/BENCHMARKS.md §9) is UNMEASURED on real hardware"],
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
      "real browser (revit-8, tests/e2e/revit-8-documentation.spec.ts): category tag created with the Views-panel Tag tool renders its teal symbol + text on the plan SVG — greenish anti-aliased blends rise from 2 to 205 pixels (no pixel is pure #0f766e: the 8 px paper-scaled text is fully anti-aliased); the tool's default offset was fixed from 150 mm paper (15 m world at 1:100, outside every documentation viewport) to 10 mm paper",
      "four breaks found by the same browser pass and fixed: plan footer status was wiped by every re-render (multi-pick prompts like 'Click to place the dimension line' disappeared instantly), the Annotate ▸ Section Line tool accepted canvas clicks only in the Views panel preview (the main plan canvas never forwarded picks), the section-line state machine gated every pick behind a model-reference hit (an empty model could never produce a section), and the plan footer/status strings carried U+FFFD tofu from a historical byte corruption (795 occurrences across the plan panel and all 9 i18n catalogs, restored to house-style separators)",
    ],
    limitations: [
      "Dimension text is paper-scaled (2.5 mm at 1:100 = 0.25 m world) and therefore tiny at fit-to-window zoom; it grows when zooming in but has no minimum on-screen size",
      "The section cut line is stored on the created view but is not yet drawn as a section marker in the plan; opening the section view routes through the Views panel",
      "Tags render in the Views-panel plan (proven); the dimension default offset is still 400 mm paper — new dimensions land far from the element at small scales in the Views panel and on sheets (the tag offset was fixed from 150 mm to 10 mm in this rank)",
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
      "Unit suite tests/mep-connectivity-index.test.cjs — 31 assertions: grid-indexed connectedPairs equal the brute-force O(n²) scan on seeded random models (5 seeds × 5 sizes, dense cluster, oversize 600 m run), expandConnected/connectedSelection match brute-force BFS, 1,500-element sparse model indexes in ~47 ms",
      "Unit suite tests/mep-ifc-reconstruction.test.cjs — 10 assertions: duct/pipe port-graph chains round-trip to one cluster, dangling/ownerless/self port connections are diagnostics, port-less files report unconnected, mixed-domain clusters suggest no system",
      "Unit suite tests/mep-protection-coordination.test.cjs — 14 assertions: selectivity likely (2×) vs not-demonstrated (1.26×) vs invalid (upstream ≤ downstream), Icu/Ics vs fault current, chain and panel-link audits, missing ratings never silently pass",
      "Unit suite tests/mep-calculation-basis.test.cjs — 5 assertions: every calculation area discloses method/standard/units/assumptions/limitations; exactly one area (duct-pressure) is validated beyond unit tests, against published ASHRAE chart values; no record claims code compliance",
      "Unit suite tests/mep-stored-connectors.test.cjs — 17 assertions: run ports derived from geometry (bidirectional), coincident ports adopted into stored port-to-port edges, run-end-on-body adopts nothing and is not connected in the tree, stored edges survive a JSON save/reload round-trip through the lifecycle snapshot, named-system identity across an edit via stored edges, mixed-system conflict through the stored-edge path, legacy pure-geometry fallback without a connection list",
      "Unit suite tests/mep-code-reference-checks.test.cjs — 6 assertions: production duct calc reproduces published ASHRAE friction-chart values at three points (−1.6% / −7.9% within ±10%, +0.6% within ±2% hand-worked), Colebrook solver matches an independent hand iteration to <1%, exactly one jurisdiction, no compliance claim",
      "System-tree unit suite tests/mep-system-tree.test.cjs — 27 assertions (see mep-system-browser)",
    ],
    limitations: [
      "Connectivity is stored for plain runs once adopted: each linear run derives two stored ports (start/end, bidirectional) and coincident ports become stored port-to-port edges in the lifecycle, persisted in the project snapshot; the system tree treats stored edges as authoritative for run↔run pairs, and a run whose end lands on another run's body gets no edge (reported as an unadopted contact) instead of counting as connected. Fittings carry no derived ports and equipment stays a geometry terminal, so pairs involving them still connect geometrically; flow assignment, network audit, move-spreading and tab-selection still use geometry pairs. The pairwise pass is grid-indexed (connectedPairs — exactly the old O(n²) scan, pruned), not O(n²) per recompute",
      "A connected cluster mixing two or more declared properties.system values is REJECTED as a system conflict (system null, diagnostic naming the members) — majority-vote acceptance was removed. Undeclared members still fall back to per-type defaults (duct → supply-air, pipe → domestic-cold)",
      "Sizing, pressure and load methods follow generic velocity/friction and ASHRAE-style table practice — not region-specific codes; electrical now includes breaker selectivity screening (1.6× rule of thumb, manufacturer curves govern) and breaking-capacity checks against caller-supplied fault currents, but still covers calculations rather than physical circuit wiring or manufacturer-curve coordination",
      "Imported IFC MEP connectivity is reconstructed at the semantic layer from IfcRelConnectsPorts/IfcRelNests where the file carries ports; files without ports report unconnected, and the live fragment-based System Browser still groups imported IFC by category (reconstruction is not yet wired into it)",
      "No MEP calculation is validated against a reference implementation, a code, or measured data for any jurisdiction, except duct friction: the production duct calc reproduces published ASHRAE friction-chart values (Fundamentals Ch. 21, Fig. 12) at three points within stated bands — every other area is unit-tested-only (see src/modules/mep/calculation-basis.ts); no code compliance is claimed anywhere",
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
      "src/modules/mep/stored-connectors.ts",
    ],
    evidence: [
      "System-tree unit suite tests/mep-system-tree.test.cjs — 27 assertions: elbow- and tee-joined clusters form ONE named system, equipment heads the member list, declared-system conflicts are REJECTED (no majority vote, incl. a 3-to-1 majority), invalid system values ignored, unconnected singletons, non-MEP exclusion, per-system numbering by first appearance, fitting-only clusters via parentType, cable-tray/conduit labels, determinism, unique cluster ids, empty-tree shape, plus 8 registry tests (names survive recompute/reload via stamped properties, no renumbering on add/remove, merge keeps earliest name with a diagnostic, re-classification invalidates the old stamp, conflicts get no persistent identity)",
      "Stored-connector suite tests/mep-stored-connectors.test.cjs — 17 assertions: the tree over stored edges keeps end-to-end runs as one system while a run end on another run's body is a singleton with an unadopted-contact diagnostic, fitting-joined runs still join geometrically with an empty connection list, named-system identity survives a model edit through the stored-edge path, and mixed-system clusters are conflicts through stored edges",
      "Panel v2 ships the tree: 'Model systems' built from stored connections (click a system selects all members via setSelectedAuthored, expandable per-member rows, unconnected flagged), conflict clusters render red with their diagnostic and are counted in the summary, unadopted contacts are counted in the summary, and an honest 'Imported (IFC)' category section",
    ],
    limitations: [
      "The real-system tree covers authored MEP elements; imported IFC elements stay grouped by IFC category in the fragment browser (port-graph reconstruction exists at the semantic layer — src/modules/mep/ifc-reconstruction.ts — but is not wired into the live fragment browser)",
      "Tree interaction (expand, member click, selection) is proven at the data layer in Node; the panel itself has not been driven in a browser session",
      "System names are persisted via mepSystemId/mepSystemName stamps on member properties (survive refreshes and project reloads); a name is only as durable as the next project save, and clusters that become conflicts lose their persistent identity until fixed",
      "Run↔run connectivity in the tree comes from stored edges once adopted; a run end on another run's body is NOT a connection there (reported as an unadopted contact), and fittings/equipment still connect geometrically",
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
