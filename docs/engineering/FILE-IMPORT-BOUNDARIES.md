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

## Binary and text import boundaries

These are not JSON payloads and must not be routed through `safeLoad`. They require format-specific parsing and resource limits:

- IFC: WebIFC parser isolation and deterministic fuzz corpus; see issue #231.
- DXF: DXF parser and independent ezdxf validation; do not equate DXF with DWG.
- DWG: isolated LibreDWG/native worker pipeline with conversion limits.
- BCF: ZIP/archive validation and XML parsing; archive traversal and decompression limits remain covered by the BCF/security workstream.
- PDF: PDF.js loader and document-size handling.
- LAS/PTX/point clouds: bounded point counts and parser-specific limits.
- CSV family/type catalog: CSV parser and row/column validation.

## Guardrail behavior

`scripts/check-safe-load-coverage.mjs` scans application source (including shell entry points), checks the known JSON import boundaries, and rejects direct `JSON.parse(file.text())` or assigned `File.text()` values parsed without `safeLoad`. The CI unit battery runs `test:safe-load`; the static audit is a separate required CI step.

The inventory is an auditable map, not a claim that every binary format is fully hardened. Each parser-specific workstream retains its own acceptance criteria.
