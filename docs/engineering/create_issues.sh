#!/usr/bin/env bash
# create_issues.sh — one-shot bootstrap: creates labels + all 18 hardening issues
# for github.com/amdghedy/openBIMstudio via the GitHub CLI.
#
# Usage:
#   gh auth login          # once
#   bash create_issues.sh  # from anywhere; targets the repo set in REPO below
#
# NOTE: re-running will open duplicate issues. Treat this as a one-shot bootstrap
# and manage the issues in GitHub afterwards. Bodies mirror ISSUES.md.

set -euo pipefail

REPO="amdghedy/openBIMstudio"
command -v gh >/dev/null || { echo "GitHub CLI (gh) not found — install it first"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not authenticated: run 'gh auth login' first"; exit 1; }

echo "== Creating labels =="
mklabel() { gh label create "$1" --repo "$REPO" --description "$2" --color "$3" --force >/dev/null 2>&1 \
  && echo "  label ok: $1" || echo "  label skipped: $1 (exists?)"; }
mklabel hardening "Production hardening workstream" 5319e7
mklabel P0 "Phase 0 containment" b60205
mklabel P1 "Phase 1 correctness engine" d93f0b
mklabel P2 "Phase 2 structural trust" fbca04
mklabel critical "Do first" b60205
mklabel high "High priority" d93f0b
mklabel medium "Medium priority" fbca04
mklabel security "Security related" ee0701
mklabel process "Process / documentation" c5def5

mk_issue() {
  local title="$1" labels="$2" body="$3"
  echo "== Issue: $title"
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" >/dev/null \
    && echo "   created" || echo "   FAILED (check labels/auth)"
}

echo "== Creating issues =="
mk_issue "P0-01 Global crash containment: error boundaries per panel + crash log" "hardening,P0,critical" "$(cat <<'EOF'
**Evidence (BASELINE):** "Global architecture issues (`__obs*` bridges pervasive)". Tool Catalog: tool maturity varies; today one tool failure can take down the whole app.

**Problem:** No React error boundaries. An exception in any panel propagates; unhandled rejections vanish without a trace.

**Tasks**
- [ ] `src/core/crashLog.ts`: capped 50-entry ring buffer in localStorage, defensive against its own corruption, `exportCrashReport()`
- [ ] `src/shell/AppErrorBoundary.tsx` (props: `tool`), contained "panel failed / Retry" UI
- [ ] Wrap every ribbon panel, Command Center, properties panel
- [ ] `window.onerror` + `unhandledrejection` handlers in `main.tsx` before feature modules load
- [ ] Crash-log viewer (list + copy report) in Help/settings

**Acceptance criteria**
- [ ] E2E fault-injection: forced panel exception leaves shell, viewport, other panels interactive
- [ ] Crash entries recorded with tool + stack, survive reload, exportable
EOF
)"

mk_issue "P0-02 Zod validation at all file-load boundaries (safeLoad)" "hardening,P0,critical" "$(cat <<'EOF'
**Evidence (BASELINE):** "A file opening successfully is not evidence of dimensionally correct output." Malformed JSON-shaped inputs can corrupt shared state today.

**Tasks**
- [ ] `src/core/safeLoad.ts`: `safeLoad(file, raw, schema)` returning `LoadResult<T>`, never throws
- [ ] Schemas: ProjectFileSchema, BcfManifestSchema, PluginManifestSchema (+ saved views, automation rules)
- [ ] Route every JSON-shaped loader through safeLoad; readable error dialog with issue paths
- [ ] Binary parsers (IFC/DWG) reject non-conforming input with typed error codes
- [ ] 10-input malformed corpus under `tests/fixtures/malformed/`

**Acceptance criteria**
- [ ] Corpus inputs produce typed LoadError results; zero uncaught exceptions
- [ ] CI audit test: every JSON loader in src/ goes through safeLoad
EOF
)"

mk_issue "P0-03 Backup-on-load with rotating timestamps" "hardening,P0,high" "$(cat <<'EOF'
**Evidence (BASELINE):** "JSON persistence not transactional". A crash mid-save or bad migration can destroy the only copy of a project.

**Tasks**
- [ ] `src/core/backup.ts` (server/Node form; OPFS equivalent for browser)
- [ ] `backupBeforeWrite(path)`: timestamped `.bak` before migration loads and destructive writes
- [ ] Keep last 5; prune older
- [ ] Wire into project open (when a version migration runs) and delete/reset flows

**Acceptance criteria**
- [ ] Test: corrupt a project mid-save, recover from newest .bak
- [ ] Rotation max 5 per file; backup failure never blocks the primary write
EOF
)"

mk_issue "P0-04 Fail-closed server: origin allow-list, header-only tokens, rate limit" "hardening,P0,critical,security" "$(cat <<'EOF'
**Evidence (BASELINE risks):** "Fail-open startup when no OBS_SERVER_TOKEN"; "Query-string tokens accepted on all /api/ routes"; "No rate limiting"; "No origin allow-list for non-loopback deployments".

**Tasks**
- [ ] `server/middleware/failClosed.ts`: origin allow-list (OBS_ALLOWED_ORIGINS); reject ?token= with 401; require Authorization: Bearer; per-IP 60 req/min -> 429
- [ ] Boot rule: non-loopback HOST without OBS_SERVER_TOKEN exits with clear message
- [ ] Request correlation id middleware
- [ ] Integration tests for 403 / 401 / 429 paths

**Acceptance criteria**
- [ ] All four BASELINE risk items closed by tests
- [ ] Loopback dev without token still works (local-first default unchanged)
EOF
)"

mk_issue "P0-05 Remove jsonpath-plus; add npm audit CI gate" "hardening,P0,critical,security" "$(cat <<'EOF'
**Evidence (BASELINE):** "jsonpath-plus <=10.2.0 (critical RCE vulnerabilities). Identified as phantom dependencies (unused but shipped)."

**Tasks**
- [ ] `npm rm jsonpath-plus`; verify absent from package-lock.json
- [ ] `npm audit --audit-level=critical` (or allow-listed audit-ci) failing CI
- [ ] Sweep for jsonpath usage patterns; replace with local logic if actually referenced

**Acceptance criteria**
- [ ] grep jsonpath-plus package-lock.json is empty
- [ ] CI fails on new critical advisories (verified via throwaway branch)
EOF
)"

mk_issue "P1-01 Freeze __obs* globals with ESLint; typed service registry" "hardening,P1,high" "$(cat <<'EOF'
**Evidence (BASELINE):** "Global architecture issues (`__obs*` bridges pervasive)".

**Tasks**
- [ ] ESLint no-restricted-syntax: `MemberExpression[object.name='window'][property.name=/^__obs/]` and `Identifier[name=/^__obs/]`
- [ ] `src/core/registry.ts`: registerServices() (throws on duplicate boot), svc() (throws pre-boot)
- [ ] Migrate transactions, selection, ifc services to registry; delete their bridges
- [ ] Document freeze rule in CONTRIBUTING.md

**Acceptance criteria**
- [ ] CI lint fails on new `__obs*` globals (test commit)
- [ ] 3 services migrated; bridge count baseline recorded in PR
EOF
)"

mk_issue "P1-02 TypeScript strictification wave 1 (src/modules, src/core)" "hardening,P1,high" "$(cat <<'EOF'
**Evidence:** README snapshot: JavaScript 75.6% / TypeScript 24.1%.

**Tasks**
- [ ] `tsconfig.strict.json` (strict, noUncheckedIndexedAccess, noImplicitOverride, exactOptionalPropertyTypes, allowJs, checkJs) over src/modules + src/core
- [ ] Fix initial checkJs report as report-only first
- [ ] any-count ratchet job in CI (fail on increase)
- [ ] Convert-on-touch policy; geometry -> ifc -> transactions first

**Acceptance criteria**
- [ ] tsc green on src/core; src/modules report-only with recorded start count
- [ ] Ratchet non-increasing for 2 consecutive weeks
EOF
)"

mk_issue "P1-03 Assemble 20-fixture IFC golden corpus (licensed, snapshotted)" "hardening,P1,high" "$(cat <<'EOF'
**Blocks:** P1-04. Composition per the plan's Table 5: Revit IFC4 arch x4, Revit IFC2x3 arch x2, Revit IFC4 MEP x3, Revit IFC4 structure x2, ArchiCAD x2, Tekla x2, BlenderBIM x2, FreeCAD x1, synthetic IFC4 x1, synthetic IFC2x3 x1.

**Tasks**
- [ ] Create/collect fixtures; dedicated Revit test project (no client data ever)
- [ ] All self-authored or openly licensed; MANIFEST.md with source tool + version + license
- [ ] Commit initial expected snapshots

**Acceptance criteria**
- [ ] 20 .ifc files committed with manifest + licenses
- [ ] Each opens in the current app without errors (smoke script)
EOF
)"

mk_issue "P1-04 Golden round-trip pipeline + interop report + CI workflow" "hardening,P1,high" "$(cat <<'EOF'
**Evidence (BASELINE):** "IFC: No per-entity interop report yet." **Depends on:** P1-03.

**Tasks**
- [ ] `src/core/interop/diff.ts`: per-class entity counts, pset key sets, placement matrices (1e-6), units, normalized tessellation hash
- [ ] `scripts/golden-roundtrip.mjs`: import -> export -> re-import -> diff -> interop-report.json; exit 1 on regression
- [ ] `.github/workflows/golden-roundtrip.yml`: push/PR gate + report artifact + snapshot diff check
- [ ] Tiered expectations per fixture class (strict synthetic; subset-aware vendor); tighten as exporter grows

**Acceptance criteria**
- [ ] Report on every push, downloadable artifact
- [ ] Regressed exporter (test commit) turns workflow red
- [ ] Report shows per-class missing/extra counts (the per-entity interop report)
EOF
)"

mk_issue "P1-05 Property-based kernel invariants (fast-check)" "hardening,P1,high" "$(cat <<'EOF'
Hand-written tests cover imagined cases; properties search the unimagined ones.

**Tasks**
- [ ] fast-check + `tests/helpers/testEngine` (seeded model, applyOp, undo, hashState)
- [ ] Undo invariant: arbitrary ops + N undos restore exact start hash
- [ ] Split/join conservation; snap tolerance; justification preserved
- [ ] 10 invariants total, 500 runs each in CI

**Acceptance criteria**
- [ ] 10 invariants green at numRuns 500
- [ ] Deliberately broken undo step is caught by the undo property
EOF
)"

mk_issue "P1-06 Malformed-input rejection property tests (IFC, BCF, DXF)" "hardening,P1,medium" "$(cat <<'EOF'
**Depends on:** P0-02 typed error convention.

**Tasks**
- [ ] `tests/property/ifc-rejection.test.ts`: arbitrary bytes -> ok or typed error within timeout
- [ ] Same for BCF zip and DXF text parsing
- [ ] Document controlled-failure contract: typed code, no hang, no tab crash, no OOM

**Acceptance criteria**
- [ ] 300-run properties green for all three parsers
- [ ] Stable error code list surfaced in user-facing dialogs
EOF
)"

mk_issue "P1-07 Playwright E2E smoke suite on Chromium, WebKit, Firefox" "hardening,P1,high" "$(cat <<'EOF'
**Evidence (BASELINE):** "Browser-level tests (none exist)"; "Safari/Firefox browsers (untested)".

**Tasks**
- [ ] playwright.config.ts: chromium (--use-gl=swiftshader), webkit, firefox; webServer = build + preview; test the production build
- [ ] 15 scenarios (plan Table 6): open, import, ViewCube, hide/isolate, section box, wall+door, move/undo/redo, save/reload, clash, BCF round-trip, sheet->PDF, CSV, validation, malformed load, fault injection (E15 uses P0-01)
- [ ] data-testid attributes where missing
- [ ] CI workflow; traces/videos on failure; flake quarantine policy

**Acceptance criteria**
- [ ] 15 scenarios x 3 engines green on production build
- [ ] E15 proves containment end-to-end
EOF
)"

mk_issue "P2-01 Append-only journal persistence with snapshot recovery" "hardening,P2,high" "$(cat <<'EOF'
**Evidence (BASELINE):** "JSON persistence not transactional"; "No concurrency control".

**Tasks**
- [ ] `src/core/journal.ts` + JournalStore (OPFS/IndexedDB browser, fs server): durable append; snapshot + compact every 500 ops
- [ ] Recovery = newest snapshot + deterministic replay (property-tested)
- [ ] Route mutations through journal; legacy JSON save becomes export format
- [ ] Journal doubles as the collaboration op stream (follow-up)

**Acceptance criteria**
- [ ] Kill-during-save recovers to identical state hash
- [ ] Journal size bounded (compaction verified)
- [ ] Concurrent local tabs serialize through one writer
EOF
)"

mk_issue "P2-02 Maturity gate: tool-catalog.json enforcement in CI" "hardening,P2,high" "$(cat <<'EOF'
**Evidence:** MASTER_TOOL_CATALOG.md statuses are documentation; nothing fails when claims and tests drift.

**Tasks**
- [ ] `documentation/tool-catalog.json` (id, name, status, tests[], verifiedScenarios[], knownLimitation)
- [ ] `scripts/check-tool-catalog.mjs`: every UI command id catalogued; tested/runtime-verified require test files; partial requires limitation text
- [ ] Generate markdown catalog from JSON (single source of truth)
- [ ] CI on push + PR; migrate existing catalog content

**Acceptance criteria**
- [ ] Uncatalogued command (test branch) fails CI
- [ ] Removed test file of a tested tool fails CI
- [ ] Markdown catalog generated, not hand-edited
EOF
)"

mk_issue "P2-03 Performance budget benchmark + CI gate" "hardening,P2,medium" "$(cat <<'EOF'
**Evidence (BASELINE):** "GPU minimum specs (not measured yet)"; tests cannot prove large-model performance.

**Tasks**
- [ ] `scripts/bench-large-model.mjs`: headless import of 50-100 MB reference IFC (checksum-committed or synthetic); wall time + peak heap
- [ ] `scripts/budget.json`: import <= 60 s, peak <= 1500 MB, main bundle <= 2500 KB, e2e smoke <= 180 s
- [ ] check-budget.mjs gate on release candidates
- [ ] Tighten only after 3 green runs; loosening needs an issue

**Acceptance criteria**
- [ ] Benchmark runs in CI with JSON artifact
- [ ] Synthetic 2x slowdown (test branch) fails the gate
EOF
)"

mk_issue "P2-04 Nightly parser fuzzing loop" "hardening,P2,medium" "$(cat <<'EOF'
**Depends on:** P1-06 controlled-failure contract.

**Tasks**
- [ ] `scripts/fuzz-ifc.mjs` (+ BCF/DXF variants): deterministic byte mutations of golden corpus; disposable workers, hard timeouts
- [ ] Allowed outcomes: ok or typed-error; hang/OOM/crash exits 1 (release blocker)
- [ ] Nightly GitHub Actions workflow; failing inputs uploaded as artifacts
- [ ] Minimized failing inputs become corpus fixtures

**Acceptance criteria**
- [ ] 500 mutations per parser per night, all controlled
- [ ] Injected hang (test branch) fails the run
- [ ] >= 1 real edge case converted to fixture in first month
EOF
)"

mk_issue "P2-05 Spec-before-code process + SPEC_TEMPLATE.md" "hardening,P2,medium,process" "$(cat <<'EOF'
With AI-assisted development the bottleneck is defining correct, not writing code.

**Tasks**
- [ ] `documentation/SPEC_TEMPLATE.md`: problem, scope, numbered acceptance criteria, fixture matrix, failure modes, catalog target + test files
- [ ] Every new-tool PR links a spec (social enforcement first, P2-02 gate later)
- [ ] Two retroactive specs for in-flight tools to validate the template
- [ ] CONTRIBUTING.md: no feature PR without spec; bugs get failing-test-first

**Acceptance criteria**
- [ ] Template + two example specs merged
- [ ] Next 5 feature PRs link specs (tracked in PR descriptions)
EOF
)"

mk_issue "P2-06 Surface per-entity IFC interop report in the UI" "hardening,P2,medium" "$(cat <<'EOF'
**Evidence (BASELINE):** "IFC: No per-entity interop report yet." **Depends on:** P1-04.

**Tasks**
- [ ] In-app entity-level report after each IFC export (classes exported, skipped by subset, pset coverage)
- [ ] "What this export contains" summary dialog + per-class detail table
- [ ] Report downloadable alongside the IFC file
- [ ] Tool Catalog IFC-export entry links the report

**Acceptance criteria**
- [ ] Any export offers the per-entity report without extra tooling
- [ ] Unsupported IFC classes listed explicitly (never a silent subset)
EOF
)"

echo
echo "Done. Review issues at: https://github.com/$REPO/issues"
