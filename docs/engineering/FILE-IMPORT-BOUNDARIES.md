# JSON file-import boundary inventory

This inventory covers JSON files imported into application state. It does not classify in-memory JSON cloning, local preference parsing, server HTTP response decoding, generated translation catalogs, or build-time metadata as user file imports.

| Entry point | Input | Validation before state mutation | Size / complexity bound | Regression evidence |
|---|---|---|---|---|
| `src/modules/projects/project-file.ts` | `.obsproj` header | `safeLoad` + `ProjectFileSchema`; binary header bounds checked before decode | Header bounded by file size and 8 MiB safe-load ceiling | `tests/safe-load.test.cjs`, `tests/project-file.test.cjs` |
| `src/features/file-interop.ts` | Legacy `.obs.json` | `safeLoad` + project normalizer | 20 MB | `tests/safe-load.test.cjs` |
| `src/shell/file-menu.ts` | File-menu legacy `.obs.json` | `safeLoad` + `LegacyProjectJsonSchema` + `normalizeProjectDoc` | 20 MB; 250,000 element ceiling | `tests/safe-load.test.cjs` |
| `src/plugins/loader.ts` | Plugin manifest JSON | `safeLoad` + `PluginManifestSchema` | 256 KiB | `tests/plugins-api.test.cjs`, safe-load coverage audit |
| `src/features/saved-views.ts` | Saved-view JSON from local storage | `safeLoad` + `SavedViewsSchema` | 256 KiB; 64 views | `tests/safe-load.test.cjs` |
| `src/features/clash.ts` | Clash-scenario JSON | `safeLoad` + `ClashScenarioImportSchema` + `parseScenarios` normalizer | 2 MB; depth 32; 50,000 nodes; 200 scenarios | `tests/safe-load.test.cjs`, clash scenario tests |
| `src/features/libredwg-toolkit.ts` | LibreDWG JSON dump | `safeLoad` + entities envelope schema | 32 MB | `tests/safe-load.test.cjs`, DWG tests |

## Malformed input corpus

`tests/fixtures/malformed/` contains ten fixtures: empty, truncated, array root, missing identity, blank identity, wrong collection type, invalid project envelope/version, excessive nesting, oversized payload, and invalid clash-scenario envelope. The safe-load regression suite asserts every fixture is rejected with a typed result.

## Binary and text import boundaries (`src/core/file-guard.ts`)

These are not JSON payloads and are not routed through `safeLoad`. Each calls the shared guard **before** the file is read into a parser or any application state is touched; `tests/file-guard.test.cjs` proves the guard behaviour and, per entry point, the call ordering.

| Entry point | Format | Guard before parsing | Limit |
|---|---|---|---|
| `src/features/importer.ts` | IFC | `assertFileAllowed("ifc")` + `preflightStep` (bounded STEP structure check; web-ifc hangs on an unterminated string, issue #231) | 1.5 GB |
| `src/features/importer.ts` | IFCZIP / ZIP | `guardZipDirectory` (entry count, declared sizes, ratio, unsafe paths, ZIP64 rejected) | 20,000 entries; 1 GB/entry; 3 GB total; ratio 1000 |
| `src/modules/cad-link/index.ts` | DWG (`readDwg`, `readDwgThumbnail`) | size + `AC10xx` signature on the first 32 bytes | 256 MB |
| `src/modules/cad-link/index.ts`, `src/modules/drawings/dxf-reader.ts` | DXF | size + `0/SECTION` or binary-DXF signature | 512 MB |
| `src/modules/issues/bcf.ts` | BCF | size + `PK` signature + `guardZipDirectory` before JSZip, then `validateBcfArchive` | 256 MB |
| `src/modules/pdf-underlay/pdf-underlay.ts` | PDF | size + `%PDF-` signature | 200 MB |
| `src/features/ids-panel.ts` | IDS XML | size + `guardXmlText` (no `<!ENTITY`, no inline DOCTYPE subset) | 5 MB |
| `src/features/standards-panel.ts` | Standards pack (JSON) | size guard, then `loadPackText` | 5 MB |
| `src/modules/point-cloud/parsers.ts` | LAS | `guardLasHeader` (signature, record length, point count vs file size, data offset) | by parser point cap |
| `src/modules/point-cloud/point-cloud.ts` | PLY / PCD | size guard | 2 GB |

Failure behaviour: a rejected file throws `FileGuardError` ("… The file was not opened and your project is unchanged."). Callers invoke the guard before any state write, which `tests/file-guard.test.cjs` asserts by source ordering. That is a static ordering proof, not a runtime browser test.

Still format-specific and NOT covered by the shared guard: the contents of DWG/DXF/IFC/PDF are validated only by their parsers (isolated worker / child process), RVT/other desktop-only formats are refused outright, and CSV family catalogs use their own row/column limits.

## Guardrail behavior

`scripts/check-safe-load-coverage.mjs` scans application source (including shell entry points), checks the known JSON import boundaries, and rejects direct `JSON.parse(file.text())` or assigned `File.text()` values parsed without `safeLoad`. The CI unit battery runs `test:safe-load`; the static audit is a separate required CI step.

The inventory is an auditable map, not a claim that every binary format is fully hardened: the guards bound size, signature and archive structure; parser behaviour on malformed content inside those bounds is covered by the fuzz and malformed-fixture suites.
