# File Import Boundary Inventory

Issue #90 — complete file-import security. Base: `main` @ `eabab92`
(2026-11-21). Branch: `fix/revit-3-safeload` (Revit parity rank 3).

This branch rebases the `fix/file-import-boundaries` inventory (base
`e8e5afb`) and the `fix/safeload-markups-audit` (item 3) and
`fix/las-guard-full-buffer` (item LAS) branches onto `eabab92`, and adds
the remaining rank-3 work: prototype-pollution hardening in safeLoad,
DWG/clash worker message + reply validation, and the runtime browser
proof that a failed load leaves the project unchanged. Boundaries B1–B36
are the import90 inventory; B37 is new in this branch.

This is the authoritative inventory of every untrusted input boundary in
openBIMstudio: every place a file, archive, URL response, worker message or
server upload can reach application state. Each boundary lists its entry
point (file + line, verified against this branch), what validates it, the
size and complexity limits, the parser, the isolation strategy, the error
behaviour, and the regression test that proves it.

Status legend:

- **Guarded + tested** — validation runs before parsing, and a regression
  test proves the rejection (or the guard-before-parse ordering).
- **Guarded, ordering-proven** — validation runs before parsing; the proof
  is a static ordering assertion in `tests/file-import-boundaries.test.cjs`
  (source-index check), not a runtime browser test.
- **Pre-existing, unchanged** — the boundary was already guarded by PR #240
  (`src/core/file-guard.ts`) or the safeLoad work; re-verified here, not
  changed by this PR.
- **Pending elsewhere** — fixed on another branch that is not merged yet;
  named here so it is not silently assumed done.
- **No test evidence** — inventoried honestly; see "Boundaries without test
  evidence" at the end.

## The shared validated loading pipeline

There is one pipeline, not two. Every boundary below routes through it:

1. **Size bound first, from metadata, before any read.**
   `guardSize(kind, file.size)` / `assertFileAllowed(kind, name, size, head?)`
   in `src/core/file-guard.ts`. `FILE_LIMITS` holds the per-format ceiling.
   `readHead(file, n)` reads only the first bytes for a magic check, so the
   signature is verified without buffering the file.
2. **Content guard before the parser.** Format-specific checks in the same
   module: `guardSignature` (magic bytes), `guardZipDirectory` (ZIP central
   directory audit without inflating: entry count, declared sizes,
   compression ratio, unsafe paths, ZIP64 rejected), `guardXmlText` (no
   `<!ENTITY`, no inline DOCTYPE subset), `guardLasHeader`.
3. **JSON through `safeLoad`** (`src/core/safeLoad.ts`): byte limit, then
   `JSON.parse`, then an *iterative* depth/node walk (no recursion, so deep
   nesting cannot overflow the stack), then a zod schema. Result is a typed
   `{ ok, error: { stage, issues } }` — never a throw into state.
4. **STEP preflight before the WASM parser.**
   `preflightStep` (`src/modules/ifc-semantics/step-preflight.ts`) bounds
   the STEP structure before web-ifc runs (issue #231: web-ifc hangs on an
   unterminated string).
5. **Failure is fail-closed and state-preserving.** Guards throw
   `FileGuardError` ("… The file was not opened and your project is
   unchanged."); safeLoad returns a typed rejection. Callers invoke the
   guard before any state write, so a rejected file cannot partially corrupt
   the active project. Error messages name the file and the limit, and do
   not expose internals (no stack traces, no paths, no token material).

Per-format size ceilings (`FILE_LIMITS`, `src/core/file-guard.ts`):

| Kind | Limit | Kind | Limit |
|---|---|---|---|
| ifc | 1.5 GB | frag | 1.5 GB |
| dxf | 512 MB | geojson | 20 MB |
| dwg | 256 MB | shapefile | 256 MB |
| bcf | 256 MB | mesh | 200 MB |
| pdf | 200 MB | solid | 200 MB |
| ids | 5 MB | landxml | 5 MB |
| standards-pack | 5 MB | factors | 5 MB |
| point-cloud | 2 GB | type-catalog | 5 MB |

## Boundaries

### B1 — IFC (.ifc), queued import

- **Entry point:** `src/features/importer.ts:1194-1201` (`enqueueIfc` task),
  `src/features/importer.ts:1540` (`convertIfcToFragBytes`).
- **File type:** IFC (STEP Part 21, `ISO-10303-21`).
- **Validation:** `assertFileAllowed("ifc", name, file.size)` *before*
  `file.arrayBuffer()` (added by this PR; the post-read assert stays as
  defence in depth), then `preflightStep(bytes)` before web-ifc. Browser-safe
  limit (`ifcSettings.browserSafeMaxMB`) and hard limit
  (`ifcSettings.maxSizeMB`) are checked before the read.
- **Size limit:** 1.5 GB guard; browser-safe limit lower by settings.
- **Complexity limit:** STEP preflight (bounded structural check).
- **Parser:** web-ifc WASM, in a worker (`getImporter().process`).
- **Isolation:** worker; FRAG cache hit returns before parsing (the file
  was validated when first converted).
- **Error behaviour:** `FileGuardError` / preflight error; task marked
  failed, project untouched.
- **Regression test:** `tests/file-guard.test.cjs` (guard + ordering),
  `tests/step-preflight.test.cjs`, `tests/file-import-boundaries.test.cjs`
  (ordering: guard + preflight before WASM).
- **Status:** Guarded + tested. The `convertIfcToFragBytes` path previously
  had *no* guard or preflight — closed by this PR.

### B2 — IFCZIP / ZIP archives (.ifczip, .zip containing .ifc)

- **Entry point:** `src/features/importer.ts:854` (`expandIfcSources`),
  `src/features/file-interop.ts:241` (universal-importer ZIP branch).
- **File type:** ZIP archive containing `.ifc` entries.
- **Validation:** `guardSize("ifc", file.size)` before the read (added by
  this PR to `expandIfcSources`; the universal-importer branch had *no*
  guard at all and is now guarded identically), then
  `guardZipDirectory(bytes)` before JSZip inflates anything.
- **Size limit:** 1.5 GB archive; ZIP audit: 20,000 entries, 1 GB/entry,
  3 GB total extracted, ratio 1000, ZIP64 rejected.
- **Complexity limit:** entry count + total extracted size + ratio.
- **Parser:** JSZip (`loadAsync`), then the B1 IFC path per entry.
- **Isolation:** main thread for the audit (no inflation); entries are
  extracted one at a time and each extracted `.ifc` is re-checked against
  the 1.5 GB limit before it is handed to `loadIfcFiles`.
- **Error behaviour:** `Failed to unpack "name": <reason>`; nothing is
  imported.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (crafted
  archives: valid, zip-bomb ratio, `../` traversal, absolute and
  drive-letter paths, 20,001 entries, truncated, lying stored entry).
- **Status:** Guarded + tested. Residual: `guardZipDirectory` trusts the
  central directory's declared sizes; a lying *local* header is bounded by
  the archive file size itself, and JSZip verifies CRCs on inflate.

### B3 — FRAG cache files (.frag)

- **Entry point:** `src/features/importer.ts:1437` (`loadFragFiles`).
- **File type:** FRAG binary (thatopen fragments cache).
- **Validation:** `assertFileAllowed("frag", name, file.size)` before the
  read (added by this PR); empty files rejected; a 0-drawable model is
  disposed again after load.
- **Size limit:** 1.5 GB.
- **Complexity limit:** none beyond the parser (see residual).
- **Parser:** fragments core (`ctx.fragments.core.load`).
- **Isolation:** main thread (fragments API); render loop paused during load.
- **Error behaviour:** alert + skip; model id is unregistered on failure.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (ordering;
  limit behaviour via `guardSize("frag", …)`).
- **Status:** Guarded, ordering-proven. Residual: FRAG has no public magic
  to check, so content validation is the parser's own; a corrupt FRAG is
  rejected by the loader, not by a pre-parse check.

### B4 — STEP / IGES / BREP / Rhino 3DM (solid models)

- **Entry point:** `src/features/file-interop.ts:308`,
  `src/features/solid-import.ts:173` (`openSolid`).
- **File type:** STEP, IGES, BREP, `.3dm`.
- **Validation:** `guardSize("solid", file.size)` before the read (added by
  this PR); `openSolid` re-checks `buf.byteLength > MAX_BYTES` (200 MB);
  `solid-core` header checks (`looksLikeStep`, `looksLikeIges`,
  `has3dmHeader`).
- **Size limit:** 200 MB.
- **Complexity limit:** reader-worker 180 s parse timeout; triangle
  buffers are transferred, not copied.
- **Parser:** occt-import-js / rhino3dm WASM.
- **Isolation:** dedicated reader worker (`solid-reader-worker.ts`) with a
  scoped CSP (the emscripten glue needs dynamic execution the main document
  forbids). Worker messages are validated: `id` number, `kind` occt/rhino,
  `bytes` an `ArrayBuffer` of 1..200 MB (added by this PR); anything else
  gets a typed `invalid-file` failure instead of hanging the 180 s timeout.
- **Error behaviour:** typed `SolidReaderErrorCode`
  (`init-failed` / `invalid-file` / `parse-failed` / `internal`); object is
  `null`, message is shown.
- **Regression test:** `tests/solid-reader-isolation.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (ordering + worker validation).
- **Status:** Guarded + tested.

### B5 — DWG (.dwg, .bak, .sv$)

- **Entry point:** `src/modules/cad-link/index.ts:185` (`readDwg`),
  `:220` (`readDwgThumbnail`), `:249` (`readCadFile`).
- **File type:** DWG (AC10xx).
- **Validation:** `assertFileAllowed("dwg", name, size, head)` with the
  first 32 bytes (`AC10xx` signature) before the read.
- **Size limit:** 256 MB.
- **Complexity limit:** reader-internal; see residual.
- **Parser:** LibreDWG (optional fallback reader, loaded same-origin) or
  the built-in engine; runs in `dwg-reader-worker.ts`.
- **Isolation:** reader worker (`src/modules/cad-link/index.ts:133`).
- **Error behaviour:** `DwgParseError` with a code; the CAD link is not
  created; `.bak`/`.sv$` are treated as DWG recovery files.
- **Regression test:** `tests/file-guard.test.cjs` (signature + ordering),
  `tests/dwg-reader-isolation.test.cjs`, `tests/dwg-worker-lifecycle.test.cjs`,
  `tests/cad-link.test.cjs`.
- **Status:** Pre-existing, unchanged (PR #240).

### B6 — DXF (.dxf)

- **Entry point:** `src/modules/cad-link/index.ts:260` (`readCadFile`),
  `src/modules/drawings/dxf-reader.ts:927` (`readDxf`).
- **File type:** DXF (ASCII or binary).
- **Validation:** `assertFileAllowed("dxf", name, size, head)` with 256
  bytes (`0/SECTION` or `AutoCAD Binary DXF` signature) before the read.
- **Size limit:** 512 MB.
- **Complexity limit:** parser-internal entity/section handling.
- **Parser:** in-repo DXF reader (`parseDxf`).
- **Isolation:** main thread (pure parser, no eval).
- **Error behaviour:** throw with a user-facing message; CAD link not created.
- **Regression test:** `tests/file-guard.test.cjs`,
  `tests/dxf-features.test.cjs`, `tests/dxf-independent-validation.test.cjs`.
- **Status:** Pre-existing, unchanged (PR #240).

### B7 — BCF (.bcf, ZIP of markup + viewpoints)

- **Entry point:** `src/modules/issues/bcf.ts:416` (`importBCF`).
- **File type:** BCF (ZIP archive).
- **Validation:** file size checked first (`MAX_BCF_BYTES` = 64 MB), then
  `assertFileAllowed("bcf", …)` with the `PK` signature (256 MB guard),
  then `guardZipDirectory`, then `validateBcfArchive` (markup/schema checks).
  Topic count capped at `MAX_BCF_ENTRIES` (1,000).
- **Size limit:** 64 MB effective (pre-check); 256 MB guard.
- **Complexity limit:** topic-file count; ZIP audit limits (B2).
- **Parser:** JSZip + `validateBcfArchive`.
- **Isolation:** main thread; import builds a new issue list and only
  replaces state after validation.
- **Error behaviour:** throw with "The file was not imported and your
  issues are unchanged."
- **Regression test:** `tests/file-guard.test.cjs`, `tests/bcf21-roundtrip.test.cjs`.
- **Status:** Pre-existing, unchanged (PR #240).

### B8 — IDS (.ids, XML)

- **Entry point:** `src/features/ids-panel.ts:248` (file input).
- **File type:** IDS XML.
- **Validation:** `assertFileAllowed("ids", …)` before the read, then
  `guardXmlText` (no `<!ENTITY`, no inline DOCTYPE subset — blocks
  entity-expansion bombs and XXE) before `parseIdsXml`.
- **Size limit:** 5 MB.
- **Complexity limit:** XML entity ban; parser is DOM-based.
- **Parser:** `parseIdsXml` (DOMParser).
- **Isolation:** main thread; `currentDoc` is only replaced after a
  successful parse.
- **Error behaviour:** panel shows "Could not parse IDS: …" (HTML-escaped).
- **Regression test:** `tests/file-guard.test.cjs` (XML guard + ordering).
- **Status:** Pre-existing, unchanged (PR #240).

### B9 — PDF underlay (.pdf)

- **Entry point:** `src/modules/pdf-underlay/pdf-underlay.ts:53`
  (`loadPdfUnderlay`).
- **File type:** PDF.
- **Validation:** `assertFileAllowed("pdf", …)` with the `%PDF-` signature.
- **Size limit:** 200 MB.
- **Complexity limit:** page range checked against the real page count.
- **Parser:** pdf-lib (page count/size) + bundled PDF.js (rasterise).
- **Isolation:** main thread; rasterisation is bounded by the requested
  page and DPI.
- **Error behaviour:** throw; no underlay mesh is created.
- **Regression test:** `tests/file-guard.test.cjs`,
  `tests/pdf-underlay-loader.test.cjs`.
- **Status:** Pre-existing, unchanged (PR #240). Note: the guard runs
  after `arrayBuffer()` here because the entry point accepts bytes as well
  as a File; the size bound is enforced before parsing either way.

### B10 — PDF → drawing / PDFIN (.pdf)

- **Entry point:** `src/features/cad-viewer.ts:1183`
  (`importPdfAsDrawing`).
- **File type:** PDF (vector).
- **Validation:** `assertFileAllowed("pdf", name, size, head)` with
  `readHead(file, 32)` *before* `file.arrayBuffer()` (added by this PR).
- **Size limit:** 200 MB.
- **Complexity limit:** single page (`page` parameter); vector-only —
  raster images are skipped and counted, not converted.
- **Parser:** `pdfToDxfDocument` (`src/modules/drawings/pdf-vector.ts`),
  then `writeDxf` into a normal DXF tab.
- **Isolation:** main thread, local only ("the PDF is not uploaded").
- **Error behaviour:** toast error; no tab is opened.
- **Regression test:** `tests/pdf-vector-import.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (ordering).
- **Status:** Guarded, ordering-proven.

### B11 — LandXML survey points (.xml)

- **Entry point:** `src/features/cad-viewer.ts:3594` (`importLandXml`),
  `src/modules/drawings/landxml.ts:49` (`parseLandXmlPoints`).
- **File type:** LandXML 1.2 (`<LandXML>` with `<CgPoints>`).
- **Validation:** `guardSize("landxml", f.size)` (5 MB) before the read and
  `guardXmlText` (entity ban) before parsing (added by this PR);
  `isLandXml` shape check; `parseLandXmlPoints` caps at 100,000 points
  (added by this PR).
- **Size limit:** 5 MB; 100,000 CgPoints.
- **Complexity limit:** point cap; regex scan is linear in file size.
- **Parser:** regex-based, no XML parser (so no XXE by construction).
- **Isolation:** main thread; points are only added to the drawing after
  the whole file parses.
- **Error behaviour:** log line in the CAD command log; drawing unchanged.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (valid,
  unparsable coords skipped, 100,001 points refused, ordering).
- **Status:** Guarded + tested.

### B12 — GeoJSON (.geojson)

- **Entry point:** `src/features/file-interop.ts:293`,
  `src/modules/gis/gis-core.ts:38` (`parseGeoJson`).
- **File type:** GeoJSON (FeatureCollection / Feature / geometry).
- **Validation:** `guardSize("geojson", file.size)` (20 MB) before the
  read (added by this PR); `parseGeoJson` now routes through `safeLoad`
  with `GeoJsonSchema` (20 MB, depth 32, 2,000,000 nodes) instead of a
  bare `JSON.parse` (added by this PR). Error wording is unchanged
  ("Not valid JSON", "Not GeoJSON").
- **Size limit:** 20 MB.
- **Complexity limit:** depth 32, 2M nodes, 100,000 features, 5,000,000
  vertices (feature/vertex caps stop with a warning, matching the
  shapefile reader); geometry nesting depth 8.
- **Parser:** `parseGeoJsonDoc` (pure walker; coordinates coerced finite,
  non-finite dropped).
- **Isolation:** main thread, pure function; overlay only, never project state.
- **Error behaviour:** throw with the typed message; `importFiles` catches
  and alerts; nothing is added to the scene.
- **Regression test:** `tests/gis-core.test.cjs` (29 assertions),
  `tests/file-import-boundaries.test.cjs` (malformed, deep nesting,
  oversize, feature cap, vertex cap, non-finite coords).
- **Status:** Guarded + tested. This was the highest-risk JSON boundary
  in the item-3 triage (no size/node bound before parse) — closed here.

### B13 — Shapefile / DBF (.shp, .dbf, .shx, .prj, .cpg)

- **Entry point:** `src/features/file-interop.ts:293`,
  `src/modules/gis/gis-core.ts:130` (`parseShapefile`),
  `:parseDbf`.
- **File type:** ESRI Shapefile + dBase attributes.
- **Validation:** `guardSize("shapefile", file.size)` (256 MB) before the
  read, including the sibling `.dbf` (added by this PR); file-code `9994`
  check; record lengths validated against the buffer before each read.
- **Size limit:** 256 MB per file.
- **Complexity limit:** 5,000,000 vertices (stops with a warning);
  truncated records stop the walk with a warning.
- **Parser:** `parseShapefile` / `parseDbf` (pure, DataView-based).
- **Isolation:** main thread, pure functions; overlay only.
- **Error behaviour:** throw ("Too small", "bad file code", "bad counts");
  nothing is added to the scene.
- **Regression test:** `tests/gis-core.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (limit behaviour).
- **Status:** Guarded + tested.

### B14 — 3D mesh formats (.glb, .gltf, .obj, .stl, .ply, .fbx, .dae, .3ds)

- **Entry point:** `src/features/file-interop.ts:351`
  (`parseModelBytes`).
- **File type:** three.js mesh formats.
- **Validation:** `guardSize("mesh", file.size)` (200 MB) before the read
  (added by this PR). No magic check — the loaders reject non-matching
  content themselves.
- **Size limit:** 200 MB.
- **Complexity limit:** none beyond the loaders (see residual).
- **Parser:** three.js loaders (`GLTFLoader`, `OBJLoader`, `STLLoader`,
  `PLYLoader`, `FBXLoader`, `ColladaLoader`, `TDSLoader`).
- **Isolation:** main thread; added to the aux overlay group only.
- **Error behaviour:** `uiAlert("Could not parse …")`; nothing is added.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (ordering +
  limit behaviour). No per-loader malformed-input fixtures exist.
- **Status:** Guarded, ordering-proven. Residual: the three.js loaders
  have no complexity caps of their own; a hostile-but-valid 200 MB mesh
  is bounded only by the size limit.

### B15 — RVT / RFA / RTE / RFT (view-only decode)

- **Entry point:** `src/features/rvt-viewer.ts:60` (`openRVTFile`),
  `src/modules/rvt/rvt-core.ts:45` (`preflight`).
- **File type:** Revit (OLE2 compound file, closed format).
- **Validation:** `file.size > RVT_MAX_BYTES` (1.5 GB) checked *before*
  `file.arrayBuffer()` (added by this PR; `preflight` already checked
  the bytes afterwards); `preflight` also checks the OLE magic and warns
  above `RVT_WARN_BYTES`.
- **Size limit:** 1.5 GB.
- **Complexity limit:** decoder-internal open limits passed to the WASM
  reader (`openRvtBytesWithDiagnosticsModeAndOpenLimits`).
- **Parser:** rvt-rs WASM reader in `../workers/rvt.worker.ts`; result is
  a GLB, re-parsed by `GLTFLoader` for a triangle count.
- **Isolation:** worker; the worker reply is validated
  (`m.glb instanceof Uint8Array`, non-empty) before it reaches the loader
  (added by this PR).
- **Error behaviour:** toast error; nothing is added to the scene.
- **Regression test:** `tests/rvt-model-viewer.test.cjs` (44 passed,
  including "garbage input throws instead of hanging"),
  `tests/file-import-boundaries.test.cjs` (ordering + reply validation).
- **Status:** Guarded + tested. Residual: RVT/NWD/NWC have no public
  magic to verify server-side either (see B30); the in-browser reader is
  the only validation, and no real `.rvt` has ever been run through it
  end-to-end (see the external-validation deep dive).

### B16 — Project archives (.obsproj)

- **Entry point:** `src/modules/projects/project-file.ts:59`
  (`safeLoad` + `ProjectFileSchema`).
- **File type:** `.obsproj` (binary header + JSON header + blobs).
- **Validation:** `safeLoad` + `ProjectFileSchema`; binary header bounds
  checked before decode.
- **Size limit:** header bounded by file size and the 8 MB safe-load ceiling.
- **Complexity limit:** safeLoad defaults (depth 64, 250,000 nodes).
- **Parser:** `safeLoad` + project normalizer.
- **Isolation:** main thread; the project is only replaced after the
  document validates.
- **Error behaviour:** typed safeLoad rejection.
- **Regression test:** `tests/safe-load.test.cjs`,
  `tests/project-file.test.cjs`.
- **Status:** Pre-existing, unchanged.

### B17 — Legacy project JSON (.obs.json, .json)

- **Entry point:** `src/features/file-interop.ts:281`,
  `src/shell/file-menu.ts:151`.
- **File type:** legacy project JSON.
- **Validation:** `safeLoad` + `LegacyProjectJsonSchema` (20 MB, depth 64,
  2,000,000 nodes) + `normalizeProjectDoc`; the 20 MB file-size check runs
  before `file.text()`.
- **Size limit:** 20 MB; 250,000 elements.
- **Complexity limit:** depth 64, 2M nodes.
- **Parser:** safeLoad + normalizer; `putProject` / `openProject` only
  after normalization succeeds.
- **Isolation:** main thread; malformed imports fail closed and preserve state.
- **Error behaviour:** `Invalid project JSON (<stage>): …`.
- **Regression test:** `tests/safe-load.test.cjs`.
- **Status:** Pre-existing, unchanged.

### B18 — Markups sidecar (.markups.json)

- **Entry point:** `src/features/cad-viewer.ts` (`load-mk` handler).
- **File type:** drawing markups JSON.
- **Validation:** `MarkupsFileSchema` via `safeLoad` (8 MB, depth 64,
  250,000 nodes; 10,000 markups, 10,000 points each; closed 11-value
  `kind` enum; finite coordinates).
- **Size limit:** 8 MB.
- **Complexity limit:** markup/point caps above.
- **Parser:** safeLoad.
- **Isolation:** main thread; a rejected file leaves current markups untouched.
- **Error behaviour:** typed rejection (`size` / `parse` / `schema` /
  `complexity`).
- **Regression test:** `tests/safe-load.test.cjs` (markups cases),
  `tests/safe-load-coverage-audit.test.cjs`.
- **Status:** **Guarded + tested** — landed in this branch: the
  `fix/safeload-markups-audit` commit (`57a3041`, item 3) rebased onto
  `eabab92` as `14a1d58`. Main `eabab92` still parses this file with a bare
  `JSON.parse` in a `.then()` chain; this branch is the fix.

### B19 — Saved views (localStorage JSON)

- **Entry point:** `src/features/saved-views.ts:44`.
- **File type:** JSON in same-origin localStorage (the app's own store).
- **Validation:** `safeLoad` + `SavedViewsSchema`.
- **Size limit:** 256 KiB; 64 views.
- **Complexity limit:** schema caps.
- **Parser:** safeLoad.
- **Isolation:** same-origin store the app itself wrote; corrupt data is
  ignored, not applied.
- **Error behaviour:** typed rejection; views fall back to empty.
- **Regression test:** `tests/safe-load.test.cjs`.
- **Status:** Pre-existing, unchanged.

### B20 — Clash scenarios (JSON)

- **Entry point:** `src/features/clash.ts:1209`.
- **File type:** clash-scenario JSON.
- **Validation:** `safeLoad` + `ClashScenarioImportSchema` +
  `parseScenarios` normalizer.
- **Size limit:** 2 MB; depth 32; 50,000 nodes; 200 scenarios.
- **Complexity limit:** as above.
- **Parser:** safeLoad + normalizer.
- **Isolation:** main thread; scenarios only replace state after validation.
- **Error behaviour:** typed rejection.
- **Regression test:** `tests/safe-load.test.cjs`, clash scenario tests.
- **Status:** Pre-existing, unchanged.

### B21 — Plugin manifests (JSON)

- **Entry point:** `src/plugins/loader.ts:109`.
- **File type:** plugin manifest JSON.
- **Validation:** `safeLoad` + `PluginManifestSchema`.
- **Size limit:** 256 KiB.
- **Complexity limit:** schema caps.
- **Parser:** safeLoad.
- **Isolation:** plugins are same-origin trusted code (see
  `tests/plugins-api.test.cjs`); the manifest is validated before load.
- **Error behaviour:** typed rejection; plugin not loaded.
- **Regression test:** `tests/plugins-api.test.cjs`.
- **Status:** Pre-existing, unchanged.

### B22 — LibreDWG JSON dump

- **Entry point:** `src/features/libredwg-toolkit.ts:162`.
- **File type:** LibreDWG JSON dump (entities envelope).
- **Validation:** `safeLoad` + entities envelope schema.
- **Size limit:** 32 MB.
- **Complexity limit:** safeLoad defaults.
- **Parser:** safeLoad.
- **Isolation:** main thread; the dump comes from the app's own DWG
  conversion path.
- **Error behaviour:** typed rejection.
- **Regression test:** `tests/safe-load.test.cjs`, DWG tests.
- **Status:** Pre-existing, unchanged.

### B23 — Standards packs (JSON)

- **Entry point:** `src/features/standards-panel.ts:104-106`
  (`guardSize` + `loadPackText`), `src/modules/standards/rules/json-pack.ts`
  (`validatePackJson`).
- **File type:** standards-pack JSON.
- **Validation:** `guardSize("standards-pack", f.size)` (5 MB) before the
  read, then `loadPackText` → `validatePackJson()`.
- **Size limit:** 5 MB.
- **Complexity limit:** pack validator caps.
- **Parser:** `validatePackJson` (schema + rule checks).
- **Isolation:** main thread; packs are data only — untrusted packs cannot
  execute code (see issue #144).
- **Error behaviour:** typed error; pack not applied.
- **Regression test:** `tests/standards-json-pack.test.cjs`.
- **Status:** Pre-existing, unchanged.

### B24 — Carbon factors (CSV / JSON)

- **Entry point:** `src/features/timeline-panel.ts:66`
  (`pickAndImportFactors`), `src/modules/schedule-4d/factor-import.ts:37`
  (`parseFactors`).
- **File type:** CSV or JSON of EPD carbon factors.
- **Validation:** `f.size > FACTORS_MAX_BYTES` (5 MB) checked before
  `f.text()` (added by this PR); `parseFactors` re-checks the decoded
  text and caps rows at 50,000 (added by this PR). Values are validated
  (finite, non-negative, unit enum `m3`/`m2`/`m`).
- **Size limit:** 5 MB; 50,000 rows.
- **Complexity limit:** row cap; the override map grows only by validated rows.
- **Parser:** `parseFactors` (CSV splitter / JSON branch).
- **Isolation:** main thread; valid rows merge over current overrides,
  errors are reported per row.
- **Error behaviour:** toast with count + first error; oversize files
  import 0 factors.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (valid CSV/JSON,
  oversize, >50k rows, invalid JSON), `tests/schedule-4d.test.cjs`.
- **Status:** Guarded + tested.

### B25 — Family type catalogs (CSV / TSV)

- **Entry point:** `src/modules/families/type-catalog.ts`
  (`TypeCatalogManager.loadFromFile` / `parseCSV`); the tab-separated
  `src/modules/type-catalog/type-catalog.ts:parseTypeCatalog` has no
  file-input caller in `src/`.
- **File type:** BIM type catalog (`.txt` / `.csv`, `##TYPE` marker).
- **Validation:** `loadFromFile` checks `file.size` (5 MB) before
  `file.text()`; `parseCSV` re-checks the decoded text, caps rows at
  10,000 and parameters at 500 (added by this PR). The tab-separated
  parser has the same caps. Header and cell values are type-checked
  (`coerceValue` throws with a row number on bad values).
- **Size limit:** 5 MB; 10,000 rows; 500 parameters.
- **Complexity limit:** as above.
- **Parser:** `parseCsvRecords` / `parseTypeCatalog`.
- **Isolation:** main thread; a failed parse throws before any family
  state changes.
- **Error behaviour:** `Failed to load type catalog: …` with row/column context.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (valid,
  oversize, >10k rows, >500 params, `loadFromFile` size check).
- **Status:** Guarded + tested.

### B26 — Shared parameters (JSON)

- **Entry point:** `src/modules/families/shared-parameters.ts:202`
  (`SharedParameterManager.import`).
- **File type:** JSON array of parameter definitions.
- **Validation:** string length capped at 1 MB, array capped at 10,000
  entries (added by this PR); each entry is normalised (name required,
  type from a closed enum, GUID generated when missing).
- **Size limit:** 1 MB; 10,000 parameters.
- **Complexity limit:** as above.
- **Parser:** `JSON.parse` + `normalize`.
- **Isolation:** main thread; duplicates by GUID/name are skipped, never
  overwrite silently.
- **Error behaviour:** throw with a clear message.
- **Regression test:** `tests/file-import-boundaries.test.cjs`,
  `tests/shared-parameters.test.mjs`.
- **Status:** Guarded + tested. Note: `import()` currently has **no
  file-input caller** in `src/` (definitions are created through the
  families panel); the caps apply if one is ever wired up.

### B27 — Point clouds (LAS / PLY / PCD / PTX)

- **Entry point:** `src/modules/point-cloud/parsers.ts:44`
  (`parseLas`), `src/modules/point-cloud/point-cloud.ts:61,105`.
- **File type:** LAS, PLY, PCD.
- **Validation:** `assertFileAllowed("point-cloud", …)` (2 GB) before the
  read; `guardLasHeader` (LASF signature, record length, point count vs
  file size, data offset).
- **Size limit:** 2 GB; parser point-count caps.
- **Complexity limit:** header-declared count vs file size.
- **Parser:** `parseLas` / PLY / PCD parsers.
- **Isolation:** main thread; points are decimated/capped by the parser.
- **Error behaviour:** `FileGuardError`; file not opened.
- **Regression test:** `tests/file-guard.test.cjs`,
  `tests/point-cloud-parsers.test.cjs` (15 checks).
- **Status:** **Guarded + tested** — landed in this branch: the
  `fix/las-guard-full-buffer` commit (`4db20ed`, item LAS) rebased onto
  `eabab92` as `441158d`. `parseLas` now passes the full buffer to
  `guardLasHeader`, so valid LAS files with >~148–193 declared points are
  accepted; the 1,000-point regression case is in
  `tests/point-cloud-parsers.test.cjs`.

### B28 — Drag-and-drop and file inputs (transport, not formats)

- **Entry points:**
  - IFC/FRAG/CAD drop: `src/features/importer.ts:1710`
    (`setupImporter` drop handler) — routes `.ifc/.ifczip/.frag` to B1/B3,
    `.dwg/.dxf` to the CAD editor, everything else to the universal
    importer (B14/B15/B12/B4).
  - CAD drop: `src/features/cad-viewer.ts:1070` — `.dwg/.dxf/.bak/.sv$/
    .xml/.pdf` to B5/B6/B11/B10.
  - Standards drop: `src/features/standards-panel.ts:123` — to B23.
  - File pickers: `src/features/importer.ts:1663` (`pickFiles`), IDS
    panel input (B8), RVT picker (B15), PDF picker (B10), factor picker
    (B24).
- **Validation:** none at the transport layer — every route lands in a
  guarded format boundary above. A drop of an unsupported type shows an
  honest message instead of being silently ignored.
- **Regression test:** ordering tests in
  `tests/file-import-boundaries.test.cjs` cover the format boundaries the
  transports feed.
- **Status:** Guarded via the format boundaries. No test evidence for the
  drop handlers themselves (DOM event wiring, browser-only).

### B29 — URL loaders (same-origin assets + user-configured endpoints)

- **Entry points:**
  - WASM / vendor readers (same-origin): `src/features/importer.ts:310`
    (`ensureWasmAvailable` — checks HTTP status, rejects HTML answers and
    undersized binaries), `src/features/solid-import.ts:38`
    (`solidReaderStatus` — same checks for occt/rhino), `src/features/rvt-viewer.ts:17`
    (decoder fetch, WASM-magic check).
  - DWG fallback reader (same-origin): `src/modules/cad-link/dwg-parse-core.ts:72`
    (content-type must be JavaScript).
  - CDE providers (user-configured, token-authenticated):
    `src/modules/cde/providers.ts`, via `src/modules/cde/http.ts:27`
    (`requestJson`).
  - NWC loopback bridge: `src/features/nwc-bridge.ts:59`
    (`fetchWithTimeout`, abort timeout; `validateHealth` requires the
    `openbim-nwc-bridge` service marker).
- **Validation:** same-origin fetches check status + content-type/magic so
  an SPA fallback HTML page is never executed as code; `requestJson` now
  caps responses at 10 MB (`MAX_JSON_RESPONSE_BYTES`, added by this PR)
  with a `content-length` pre-check and a byte-length check before
  `JSON.parse`; NWC health payloads are strictly validated.
- **Size limit:** 10 MB for CDE JSON responses; WASM/vendor checks are
  magic-based, not size-based.
- **Error behaviour:** typed errors naming the host, never the raw body.
- **Regression test:** `tests/nwc-bridge.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (ordering for the CDE cap).
- **Status:** Guarded, ordering-proven. The CDE `requestRaw` path (file
  downloads) is intentionally uncapped — downloads are files, not JSON,
  and are bounded by the caller's own handling.

### B30 — Server upload endpoints

- **Entry point:** `POST /api/convert` (`server/index.mjs:723`),
  `server/upload-store.mjs` (`storeUpload`, `sniffSignature`).
- **File type:** RVT / NWD / NWC / IFC / DXF / DWG uploads for conversion.
- **Validation:** streaming, size-limited body read (`MAX_BODY`, default
  200 MB — the connection is destroyed mid-stream when exceeded, before
  the body is buffered); `sniffSignature` verifies the magic for
  `.ifc` (`ISO-10303-21`), `.dxf`, `.dwg` (`AC10xx`) and records
  `signatureChecked: false` for closed formats (RVT/NWD/NWC — no public
  magic exists); uploads are stored under server-generated opaque ids
  (32 chars), never client-supplied names; the original name is sanitised
  and only echoed back redacted; max 3 concurrent conversions.
- **Size limit:** 200 MB (`OBS_MAX_BODY`).
- **Complexity limit:** rate limiting, per-IP SSE caps, conversion concurrency cap.
- **Parser:** APS conversion service (external); the server only stores
  and forwards.
- **Isolation:** server process; uploads are swept after 24 h
  (`sweepExpired`).
- **Error behaviour:** 413 on oversize, 400-series on bad signature, with
  `securityLog` entries (filenames redacted).
- **Regression test:** `tests/server-security.test.cjs`,
  `tests/server-hardening.test.cjs`.
- **Status:** Pre-existing, unchanged (items 4/5, #91/#92). Not changed by
  this PR; inventoried for completeness.

### B31 — Worker messages

- **Entry points:**
  - Solid reader: `src/modules/solids/solid-reader-worker.ts:165`
    (validates `id`, `kind`, `bytes` — see B4); main thread
    `src/features/solid-import.ts:52` (per-request timeout 180 s, bytes
    transferred).
  - RVT decoder: `src/features/rvt-viewer.ts:39` (`decodeInWorker`;
    reply validated — see B15).
  - DWG reader: `src/modules/cad-link/dwg-reader-worker.ts` (protocol in
    `dwg-reader-protocol.ts`); main thread `src/modules/cad-link/index.ts:133`.
    Request validated by `validateDwgReaderRequest` (ArrayBuffer, 1..256 MiB,
    `parse`|`thumbnail`, file name) before the wasm parser runs; replies
    validated by `validateDwgParseSuccess` / `validateDwgThumbSuccess` /
    `validateDwgFailure` before the CAD link layer sees them.
  - Clash worker: `src/features/clash-worker-client.ts:91`; worker
    `src/workers/clash.worker.ts`. Requests validated by
    `validateClashWorkerRequest` in `src/modules/clash/clash-worker-protocol.ts`
    (items ≤ 250,000, triangles ≤ 1,000,000, finite boxes with min ≤ max,
    finite triangle coordinates, rules/method/groups shape) before any item
    is deserialized; replies validated by `validateClashWorkerReply` in
    `onWorkerMessage` before rehydration.
- **Validation:** workers are same-origin and created by the app; the
  threat model is a buggy caller, not a remote attacker — plus hostile
  geometry reaching the engine, since clash items come from model geometry
  and model geometry comes from files. Every worker now validates payload
  shape and fails typed instead of hanging: solid and RVT (pre-existing),
  DWG and clash (added by this branch, rank 3).
- **Error behaviour:** typed failure posted back; the main thread's
  per-request timeout rejects pending calls. A malformed clash reply
  rejects the pending request and terminates the worker (fail-closed);
  a malformed DWG reply rejects and respawns the reader worker.
- **Regression test:** `tests/solid-reader-isolation.test.cjs`,
  `tests/dwg-reader-isolation.test.cjs`, `tests/dwg-worker-lifecycle.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (solid worker validation),
  `tests/file-import-hostile.test.cjs` (DWG request/reply + clash
  request/reply adversarial cases, 30 checks).
- **Status:** Guarded + tested for all four workers.

### B32 — Live collaboration SSE (presence / changes)

- **Entry point:** `src/modules/collaboration/realtime-client.ts:115,124`.
- **File type:** SSE events from the collab server (own server,
  token-authenticated).
- **Validation:** event text capped at 2 MB (`MAX_SSE_EVENT_BYTES`,
  mirroring the server's `OBS_MAX_CHANGE_PAYLOAD`) before `JSON.parse`
  (added by this PR); presence must be an array, a change must be an
  object with string `clientId` and `type` (added by this PR); malformed
  events are ignored, never applied.
- **Size limit:** 2 MB per event.
- **Complexity limit:** shape check only; the server bounds change
  payloads and room history (`MAX_CHANGES_PER_ROOM` 500).
- **Parser:** `JSON.parse` + shape check.
- **Isolation:** EventSource to the configured collab API (loopback by
  default); own-client events are dropped.
- **Error behaviour:** malformed events are silently ignored.
- **Regression test:** `tests/file-import-boundaries.test.cjs` (ordering +
  shape check), `tests/enterprise-collaboration.test.cjs`.
- **Status:** Guarded, ordering-proven.

### B33 — Agent relay SSE orders

- **Entry point:** `src/features/agent-bridge.ts:301`.
- **File type:** SSE `agent-order` events from the agent relay
  (token-authenticated, origin allow-listed).
- **Validation:** event text capped at 2 MB (`MAX_SSE_EVENT_BYTES`) and
  the parsed order shape-checked (`orderId`/`cmd`/`ask` must be strings
  when present) before anything is executed (added by this PR).
- **Size limit:** 2 MB per event.
- **Complexity limit:** shape check; orders execute one command at a time.
- **Parser:** `JSON.parse` + shape check.
- **Isolation:** relay token auth + origin allow-list
  (`DEFAULT_ALLOWED_ORIGINS`, plus user-added origins in localStorage);
  `postMessage` orders go through the same allow-list.
- **Error behaviour:** malformed/oversized orders are dropped; an order
  with neither `cmd` nor `ask` reports "No cmd or ask in the relay order."
- **Regression test:** `tests/ai-agent-bridge.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (ordering).
- **Status:** Guarded, ordering-proven.

### B34 — AI provider SSE streams

- **Entry point:** `src/features/ai-providers.ts:322,460,534`
  (Anthropic, Ollama-style, OpenAI-compatible streaming loops).
- **File type:** SSE / newline-delimited JSON from a user-configured,
  key-authenticated AI provider.
- **Validation:** the line buffer is capped at 1 MB
  (`MAX_SSE_LINE_BYTES`): a chunk stream with no newline for over 1 MB
  has its buffer dropped, not parsed (added by this PR). Per-line parse
  failures are skipped, not fatal.
- **Size limit:** 1 MB per SSE line.
- **Complexity limit:** line cap; the accumulated `fullContent` is bounded
  by the provider's own response.
- **Parser:** `JSON.parse` per line + `AnthropicStreamReducer`.
- **Isolation:** user-configured endpoint + API key; no project state is
  written from stream content except through tool calls.
- **Error behaviour:** overlong lines are dropped; stream errors surface
  as typed errors.
- **Regression test:** `tests/anthropic-messages.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (cap present in all three loops).
- **Status:** Guarded, ordering-proven.

### B35 — Recovery and project restoration

- **Entry points:**
  - Browser recovery copies: `src/modules/projects/browser-recovery.ts`
    (copies up to 256 MB, newest 5 kept, written to IndexedDB before
    destructive file operations). File backups are offered as downloads
    (`src/features/project-recovery.ts:165`); checkpoint restore goes
    through the normal `openProject` path, which validates via B16/B17.
  - Auto-reopen: `src/modules/projects/auto-reopen.ts` (reopens through
    `openProject`; never parses a file itself).
  - Aux restore: `src/features/file-interop.ts:156` (`restoreAux`) —
    size-bounded per extension (added by this PR); DWG/DXF restore goes
    through `readCadFile` (B5/B6).
  - CAD link restore: `src/modules/cad-link/index.ts:610`
    (`restoreCadLinkFromBlob` → `readCadFile`, guarded).
  - Journal replay: `src/modules/projects/indexeddb-journal.ts:80`
    (`appendLine` — `JSON.parse` now wrapped in a typed error, added by
    this PR; the store is same-origin, written by the app itself).
- **Validation:** restored projects are validated by the same safeLoad
  path as fresh imports; restored aux blobs are size-bounded; corrupt
  journal lines fail typed instead of crashing the caller.
- **Error behaviour:** corrupt live files fall back to the newest valid
  backup (#91); a corrupt newest backup is rejected, not applied.
- **Regression test:** `tests/project-journal.test.cjs`,
  `tests/core-journal.test.cjs`, `tests/project-auto-reopen.test.cjs`,
  `tests/browser-recovery.test.cjs`, `tests/project-persistence.test.cjs`,
  `tests/file-import-boundaries.test.cjs` (restoreAux ordering, journal
  typed error).
- **Status:** Guarded + tested (unit level). Integration evidence for the
  full lifecycle (interrupted writes, corrupt live + corrupt newest
  backup, browser crash/refresh) is item 4 (#91), not this PR.

### B36 — External references and live links

- **Entry points:**
  - Live IFC link: `src/features/link-tools.ts` + IFC importer (B1);
    linked models go through the same guarded import path.
  - CAD links: `src/modules/cad-link/index.ts:569`
    (`refreshCadLinks` → `readCadFile`, B5/B6).
  - CustomEvent bridge: `src/features/file-interop.ts:371`
    (`openbimstudio:load-file` and aliases) — accepts `File`/`Blob`
    objects from same-origin page scripts and routes them into
    `importFiles` (all format boundaries above). No cross-origin data can
    arrive this way unless a third-party script is loaded on the page.
  - Agent `postMessage` orders: `src/features/agent-bridge.ts`
    (origin allow-list, see B33).
- **Validation:** none at the reference layer — every referenced file is
  re-validated by its format boundary when it is (re)loaded.
- **Regression test:** `tests/live-ifc-link.test.cjs`,
  `tests/reference-tracking.test.cjs`.
- **Status:** Guarded via the format boundaries. No test evidence for the
  CustomEvent bridge's file handling beyond the format tests.

### B37 — Prototype pollution via permissive JSON schemas (cross-cutting)

- **Entry points:** every `safeLoad` call site whose schema is deliberately
  permissive: `GeoJsonSchema` (`.passthrough()`), `LegacyProjectJsonSchema`
  (`.passthrough()`), `ProjectFileSchema.doc` (`z.record`), clash-scenario
  `z.unknown()` elements — see B12, B16, B17, B20.
- **File type:** any JSON file routed through safeLoad.
- **Validation:** `safeLoad` now strips every `__proto__` own-key at any
  depth from the schema-validated value before returning it
  (`stripProtoKeys` in `src/core/safeLoad.ts`, added by this branch, rank 3).
  No safeLoad schema declares a `__proto__` field, so the strip can never
  remove legitimate data; a `__proto__` key inside a GeoJSON feature's
  properties is dropped and the feature still imports. `constructor` /
  `prototype` keys are preserved as inert data: assigning them as own
  properties cannot pollute `Object.prototype`, and no consumer in this
  tree deep-merges untrusted data (verified: the only deep merge,
  `i18n.deepMerge`, runs over shipped locale catalogues registered in
  `locale-boot.ts`, never file data).
- **Size limit:** the safeLoad call site's own limits.
- **Complexity limit:** the safeLoad call site's own limits.
- **Parser:** safeLoad.
- **Isolation:** main thread; the strip runs on the zod output, which is
  freshly built, so no caller-owned object is mutated.
- **Error behaviour:** n/a — keys are removed, the load proceeds.
- **Regression test:** `tests/file-import-hostile.test.cjs` (sections A–C):
  root / nested / array `__proto__` payloads, `constructor.prototype`
  payloads, hostile GeoJSON properties, hostile project docs — each
  asserting `({}).polluted === undefined` afterwards.
- **Status:** Guarded + tested.

## Non-boundaries (recorded so the next audit does not re-litigate them)

- In-memory JSON clones / undo snapshots (`plan-view-panel.ts`,
  `authoring.ts`, `bim-experience.ts`) — the app parsing its own
  `JSON.stringify` output.
- Same-origin preferences (`cad-viewer.ts` block library / session map /
  clipboard, `importer.ts:142` IFC settings, `clipboard.ts:241` `parseClip`).
- Library output (`solid-reader-worker.ts:131` rhino3dm,
  `acad-engine.ts` WASM frames, `rvt-core.ts:278` GLB JSON chunk —
  length-checked, `try/catch` → `null`).
- `agent-bridge.ts:172` `allAllowedOrigins` — same-origin localStorage the
  app itself wrote; malformed entries are ignored.
- `ai-providers.ts:63,611` — provider config / stored responses from
  same-origin localStorage.
- `indexeddb-journal.ts` snapshot `state` strings — the app's own
  serialised state, read back through the journal's typed paths.
- `server/index.mjs` non-upload JSON bodies — bounded by `readBody`
  (`MAX_BODY` 200 MB) and `boundedJsonValue` for change payloads.
- Desktop-only formats (`.rvt` conversion in the browser is refused with
  an honest message unless the in-browser RVT viewer (B15) is available;
  `.skp`, `.nwd`, `.nwc` are refused outright — see `DESKTOP_ONLY` in
  `src/features/file-interop.ts`).

## Boundaries without test evidence

Honest list — these are inventoried but have no regression test proving
the rejection, for the stated reason. Do not close #90 on the strength of
this document alone.

Closed in this branch (rank 3) — kept here as the record of what was open:

- ~~Runtime "failed load leaves the project unchanged" browser test.~~
  Closed by `tests/e2e/hostile-file-load.spec.ts`: a wall is authored in
  a real browser, then truncated `.obs.json`, oversized `.geojson`,
  prototype-pollution `.geojson`, garbage `.ifc` and truncated `.ifczip`
  are fed through the real import pipeline; the project snapshot is
  identical after each, `Object.prototype` stays clean, and there are no
  uncaught page errors. A valid GeoJSON control proves the harness can
  tell acceptance from rejection.
- ~~DWG / clash worker message validation (B31).~~ Closed by
  `tests/file-import-hostile.test.cjs` (sections D–G): DWG request/reply
  and clash request/reply adversarial cases, 30 checks.
- ~~Markups sidecar (B18) / LAS false rejection (B27).~~ Both landed in
  this branch via rebase (see B18 / B27).

Still open:

1. **DWG / DXF / IFC / PDF parser internals.** The guards bound size,
   signature and archive structure; malformed content *inside* those
   bounds is handled by the parsers (LibreDWG, web-ifc, pdf-lib, the
   in-repo DXF reader). IFC parser timeouts are issue #231 (separate
   workstream); DWG/DXF have no malformed-input fuzz corpus.
2. **Three.js mesh loaders (B14).** No per-loader malformed-input
   fixtures; bounded only by the 200 MB size limit.
3. **Drop-handler DOM wiring (B28).** The drop handlers themselves are
   browser-only. The browser spec above drives the same `importFiles`
   pipeline the drop handlers feed, but a synthetic DOM `drop` event
   with real files has never been dispatched in a test.
4. **RVT on a real `.rvt` file (B15).** No issued deliverable has ever
   been opened in the tool it was issued for; the in-browser RVT decode
   has only ever run on synthetic fixtures.
5. **Server-side closed-format signatures (B30).** RVT/NWD/NWC uploads
   are accepted with `signatureChecked: false` — there is no public magic
   to verify; documented limitation, not a bug that can be fixed in-repo.

## What changed in this PR (vs main @ e8e5afb)

- `src/core/file-guard.ts` — 8 new `GuardedKind`s (`frag`, `geojson`,
  `shapefile`, `mesh`, `solid`, `landxml`, `factors`, `type-catalog`)
  with ceilings.
- `src/core/safeLoad.ts` — `GeoJsonSchema`.
- `src/modules/gis/gis-core.ts` — GeoJSON through safeLoad + feature /
  vertex caps; `parseGeoJsonDoc` split out for testability.
- `src/features/importer.ts` — IFCZIP size guard before the read;
  `convertIfcToFragBytes` now guards + preflights before WASM;
  `loadFragFiles` size-guarded; queued IFC path guards before the read.
- `src/features/file-interop.ts` — universal-importer ZIP branch now
  guarded (was unguarded); size guards before reads for GeoJSON/SHP,
  STEP/IGES/BREP/3DM, mesh formats; `restoreAux` size-bounded.
- `src/features/cad-viewer.ts` — LandXML size + entity ban; PDFIN size +
  signature before buffering.
- `src/modules/drawings/landxml.ts` — 100,000-point cap.
- `src/modules/schedule-4d/factor-import.ts` + `src/features/timeline-panel.ts`
  — 5 MB / 50,000-row factor caps.
- `src/modules/families/type-catalog.ts` +
  `src/modules/type-catalog/type-catalog.ts` — 5 MB / 10,000-row /
  500-parameter caps.
- `src/modules/families/shared-parameters.ts` — 1 MB / 10,000-entry import caps.
- `src/modules/solids/solid-reader-worker.ts` — request payload validation.
- `src/features/rvt-viewer.ts` — RVT size check before buffering; worker
  reply validation.
- `src/features/ai-providers.ts` — 1 MB SSE line cap in all three streams.
- `src/modules/cde/http.ts` — 10 MB CDE JSON response cap.
- `src/modules/collaboration/realtime-client.ts` — 2 MB SSE event cap +
  shape checks.
- `src/features/agent-bridge.ts` — 2 MB SSE order cap + shape check.
- `src/modules/projects/indexeddb-journal.ts` — typed error on corrupt
  journal lines.
- `tests/file-import-boundaries.test.cjs` — 32 checks (new);
  `tests/gis-core.test.cjs` — compiles safeLoad alongside gis-core;
  `package.json` + `scripts/ci-unit-tests.mjs` — new suite wired in.

Nothing in this PR merges, closes #90, or changes a limit that existing
tests depend on.

## What changed in the rank-3 completion (this branch, vs main @ eabab92)

Rebase of the work above plus the two branches it deliberately did not
duplicate, then the remainder:

- `fix/safeload-markups-audit` (`57a3041`) rebased as `14a1d58`:
  `MarkupsFileSchema` + safeLoad-routed `load-mk` handler, `.then()`-chain
  detection in `scripts/check-safe-load-coverage.mjs`, 8 required
  boundaries (B18).
- `fix/las-guard-full-buffer` (`4db20ed`) rebased as `441158d`: full
  buffer to `guardLasHeader` (B27).
- `src/core/safeLoad.ts` — `stripProtoKeys`: every `__proto__` own-key
  stripped from validated output at any depth (B37).
- `src/modules/cad-link/dwg-reader-protocol.ts` + `dwg-reader-worker.ts`
  + `src/modules/cad-link/index.ts` — DWG request validation
  (ArrayBuffer, 1..256 MiB) and reply validation, fail-closed with
  worker respawn (B31).
- `src/modules/clash/clash-worker-protocol.ts` (new) +
  `src/workers/clash.worker.ts` + `src/features/clash-worker-client.ts`
  — clash request validation (250,000 items, 1,000,000 triangles, finite
  boxes/coords) and reply validation before rehydration (B31).
- `tests/file-import-hostile.test.cjs` (new) — 30 adversarial checks:
  prototype pollution, DWG/clash worker request + reply validation.
- `tests/e2e/hostile-file-load.spec.ts` (new) — the runtime browser
  proof: hostile loads leave the live project unchanged.
- `package.json` + `scripts/ci-unit-tests.mjs` — `test:file-import-hostile`
  wired in.

Still not closed by this branch: parser internals (DWG/DXF/IFC/PDF fuzz),
three.js mesh-loader fixtures, the DOM `drop` event itself, RVT on a real
`.rvt`, server-side closed-format signatures — see "Boundaries without
test evidence" above.
