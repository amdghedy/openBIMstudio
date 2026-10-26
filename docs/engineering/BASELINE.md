# Engineering Baseline — OpenBIMStudio

Phase 0 evidence record for the *Professional Remediation and Platform Enhancement* program.
Captured 2026-10-26. Every claim below was verified by running the command on the recorded commit.

## 1. Version and commit

| Item | Value |
|---|---|
| package.json version | 0.73.0 |
| Git commit | `7c85364` (main, clean tree) |
| Node used for verification | 20.x / 22.x (both CI and local) |
| CI on this commit | Unit tests ✅ · Native BIM validation ✅ · Deploy to Vercel ✅ |

**Version metadata inconsistencies found (to fix in Phase 2):**

| Location | Value | Problem |
|---|---|---|
| `README.md` badge | 0.66.2 | stale (actual 0.73.0) |
| `src/plugins/api.ts` `HOST_VERSION` | 0.55.0 | stale hardcoded host version |
| `src/features/viewcube.ts` About dialog | 0.72.0 | stale |
| CI workflows `unit-tests.yml`, `native-bim-validation.yml` | branch filters verified correct | earlier "ain]" reading was an output-rendering artifact, not file content (raw-byte check) |

## 2. Environment assumptions

- **Node.js**: 20 (Vercel/CI unit-tests) and 22 (native-bim workflow) both verified.
- **Browsers**: Chromium-class primary (test evidence); Safari/Firefox untested — see COMPATIBILITY.md (Phase 2 deliverable).
- **WASM**: requires WebAssembly; web-ifc runs single-threaded (no SharedArrayBuffer requirement shipped); LibreDWG WASM 11 MB loaded only when CAD workflow used (prebuild copy script).
- **OS**: authoring developed on Windows/macOS/Linux dev shells; no OS-specific runtime code in the app itself.
- **GPU**: WebGL 2 required by three.js; no minimum spec measured yet (Phase 6).
- **Network**: local-first; the app runs without network except optional AI / APS conversion / CDE / collaboration features.

## 3. Exact command results (as of `7c85364`)

| Command | Result | Notes |
|---|---|---|
| `npm ci --legacy-peer-deps` | ✅ pass | dry-run verified; used by native-bim workflow |
| `npm install --legacy-peer-deps` | ✅ pass | used by unit-tests + deploy workflows |
| `npm run typecheck` | ✅ pass | `tsc --noEmit` clean |
| `npm run build` | ✅ pass | 40.7 s, no unexplained warnings beyond chunk-size notice |
| Full unit suite (54 `test:*` scripts) | ✅ 54/54 pass | all CI-listed suites re-run locally |
| Verify scripts (`verify:v68`–`verify:v73`) | ✅ 5/5 pass | |
| `npm audit --omit=dev --audit-level=high` | ❌ **2 critical** | see §4 |

## 4. Dependency vulnerabilities

```
jsonpath-plus  <=10.2.0                    (critical, RCE ×2: GHSA-pppg-cpfq-h7wr, GHSA-hw8r-x6gr-5gjp)
└── json-rules-engine 5.0.0-alpha1 – 7.0.0-alpha.1
    └── node_modules/json-rules-engine@6.6.0
```

**Exploitability analysis (verified):** `json-rules-engine` is declared in `package.json` but is **imported nowhere** in `src/`, `public/`, `scripts/`, or `tests/` (full-repo scan). JSONPath expressions therefore **cannot** be influenced by project files, IDS files, plugins, or user input — the vulnerable code never executes. The dependency is a phantom that still ships the vulnerable package into `node_modules` and fails CI audit.

**Remediation decision:** remove the unused dependency (safer than a blind major upgrade of a library with zero call sites). No code change required. A malicious-rule regression test is added to pin the absence (Phase 1).

**Second phantom found:** `nasjidwg@^0.18.0` — declared, never imported anywhere. Removed with the same evidence standard.

## 5. Production bundle sizes (from `npm run build`)

| Asset | Raw | gzip |
|---|---|---|
| `ifc-vendor-*.js` | 3,556.9 kB | 399.6 kB |
| `thatopen-vendor-*.js` | 2,366.6 kB | 679.3 kB |
| `index-B-CaSdCG.js` (app entry) | 1,611.9 kB | 532.3 kB |
| `worker-*.mjs` (web-ifc) | 3.2 MB | — |
| `three-vendor-*.js` | 729.5 kB | 190.4 kB |
| `command-palette-*.js` | 471.9 kB | 144.8 kB |
| `measure-*.js` | 295.5 kB | 94.3 kB |
| `libredwg-web-*.js` + `.wasm` | 198.5 kB + 11 MB | 58 kB |
| `dist/web-ifc/` (copied engines) | 23 MB | — |
| **dist total** | **58 MB** | — |

Budgets and lazy-loading actions are defined in `docs/PERFORMANCE.md` (Phase 6 deliverable). Notable: the 11 MB LibreDWG WASM is only fetched when the CAD workflow loads it; web-ifc engine files under `dist/web-ifc/` are served but loaded on demand by the IFC pipeline.

## 6. Placeholder / stub inventory

| Item | Location | Classification | Action (Phase 1/3) |
|---|---|---|---|
| `ExportDWGCommand.execute()` logs only | `src/commands/ExportDWGCommand.ts` | **Fake success** — unreachable dead stub; real DXF export exists at `src/modules/drawings/dxf-writer.ts` (`writeDxf`/`downloadDxf`, wired via drawings features) | Remove stub; label export as DXF; interop matrix records the truth |
| Plugin `authoring.createElement` returns stub object + `console.info` | `src/plugins/api.ts:57` | **Fake success** | Wire to real authoring creation path or typed NotImplemented |
| Plugin `HOST_VERSION = "0.55.0"` | `src/plugins/api.ts:20` | Wrong metadata | Derive from single version source |
| `setupBimGaps` (M2 boot: stairs/railing/roof/room) registered but never invoked | `src/modules/bim-gaps/bim-gaps-boot.ts` | Experimental / unwired | Separate task (documented in v0.73 notes §6) |
| CI sed re-patch of test tsc flags | `unit-tests.yml` | Obsolete (flags removed at source; scan finds 0 occurrences) | Remove step |
| `continue-on-error: true` on audit step | `unit-tests.yml` | Masks vulnerabilities | Remove once audit is clean |

## 7. External-format support boundaries (verified from source)

| Format | Direction | Status | Mechanism |
|---|---|---|---|
| IFC | import + export | Implemented, limited | web-ifc / ThatOpen; authored-model export via `modules/export/native-twin-ifc.ts` |
| DXF | import + export | Implemented (2D scope) | `modules/drawings/dxf-reader.ts` / `dxf-writer.ts` |
| DWG | import | Implemented, limited | LibreDWG WASM (`@mlightcad/libredwg-web`) |
| DWG | export | **Unavailable** (stub only, removed) | — |
| BCF 2.1 | import/export | Implemented, limited | `modules/export/bcf21.ts`, `modules/issues/bcf.ts` |
| IDS | audit | Implemented, limited | `features/ids.ts`, `features/ids-panel.ts` |
| PDF | export | Implemented, limited | `modules/export/pdf.ts`, `sheet-pdf.ts` |
| RVT/NWD/NWC | conversion | Implemented via **external APS** | `server/index.mjs` `/api/convert` — requires APS credentials, explicit user action; uploads stored locally when APS not configured |
| COBie / CSV / JSON | export | Implemented, limited | `modules/export/*` |

Full per-format matrix with fixtures and dates: `docs/INTEROPERABILITY_MATRIX.md` (Phase 4 deliverable).

## 8. Local server & collaboration risks (verified from `server/index.mjs` + `security.mjs`)

1. **Fail-open startup**: `HOST=0.0.0.0` + no `OBS_SERVER_TOKEN` only prints a warning and continues — must refuse (Phase 1.2).
2. **No required origin allow-list** for non-loopback deployments.
3. **Query-string tokens accepted on every `/api/` route** (bearer alternative exists); SSE-only restriction + short-lived SSE tokens not implemented.
4. **No rate limiting** (per IP/token), no request correlation IDs, no structured security log.
5. **Convert route hardening gaps**: body collected without streaming size limit (header-only check); user-supplied file name used as the storage key; response leaks storage layout (`savedPath`); raw upstream/parser error strings returned to clients; no cap on simultaneous conversions; no retention cleanup of `server/data/uploads`.
6. **No file-signature validation** beyond extension allow-list (`safeUploadName`).
7. **Persistence**: projects/rooms are whole-file JSON reads/writes (`projects.json`, `rooms.json`) — not transactional, no concurrency control; acceptable for local single-user, not for shared CDE use (Phase 5).
8. Static files are **not** served by this process (API only) — uploads are not publicly reachable, but must also move off user-controlled names.

## 9. Feature maturity inventory (major user-facing commands)

Legend: **verified** = implemented + runtime-verified by tests/verify scripts; **limited** = implemented with documented boundaries; **experimental** = present but not fully hardened; **planned** / **unavailable** = honestly labelled.

| Feature area | Status | Source | Tests / runtime evidence | Known limitations |
|---|---|---|---|---|
| Authoring tools (wall/slab/column/beam/brace/truss/footing/strip/mline, MEP, door/window, grid/level) | verified | `features/authoring.ts` | v68 suites, `verify:v68–v73` | doors/windows hosted only on authored walls |
| Dynamic properties panel + justification + magnetic snapping | verified | `features/tool-panels.ts`, `features/property-palette.ts`, `modules/justification/`, `modules/snapping/` | v73 suites (71 assertions), `verify:v73` (46 checks) | tangent snap N/A (no arc elements); rotation propagation is registry-report |
| Modify engine (move/copy/rotate/mirror/array/offset + Group 1) | verified | `modules/modify/` | v71 suite, `verify:v71` | |
| ViewCube / navigation / Home controls | verified | `modules/navigation/`, `features/viewcube.ts` | v72 suite (69 tests), `verify:v72` | About dialog shows stale version |
| Solid kernel (booleans incl. non-convex, shell, loft) | verified | `modules/solid-kernel/` | v70 suite, geometry tests | |
| IFC import/export | limited | `features/bim-import.ts`, `modules/export/native-twin-ifc.ts` | ifc.test.cjs, native-bim validation | no per-entity interop report yet (Phase 4) |
| DXF import/export | limited | `modules/drawings/` | dxf-features suite | 2D scope; entities outside scope reported |
| DWG import | limited | LibreDWG WASM | dwg-features suite | version coverage per LibreDWG |
| DWG export | **unavailable** | (stub removed) | — | command label must say DXF |
| BCF 2.1 | limited | `modules/issues/bcf.ts`, `modules/export/bcf21.ts` | issues suites | two-application round-trip validation pending (Phase 4) |
| IDS | limited | `features/ids.ts` | ids suites | unsupported facets not yet itemised per spec (Phase 4) |
| Sheets/Views/PDF export | limited | `modules/views/`, `modules/export/` | m3 suites, plan tests | |
| Schedules / cost / quantities | limited | `modules/schedules/`, `modules/cost/` | schedule suites | |
| Clash detection | limited | `features/clash-engine.ts`, worker | clash suites | worker cancellation pending (Phase 6) |
| Collaboration (server + SSE + Yjs) | **experimental** | `server/index.mjs`, `modules/collaboration/` | server-security suite (25 lines — thin) | fail-open startup; JSON persistence; Phase 1.2/5 scope |
| APS conversion (RVT/NWD/NWC→IFC) | experimental | `server/index.mjs`, `services/rfaImport.ts`, `services/bimRoundTrip.ts` | none (network-dependent) | hardening per Phase 1.3/3.3 |
| AI assistant | limited | `features/ai-providers.ts`, `features/ai-privacy.ts` | ai-privacy suite (15 assertions) | cloud redaction covered; local provider path separate |
| Plugin system | experimental | `plugins/loader.ts`, `plugins/api.ts` | none | fake createElement; trust model undocumented; Phase 1.4 |
| Encrypted project files | verified | `modules/projects/project-crypto.ts` | project-crypto + secret-crypto suites | |

## 10. Known gaps mapped to program phases

| Program phase | Baseline section |
|---|---|
| Phase 1 security | §4 (audit), §8 (server), §6 (stubs) |
| Phase 2 product truth | §1 (versions), §9 (maturity) |
| Phase 3 incomplete features | §6, §7 (DWG export, APS flow, round-trip) |
| Phase 4 interop | §7 |
| Phase 5 persistence/collab | §8.7 |
| Phase 6 performance | §5 |
| Phase 7 browser E2E | absent today — no browser-level tests exist |
| Phase 8 architecture | global `__obs*` bridges pervasive; patch scripts in `scripts/` |
| Phase 9 docs | §1 inconsistencies |

## 11. Rule for closing gaps

A gap may only be marked closed in this file (or the feature registry) when implementation + tests + runtime evidence + documentation + user-facing maturity state all agree. Evidence references are updated per stage in the corresponding stage reports.

## 12. Stage status (living record)

| Stage | Closed items | Evidence |
|---|---|---|
| Stage 1 (`d8565df`) | §4 critical vulnerabilities (phantom `json-rules-engine`→`jsonpath-plus` removed; `nasjidwg` removed); fake `ExportDWGCommand` stub deleted; CI audit `continue-on-error` removed; obsolete CI sed patch removed; `npm ci` in unit-tests | `npm audit --omit=dev --audit-level=high` = 0 vulnerabilities; `tests/dependency-safety.test.cjs` 7/7 |
| Stage 2 (server hardening) | §8.1 fail-closed startup (non-loopback without strong token + explicit origins → process exit); §8.2 origin allow-list enforced; §8.3 query tokens restricted to SSE route + short-lived signed SSE tokens (`?sse=`); §8.4 per-IP rate budgets (general + mutations) and SSE connection cap; correlation IDs + structured security logs with token/file-name hygiene; §8.5 streaming size limit on uploads, opaque server-side upload ids (no user-name keys, no `savedPath` leak), signature sniffing (IFC/DXF/DWG; RVT/NWD/NWC documented unverifiable), conversion concurrency cap, retention sweeps (uploads + jobs + post-download deletion), generic client errors; §8.8 `OBS_DATA_DIR` isolation for tests | `tests/server-hardening.test.cjs` 37/37 (incl. spawned-server integration: refused startup, 401/403/413/429 paths, malformed JSON generic, SSE limits, signed-token accept/reject, upload path-leak checks); legacy `server-security` 11/11; typecheck clean; build ok. Remaining §8.7 (JSON persistence → transactional store) explicitly **not** closed — Phase 5 scope. |
| Stage 3 (plugin boundary) | §6 plugin `createElement` fake stub replaced with a REAL creation path (`AuthoringService.createElementByType` → history-wrapped `createElement`, 56-type whitelist) returning a typed `PluginCreateResult` (`ok/id` or `not-implemented`/`rejected`) — no fake success; stale `HOST_VERSION=0.55.0` and About-dialog `0.72.0` replaced by a single version source `src/version.ts` (pinned to package.json by test); optional manifest `integrity: sha256-…` pin verified by the loader before activation; plugin trust model (same-origin trusted code, no sandbox today) documented in docs/PLUGIN_SDK.md | `tests/plugins-api.test.cjs` 11/11; typecheck clean; zero shipped plugins depended on the old signature |
| Stage 4 (CSP) | §1.5: full directive-by-directive CSP **specified and documented** (docs/CSP.md, source-by-source justification + provider inventory + maintenance rules) — but **honestly NOT enabled**: production-boot verification (Playwright-class browser against `vite preview`) showed the policy blocks the ThatOpen Fragments worker and aborts boot; the same build boots fully without the meta. Enablement deferred to Phase 7 E2E harness with the exact blocker recorded. No partially-working policy shipped. | docs/CSP.md (status + verified blocker); boot-failure repro noted; API-server header policy unchanged and strict (server/security.mjs) |

