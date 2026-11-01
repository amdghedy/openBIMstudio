# openBIMstudio — Production Hardening Issue Backlog

Paste-ready issues for `github.com/amdghedy/openBIMstudio`.
Generated November 1, 2026 from the Production Hardening Plan (v0.74.0 evidence base:
`README.md`, `documentation/MASTER_TOOL_CATALOG.md`, `docs/engineering/BASELINE.md`).

**Automated option:** run `bash create_issues.sh` (GitHub CLI) to open all 18 issues with labels in one go.

| Id | Title | Priority | Phase | Estimate | Status @ `7b7a338` (2026-11-01) |
|----|-------|----------|-------|----------|
| P0-01 | Global crash containment: error boundaries per panel + crash log | Critical | Phase 0 | 1d | ✅ satisfied |
| P0-02 | Zod validation at all file-load boundaries (`safeLoad`) | Critical | Phase 0 | 1d | 🔶 partial |
| P0-03 | Backup-on-load with rotating timestamps | High | Phase 0 | 0.5d | ⬜ open |
| P0-04 | Fail-closed server: origin allow-list, header-only tokens, rate limit | Critical | Phase 0 | 1d | 🔶 partial |
| P0-05 | Remove `jsonpath-plus`; add npm audit CI gate | Critical | Phase 0 | 0.5d | ✅ satisfied |
| P1-01 | Freeze `__obs*` globals with ESLint; typed service registry | High | Phase 1 | 2d | ✅ satisfied |
| P1-02 | TypeScript strictification wave 1 (src/modules, src/core) | High | Phase 1 | 3d | ✅ satisfied |
| P1-03 | Assemble 20-fixture IFC golden corpus (licensed, snapshotted) | High | Phase 1 | 2d | 🔶 partial (3/20) |
| P1-04 | Golden round-trip pipeline + interop report + CI workflow | High | Phase 1 | 3d | ✅ satisfied |
| P1-05 | Property-based kernel invariants (fast-check) | High | Phase 1 | 2d | ⬜ open |
| P1-06 | Malformed-input rejection property tests (IFC, BCF, DXF) | Medium | Phase 1 | 1d | 🔶 partial |
| P1-07 | Playwright E2E smoke suite on Chromium, WebKit, Firefox | High | Phase 1 | 3d | 🔶 partial |
| P2-01 | Append-only journal persistence with snapshot recovery | High | Phase 2 | 4d | 🔶 partial |
| P2-02 | Maturity gate: tool-catalog.json enforcement in CI | High | Phase 2 | 2d | 🔶 partial |
| P2-03 | Performance budget benchmark + CI gate | Medium | Phase 2 | 2d | 🔶 partial |
| P2-04 | Nightly parser fuzzing loop | Medium | Phase 2 | 2d | ⬜ open |
| P2-05 | Spec-before-code process + SPEC_TEMPLATE.md | Medium | Phase 2 | 0.5d | ✅ satisfied |
| P2-06 | Surface per-entity IFC interop report in the UI | Medium | Phase 2 | 2d | ⬜ open |

---

## P0-01 — Global crash containment: error boundaries per panel + crash log

- **Labels:** `hardening`, `P0`, `critical`
- **Phase / Estimate:** Phase 0 / 1 day

**Evidence (our own docs):** BASELINE lists "Global architecture issues (`__obs*` bridges pervasive)" and the Tool Catalog states tool maturity varies; today a single tool failure can take the whole app down.

**Problem:** No React error boundaries exist. An exception in any panel propagates and blanks or corrupts the whole session, and unhandled promise rejections vanish without a trace.

**Tasks**
- [ ] Add `src/core/crashLog.ts`: capped (50-entry) ring buffer in `localStorage`, defensive against its own corruption, with `exportCrashReport()`
- [ ] Add `src/shell/AppErrorBoundary.tsx` (props: `tool`) showing a contained "This panel failed / Retry" UI
- [ ] Wrap every ribbon panel, the Command Center, and the properties panel in `AppErrorBoundary`
- [ ] Install `window.onerror` + `unhandledrejection` handlers once in `main.tsx` before feature modules load
- [ ] Add a crash-log viewer (list + copy report) accessible from Help/settings

**Acceptance criteria**
- [ ] E2E fault-injection scenario (debug flag) forces a panel exception: shell, viewport, and other panels stay interactive
- [ ] Crash entry is recorded with tool name and stack, survives reload, and is exportable
- [ ] Zero uncaught-exception console errors in the E2E suite baseline run

---

## P0-02 — Zod validation at all file-load boundaries (`safeLoad`)

- **Labels:** `hardening`, `P0`, `critical`
- **Phase / Estimate:** Phase 0 / 1 day

**Evidence:** BASELINE: "Back up project data before testing migration, import/export, or experimental authoring features" and "A file opening successfully is not evidence of dimensionally correct output." Today malformed JSON-shaped inputs can corrupt shared state.

**Problem:** Project files, saved views, BCF manifests, plugin manifests, and automation-rule packs are parsed without schema validation; a wrong-version or truncated file crashes deep inside feature code.

**Tasks**
- [ ] Add `src/core/safeLoad.ts`: `safeLoad(file, raw, schema)` returning `LoadResult<T>` (never throws)
- [ ] Define schemas: `ProjectFileSchema`, `BcfManifestSchema`, `PluginManifestSchema` (+ saved views, automation rules)
- [ ] Route every JSON-shaped loader through `safeLoad`; show a readable error dialog listing issue paths
- [ ] Binary formats (IFC/DWG): wrap parsers to reject non-conforming input with typed error codes (deep fuzzing comes in P1-06)
- [ ] Build a 10-input malformed corpus (truncated, empty, wrong version, deeply nested, oversized) under `tests/fixtures/malformed/`

**Acceptance criteria**
- [ ] All corpus inputs produce typed `LoadError` results with human-readable issues; zero uncaught exceptions
- [ ] Every JSON loader in `src/` goes through `safeLoad` (grep audit added to CI as a lint check or unit test)

---

## P0-03 — Backup-on-load with rotating timestamps

- **Labels:** `hardening`, `P0`, `high`
- **Phase / Estimate:** Phase 0 / 0.5 day

**Evidence:** BASELINE, Collaboration risks: "JSON persistence not transactional."

**Problem:** A crash mid-save or a bad migration can corrupt the only copy of a project. Until journaling lands (P2-01), rotating backups are the cheap 90% fix.

**Tasks**
- [ ] Add `src/core/backup.ts` (server/Node form; OPFS equivalent for the browser build)
- [ ] `backupBeforeWrite(path)`: timestamped `.bak` copy before migration loads and destructive writes
- [ ] Keep last 5 backups; prune older on each write
- [ ] Wire into project open (when a version migration will run) and into any "delete/reset" flows

**Acceptance criteria**
- [ ] Test: corrupt a project mid-save, recover from the newest `.bak`
- [ ] Rotation never exceeds 5 backups per file; backup failure never blocks the primary write path

---

## P0-04 — Fail-closed server: origin allow-list, header-only tokens, rate limit

- **Labels:** `hardening`, `P0`, `critical`, `security`
- **Phase / Estimate:** Phase 0 / 1 day

**Evidence (BASELINE risks):** "Fail-open startup when no OBS_SERVER_TOKEN"; "Query-string tokens accepted on all /api/ routes"; "No rate limiting or request correlation IDs"; "No origin allow-list for non-loopback deployments."

**Tasks**
- [ ] `server/middleware/failClosed.ts`: origin allow-list (`OBS_ALLOWED_ORIGINS`), reject `?token=` with 401, require `Authorization: Bearer <OBS_SERVER_TOKEN>`, per-IP fixed-window rate limit (60 req/min) with 429
- [ ] Boot rule: if HOST is not loopback and `OBS_SERVER_TOKEN` is unset, exit(1) with a clear message
- [ ] Add request correlation id middleware (uuid per request, echoed in logs and error responses)
- [ ] Integration tests for each rejection path (403 / 401 / 429)

**Acceptance criteria**
- [ ] All four BASELINE risk items demonstrably closed by tests
- [ ] Local-first default is unchanged: loopback usage without token still works for dev (`OBS_ALLOWED_ORIGINS` defaults to localhost)

---

## P0-05 — Remove `jsonpath-plus`; add npm audit CI gate

- **Labels:** `hardening`, `P0`, `critical`, `security`
- **Phase / Estimate:** Phase 0 / 0.5 day

**Evidence (BASELINE):** "Dependency vulnerabilities: jsonpath-plus <=10.2.0 (critical RCE vulnerabilities). Identified as phantom dependencies (unused but shipped)."

**Tasks**
- [ ] `npm rm jsonpath-plus` (and any other phantom deps found via `depcheck`); verify absence from `package-lock.json`
- [ ] Add `npm audit --audit-level=critical` (fail) or an allow-listed `audit-ci` step to CI
- [ ] Sweep the codebase for any jsonpath usage patterns and replace with local logic if actually referenced

**Acceptance criteria**
- [ ] `grep -r jsonpath-plus package-lock.json` is empty
- [ ] CI fails on new critical advisories (test by pinning a known-vulnerable dev dep on a throwaway branch)

---

## P1-01 — Freeze `__obs*` globals with ESLint; typed service registry

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 2 days

**Evidence (BASELINE):** "Global architecture issues (`__obs*` bridges pervasive)."

**Problem:** Window-level service bridges let any module mutate any other module's state; errors surface far from their cause.

**Tasks**
- [ ] ESLint `no-restricted-syntax` rules: `MemberExpression[object.name='window'][property.name=/^__obs/]` and `Identifier[name=/^__obs/]` (messages point to `src/core/registry.ts`)
- [ ] Add `src/core/registry.ts`: `registerServices()` (throws on duplicate boot) and `svc()` (throws if used pre-boot)
- [ ] Migrate 3 core services (transactions, selection, ifc) to the registry in this issue; delete their bridges
- [ ] Document the freeze rule in CONTRIBUTING.md: new code uses `svc()`; bridges are deleted as they are migrated

**Acceptance criteria**
- [ ] CI lint fails on any new `__obs*` global (verified with a test commit)
- [ ] At least 3 services migrated; bridge count reduced (add the count to the PR description as a baseline)

---

## P1-02 — TypeScript strictification wave 1 (src/modules, src/core)

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 3 days (spread over weeks; convert-on-touch)

**Evidence:** README repository snapshot: JavaScript 75.6% / TypeScript 24.1%.

**Tasks**
- [ ] Add `tsconfig.strict.json` (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `allowJs`, `checkJs`) covering `src/modules` + `src/core`
- [ ] Fix the initial `checkJs` report without blocking CI (report-only step first)
- [ ] Wire an `any`-count ratchet job into CI: count explicit `any` in `src/modules`, fail if the count rises
- [ ] Convert-on-touch policy: files edited for any reason get converted to `.ts` strict-clean in the same PR
- [ ] Order: geometry → ifc → transactions modules first; UI feature directories later (wave 2, tracked here as follow-ups)

**Acceptance criteria**
- [ ] `tsc -p tsconfig.strict.json` green on `src/core`; `src/modules` report-only with a recorded starting count
- [ ] Ratchet job in CI green for 2 consecutive weeks; count never increased

---

## P1-03 — Assemble 20-fixture IFC golden corpus (licensed, snapshotted)

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 2 days
- **Depends on:** nothing; blocks P1-04

**Tasks**
- [ ] Create/collect per the plan's Table 5 composition: Revit IFC4 arch x4, Revit IFC2x3 arch x2, Revit IFC4 MEP x3, Revit IFC4 structure x2, ArchiCAD x2, Tekla x2, BlenderBIM x2, FreeCAD x1, synthetic IFC4 x1, synthetic IFC2x3 x1
- [ ] All fixtures self-authored or openly licensed; record source tool + version + license in `test/fixtures/ifc-corpus/MANIFEST.md`
- [ ] Author one dedicated Revit test project for exports (no client data, ever)
- [ ] Commit normalized snapshots directory (initial expected values)

**Acceptance criteria**
- [ ] 20 `.ifc` files committed with manifest, licenses, and sizes recorded
- [ ] Each fixture opens in the current app without errors (smoke check script)

---

## P1-04 — Golden round-trip pipeline + interop report + CI workflow

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 3 days
- **Depends on:** P1-03

**Evidence (BASELINE):** "IFC: No per-entity interop report yet." This issue closes that gap.

**Tasks**
- [ ] `src/core/interop/diff.ts`: per-IFC-class entity counts, property-set key sets, placement matrices (1e-6), unit assignments, normalized tessellation geometry hash
- [ ] `scripts/golden-roundtrip.mjs`: import -> export -> re-import -> diff; writes `interop-report.json`; exit 1 on regression
- [ ] `.github/workflows/golden-roundtrip.yml`: run on push/PR, upload report artifact, fail on snapshot diff
- [ ] Tier expectations per fixture class: strict for synthetic; subset-aware for vendor files (missing/extra counted separately); tighten as the exporter grows

**Acceptance criteria**
- [ ] Report generated on every push and downloadable as an artifact
- [ ] An intentionally regressed exporter (test commit) turns the workflow red
- [ ] Report includes per-class missing/extra counts — the per-entity interop report the baseline asks for

---

## P1-05 — Property-based kernel invariants (fast-check)

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 2 days

**Rationale:** Hand-written tests cover imagined cases; properties search the unimagined ones.

**Tasks**
- [ ] Add `fast-check`; build `tests/helpers/testEngine` (seeded model, `applyOp`, `undo`, `hashState`)
- [ ] Undo invariant: arbitrary op sequence + N undos restores the exact start hash (Listing 11 of the plan)
- [ ] Split/join conservation: wall area/volume conserved across split + join
- [ ] Snap tolerance: post-snap endpoints within tolerance; justification offset preserved
- [ ] Target 10 invariants total; 500 runs each in CI, seeded shrink failures reported as issues

**Acceptance criteria**
- [ ] 10 invariants green at `numRuns: 500`
- [ ] Mutation check: a deliberately broken undo step is caught by the undo property test

---

## P1-06 — Malformed-input rejection property tests (IFC, BCF, DXF)

- **Labels:** `hardening`, `P1`, `medium`
- **Phase / Estimate:** Phase 1 / 1 day
- **Depends on:** P0-02 (typed error convention)

**Tasks**
- [ ] `tests/property/ifc-rejection.test.ts`: arbitrary bytes -> importer resolves to ok or typed error within timeout (Listing 12)
- [ ] Equivalent property tests for BCF zip parsing and DXF text parsing
- [ ] Document the controlled-failure contract: typed error code, no hang, no tab crash, no OOM

**Acceptance criteria**
- [ ] 300-run property tests green for all three parsers
- [ ] Each parser exposes a stable error code list referenced in user-facing error dialogs

---

## P1-07 — Playwright E2E smoke suite on Chromium, WebKit, Firefox

- **Labels:** `hardening`, `P1`, `high`
- **Phase / Estimate:** Phase 1 / 3 days

**Evidence (BASELINE):** "Browser-level tests (none exist)"; "Safari/Firefox browsers (untested)."

**Tasks**
- [ ] `playwright.config.ts`: 3 projects (chromium w/ `--use-gl=swiftshader`, webkit, firefox); `webServer` = build + preview; test against the production build
- [ ] Implement the 15 scenarios from the plan's Table 6 (E1 open, E2 import, E3 ViewCube, E4 hide/isolate, E5 section box, E6 wall+door, E7 move/undo/redo, E8 save/reload, E9 clash, E10 BCF round-trip, E11 sheet->PDF, E12 CSV, E13 validation, E14 malformed load, E15 fault injection)
- [ ] Add `data-testid` attributes where needed (import control, model tree, element count, tool buttons, save)
- [ ] CI workflow with per-engine traces/videos on failure
- [ ] Flake policy: one retry in CI; persistent flakes are quarantined with an issue, never silently skipped

**Acceptance criteria**
- [ ] 15 scenarios x 3 engines green against the production build
- [ ] E15 depends on P0-01 boundaries and proves containment end-to-end

---

## P2-01 — Append-only journal persistence with snapshot recovery

- **Labels:** `hardening`, `P2`, `high`
- **Phase / Estimate:** Phase 2 / 4 days

**Evidence (BASELINE):** "JSON persistence not transactional"; "No concurrency control."

**Tasks**
- [ ] `src/core/journal.ts` + `JournalStore` abstraction (OPFS/IndexedDB for browser, fs for server): append line (durable) -> every 500 ops snapshot + compact
- [ ] Recovery = newest snapshot + deterministic replay; replay correctness covered by a property test (same ops -> same state hash)
- [ ] Route project mutations through the journal; keep legacy JSON save as an export format
- [ ] Version every snapshot; P0-03 backups remain as belt-and-braces
- [ ] Design note: journal doubles as the collaboration op stream (feeds the Yjs/SSE server in a follow-up)

**Acceptance criteria**
- [ ] Kill-during-save test recovers to an identical state hash
- [ ] Journal file size stays bounded (compaction verified)
- [ ] Concurrent local tabs serialize through one writer (no interleaved corruption)

---

## P2-02 — Maturity gate: tool-catalog.json enforcement in CI

- **Labels:** `hardening`, `P2`, `high`
- **Phase / Estimate:** Phase 2 / 2 days

**Evidence:** MASTER_TOOL_CATALOG.md status vocabulary (source present / UI exposed / tested / runtime verified / partial) is documentation; nothing fails the build when claims and tests drift.

**Tasks**
- [ ] Encode the catalog as `documentation/tool-catalog.json` (id, name, status, tests[], verifiedScenarios[], knownLimitation)
- [ ] `scripts/check-tool-catalog.mjs`: every UI-registered command id must exist in the catalog; `tested`/`runtime-verified` statuses require all listed test files to exist; `partial` requires knownLimitation text
- [ ] Generate the markdown catalog from JSON (single source of truth; delete hand-edited drift)
- [ ] Wire into CI on push + PR
- [ ] Migrate existing catalog content into JSON (bulk conversion + manual review pass)

**Acceptance criteria**
- [ ] A test branch adding an uncatalogued command fails CI
- [ ] A test branch removing a test file referenced by a `tested` tool fails CI
- [ ] Markdown catalog is generated, not hand-maintained

---

## P2-03 — Performance budget benchmark + CI gate

- **Labels:** `hardening`, `P2`, `medium`
- **Phase / Estimate:** Phase 2 / 2 days

**Evidence (BASELINE):** "GPU minimum specs (not measured yet)"; automated tests "cannot prove ... large-model performance."

**Tasks**
- [ ] `scripts/bench-large-model.mjs`: headless import of a 50-100 MB reference IFC (committed as checksum + download script, or generated synthetically); record wall time + peak heap with `--expose-gc`
- [ ] `scripts/budget.json`: maxSeconds 60, maxPeakMB 1500, main JS bundle <= 2500 KB, e2e smoke <= 180 s
- [ ] `scripts/check-budget.mjs` gate in CI on release candidates
- [ ] Policy: tighten only after 3 consecutive green runs; loosening requires a linked issue

**Acceptance criteria**
- [ ] Benchmark runs in CI and emits a JSON result artifact
- [ ] Deliberately doubled import time (synthetic sleep, test branch) fails the gate

---

## P2-04 — Nightly parser fuzzing loop

- **Labels:** `hardening`, `P2`, `medium`
- **Phase / Estimate:** Phase 2 / 2 days
- **Depends on:** P1-06 (controlled-failure contract)

**Tasks**
- [ ] `scripts/fuzz-ifc.mjs` (and BCF/DXF variants): deterministic byte mutations of the golden corpus; run in disposable workers with hard timeouts
- [ ] Allowed outcomes: `ok` or `typed-error`; anything else (hang, OOM kill, worker crash) exits 1 and blocks release
- [ ] GitHub Actions nightly workflow with artifact upload of failing inputs
- [ ] Failing inputs become regression fixtures (minimized) in the corpus

**Acceptance criteria**
- [ ] 500 mutations per parser per night, all outcomes controlled
- [ ] An injected hang (test branch) fails the nightly run
- [ ] At least one real edge case discovered and converted into a fixture within the first month

---

## P2-05 — Spec-before-code process + SPEC_TEMPLATE.md

- **Labels:** `hardening`, `P2`, `medium`, `process`
- **Phase / Estimate:** Phase 2 / 0.5 day

**Rationale:** With AI-assisted development the bottleneck is defining correct, not writing code. One page per tool before implementation; the agent writes tests from the spec alongside the feature.

**Tasks**
- [ ] Add `documentation/SPEC_TEMPLATE.md` (problem, scope, numbered acceptance criteria, fixture matrix, failure modes, catalog target + test files)
- [ ] Require every new-tool PR to link a spec (enforced socially first; P2-02 gate later checks catalog target)
- [ ] Write the first two specs retroactively for in-flight tools to validate the template
- [ ] Record the rule in CONTRIBUTING.md: no feature PR without a spec; bugs get failing-test-first

**Acceptance criteria**
- [ ] Template merged; two example specs completed
- [ ] Next 5 feature PRs all link a spec (tracked in the PR descriptions)

---

## P2-06 — Surface per-entity IFC interop report in the UI

- **Labels:** `hardening`, `P2`, `medium`
- **Phase / Estimate:** Phase 2 / 2 days
- **Depends on:** P1-04 (report generation)

**Evidence (BASELINE):** "IFC: No per-entity interop report yet." The data exists after P1-04; this issue makes it visible to users and to the export path.

**Tasks**
- [ ] After each IFC export, generate the entity-level report in-app (classes exported, classes skipped by the subset, pset coverage)
- [ ] Show a "What this export contains" summary dialog and a detailed per-class table
- [ ] Offer report download alongside the IFC file (honest-deliverable pattern: the export states its own boundaries)
- [ ] Link from the Tool Catalog: IFC export entry gains a "see interop report" note

**Acceptance criteria**
- [ ] Exporting any model offers the per-entity report without extra tooling
- [ ] Unsupported IFC classes are listed explicitly (no silent subset), matching the project's own "never silently describe a partial subset as complete" principle

---

## Suggested labels

```
gh label create hardening   --description "Production hardening workstream" --color 5319e7 --force
gh label create P0          --description "Phase 0 containment"              --color b60205 --force
gh label create P1          --description "Phase 1 correctness engine"       --color d93f0b --force
gh label create P2          --description "Phase 2 structural trust"         --color fbca04 --force
gh label create critical    --description "Do first"                         --color b60205 --force
gh label create high        --description "High priority"                    --color d93f0b --force
gh label create medium      --description "Medium priority"                  --color fbca04 --force
gh label create security    --description "Security related"                 --color ee0701 --force
gh label create process     --description "Process / documentation"          --color c5def5 --force
```

---

## Status assessment @ main `7b7a338` (2026-11-01)

Evidence-based audit of main against each issue's acceptance criteria
(`scripts/check-hardening-evidence.sh` reproduces this check):

- **Satisfied on main (close on issue creation):** P0-01 crash containment
  (`src/core/crashLog.ts`, `AppErrorBoundary`, `window.onerror` + crash viewer),
  P0-05 (`jsonpath-plus` gone + npm audit gate), P1-01 (`registry.ts` + ESLint
  `__obs` rule), P1-02 (`strict: true`), P1-04 (roundtrip pipeline + workflow
  activated on push), P2-05 (`SPEC_TEMPLATE.md`).
- **Partial progress (create + progress comment):** P0-02 (safeLoad + schemas
  exist; loader routing, malformed corpus, CI audit missing), P0-04 (origin
  allow-list done; rate limiting missing), P1-03 (3/20 fixtures), P1-06 (some
  malformed tests; property suites missing), P1-07 (playwright config; runner
  not in devDeps), P2-01 (`journal.ts` exists; not wired into persistence),
  P2-02 (`check-tool-catalog.mjs` exists; no CI enforcement), P2-03
  (`budget.json` exists; no CI workflow).
- **Not started:** P0-03, P1-05, P2-04, P2-06.

Run `bash docs/engineering/sync-issues.sh` (needs `GH_TOKEN` or `/tmp/gh.token`)
to create all 18 issues from the bodies below, close the satisfied ones with
evidence comments, and drop progress comments on the partial ones. Idempotent.
