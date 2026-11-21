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
| `src/features/cad-viewer.ts` | `.markups.json` sidecar (drawing editor Load) | `safeLoad` + `MarkupsFileSchema` (closed `kind` enum, finite coords, 10,000 markups / 10,000 pts per markup) | 8 MB safe-load ceiling; depth 64; 250,000 nodes | `tests/safe-load.test.cjs`, `tests/safe-load-coverage-audit.test.cjs` |

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

Failure behaviour: a rejected file throws `FileGuardError` ("… The file was not opened and your project is unchanged."). Callers invoke the guard before any state write, which `tests/file-guard.test.cjs` asserts by source ordering. The runtime counterpart is `tests/e2e/hostile-file-load.spec.ts`, which loads hostile files in a real browser and asserts the live project is unchanged.

Still format-specific and NOT covered by the shared guard: the contents of DWG/DXF/IFC/PDF are validated only by their parsers (isolated worker / child process), RVT/other desktop-only formats are refused outright, and CSV family catalogs use their own row/column limits.

## Guardrail behavior

`scripts/check-safe-load-coverage.mjs` scans application source (including shell entry points), checks the known JSON import boundaries, and rejects direct `JSON.parse(file.text())`, assigned `File.text()` values parsed without `safeLoad`, and `.then()`-chain parses (`file.text().then((txt) => JSON.parse(txt))` and `file.text().then(JSON.parse)`). The `.then()` shape is what hid the `.markups.json` loader: the parse sat inside a promise callback, invisible to the first two checks. The CI unit battery runs `test:safe-load` and `test:safe-load-audit`; the static audit is a separate required CI step.

## Long-tail triage — remaining `JSON.parse` sites (checked on `main` @ `d19735f`, updated for the rank-3 completion on `eabab92`)

Full scan: 147 non-clone `JSON.parse` sites in `src/` + `server/` + `api/` + `worker/`. Most are in-memory clones, same-origin preference reads, or undo snapshots of the app's own `JSON.stringify` output — none of those is a file/network/peer boundary and they are grouped at the bottom. The rows below are the sites that *do* touch file, network or peer input. Status as of this branch (`fix/revit-3-safeload`): the markups loader was fixed by item 3, the GeoJSON / factors / shared-parameters / SSE / CDE / AI-provider / journal rows by the `fix/file-import-boundaries` rebase (import90), and the worker-message rows by the rank-3 remainder work. Only the server rows and the dormant schedule importer remain unguarded, with owners named.

| Site | Input | Guarded? | Risk / follow-up |
|---|---|---|---|
| `src/features/cad-viewer.ts:13215` (now `safeLoad`) | `.markups.json` sidecar | **Yes** (`safeLoad` + `MarkupsFileSchema`) | Was the audit escape: `.then()`-chain parse, no size/schema/depth guard. Fixed (item 3, rebased in this branch). |
| `src/modules/gis/gis-core.ts:21` via `src/features/file-interop.ts:294` (+ `restoreAux`, `:154`) | `.geojson` file / persisted aux blob | **Yes** — `safeLoad` (20 MB, depth 32, 2M nodes) + 100,000-feature / 5M-vertex walker caps; `__proto__` keys stripped by safeLoad (B37) | Fixed by the import90 rebase in this branch. |
| `src/modules/schedule-4d/factor-import.ts:39` via `src/features/timeline-panel.ts:66` | EPD carbon-factor CSV/JSON file | **Yes** — 5 MB / 50,000 rows (`FACTORS_MAX_BYTES` / `FACTORS_MAX_ROWS`) | Fixed by the import90 rebase in this branch. |
| `src/modules/families/shared-parameters.ts:206` (`import()`) | Shared-parameter JSON | **Yes** — 1 MB / 10,000 entries (`SHARED_PARAMETERS_MAX_BYTES` / `SHARED_PARAMETERS_MAX_COUNT`) | Fixed by the import90 rebase in this branch. Still no direct file-input caller in `src/`; the caps apply if one is wired up. |
| `src/modules/schedules/schedule-store.ts:95` (`importSchedules`) | Schedule JSON | **No** — and dormant: no callers in `src/` | None live. Guard if/when it is wired to a file input. |
| `src/modules/collaboration/realtime-client.ts:115,124` | SSE presence/change events from the collab server | **Yes** — 2 MB event cap (`MAX_SSE_EVENT_BYTES`) + shape checks (presence array, change object with string `clientId`/`type`) | Fixed by the import90 rebase in this branch. |
| `src/features/agent-bridge.ts:301` | SSE `agent-order` from the agent relay | **Yes** — 2 MB event cap + shape check (`orderId`/`cmd`/`ask` strings) | Fixed by the import90 rebase in this branch. |
| `src/modules/cde/http.ts:20` (`requestJson`) | HTTP JSON from a user-configured CDE provider | **Yes** — 10 MB response cap (`MAX_JSON_RESPONSE_BYTES`, content-length pre-check + byte-length check before parse) | Fixed by the import90 rebase in this branch. |
| `src/features/ai-providers.ts:320,458,535` | SSE stream lines from a configured AI provider (Anthropic / OpenAI / Ollama) | **Yes** — 1 MB per-line cap (`MAX_SSE_LINE_BYTES`) in all three streaming loops | Fixed by the import90 rebase in this branch. |
| `src/modules/rvt/rvt-core.ts:278` (`readGlbJson`) | GLB JSON chunk from the RVT conversion output | Partial — chunk length is checked against the buffer; `try/catch` returns `null` | Low — input is the project's own converter output, not a raw file. |
| `src/modules/projects/indexeddb-journal.ts:81` (`appendLine`) | Journal op lines from the app's own IndexedDB | **Yes** — corrupt lines now throw a typed error instead of a raw `JSON.parse` throw | Fixed by the import90 rebase in this branch. |
| `server/index.mjs:91,396,496,567,607`, `server/upload-store.mjs:85` | Server store files + project/room/agent PUT bodies | **No** (see #91 / #92) | Owned by items 4 (#91, corrupt-load hole at `:91`) and 5 (#92, unvalidated PUT bodies) — not this change. |
| `worker/auth.ts:232`, `worker/index.ts:260` | Worker-side JWT payload / request JSON | Out of scope for #90 file boundaries | Not a browser file import; no change here. |

Worker-message boundaries (not `JSON.parse` sites, recorded here because the
item-3 triage named them as the remaining gap): the DWG reader worker and
the clash worker now validate incoming messages, and both clients validate
replies — see inventory B31. DWG: `validateDwgReaderRequest` (ArrayBuffer,
1..256 MiB) in `dwg-reader-protocol.ts`, replies via
`validateDwgParseSuccess` / `validateDwgThumbSuccess` /
`validateDwgFailure`. Clash: `validateClashWorkerRequest` /
`validateClashWorkerReply` in `src/modules/clash/clash-worker-protocol.ts`
(250,000 items, 1,000,000 triangles, finite boxes/coords). Adversarial
proof: `tests/file-import-hostile.test.cjs` (30 checks). Runtime proof
that a failed load leaves the project unchanged:
`tests/e2e/hostile-file-load.spec.ts`.

Not boundaries (no guard needed, recorded so the next audit does not re-litigate them):

- **In-memory clones / undo snapshots** — `JSON.parse(JSON.stringify(x))`, `plan-view-panel.ts` dimension/annotation/region snapshots, `authoring.ts` / `bim-experience.ts` undo payloads: the app parsing its own `JSON.stringify` output.
- **Same-origin preferences** — `localStorage` reads (`cad-viewer.ts` block library `:514`, session map `:1786`, clipboard `:7706`; `importer.ts:142` IFC settings; `agent-bridge.ts:172` extra origins; `clipboard.ts:241` `parseClip`, which shape-checks); `schedule-diff.ts:33` snapshots; `rvt-trust-gates.ts:68` checkpoints. Same-origin, app-written, `try/catch`ed; worst case is a reset to defaults.
- **Library output, not attacker JSON** — `solid-reader-worker.ts:131` (rhino3dm serialising its own document); `acad-engine.ts:138,299` (the app's own WASM engine frames).
- **Good example** — `src/modules/standards/rules/json-pack.ts:204` (`loadPackText`): 5 MB cap + `validatePackJson()` before `compilePack()`. This is the shape the unguarded rows above should converge to.

The inventory is an auditable map, not a claim that every binary format is fully hardened: the guards bound size, signature and archive structure; parser behaviour on malformed content inside those bounds is covered by the fuzz and malformed-fixture suites.
