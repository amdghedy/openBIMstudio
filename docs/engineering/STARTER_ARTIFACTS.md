# openBIMstudio — Starter Artifacts

Ready-to-drop starter code for the Production Hardening Plan. Every file here is the
exact code listing from the plan document (`openBIMstudio_Production_Hardening_Plan.docx`,
Chapter 10, Table 12), extracted so nothing needs copying out of the document by hand.

## How to use

1. Copy files into the repository root preserving the folder structure
   (`src/`, `server/`, `scripts/`, `tests/`, `documentation/`, `.github/workflows/`).
2. Adapt names, imports, and store APIs to the real codebase — these are
   **starter implementations**: correct in shape and contract, not drop-in-and-forget.
3. Work in the plan's order: Phase 0 files first (crashLog, safeLoad, backup,
   failClosed), then Phase 1 (registry, strict config, round-trip, properties, E2E),
   then Phase 2 (journal, catalog gate, budgets, fuzzing, spec template).

## File index (matches Table 12 of the plan)

| File | Target repo path | Phase | Listing |
|------|------------------|-------|---------|
| crashLog.ts | src/core/crashLog.ts | 0 | 1 |
| AppErrorBoundary.tsx | src/shell/AppErrorBoundary.tsx (+ main.tsx wiring comment) | 0 | 2 |
| safeLoad.ts | src/core/safeLoad.ts | 0 | 3 |
| backup.ts | src/core/backup.ts (browser build: OPFS equivalent) | 0 | 4 |
| failClosed.ts | server/middleware/failClosed.ts | 0 | 5 |
| hardening.eslintrc.json | merge into existing .eslintrc (freeze on `__obs*`, no-explicit-any) | 1 | 6 |
| registry.ts | src/core/registry.ts | 1 | 7 |
| tsconfig.strict.json | tsconfig.strict.json | 1 | 8 |
| golden-roundtrip.mjs | scripts/golden-roundtrip.mjs (+ src/core/interop/diff.ts to implement) | 1 | 9 |
| golden-roundtrip.yml | .github/workflows/golden-roundtrip.yml | 1 | 10 |
| undo-invariant.test.ts | tests/property/undo-invariant.test.ts (+ tests/helpers/testEngine) | 1 | 11 |
| ifc-rejection.test.ts | tests/property/ifc-rejection.test.ts | 1 | 12 |
| playwright.config.ts | playwright.config.ts | 1 | 13 |
| edit-undo-save.spec.ts | tests/e2e/edit-undo-save.spec.ts | 1 | 14 |
| journal.ts | src/core/journal.ts (+ JournalStore to implement) | 2 | 15 |
| tool-catalog.json | documentation/tool-catalog.json | 2 | 16 |
| check-tool-catalog.mjs | scripts/check-tool-catalog.mjs (+ scanCommandRegistry to implement) | 2 | 17 |
| budget.json | scripts/budget.json (+ bench-large-model.mjs, check-budget.mjs to implement) | 2 | 18 |
| fuzz-ifc.mjs | scripts/fuzz-ifc.mjs | 2 | 19 |
| SPEC_TEMPLATE.md | documentation/SPEC_TEMPLATE.md | 2 | 20 |

## Companion deliverables

- `../openBIMstudio_Production_Hardening_Plan.docx` (+ `.pdf`) — the full plan these
  files belong to, with rationale, acceptance criteria, roadmap, and risks.
- `../github_issues/ISSUES.md` and `../github_issues/create_issues.sh` — the 18-issue
  backlog (P0-01 ... P2-06) that tracks the implementation of these artifacts.

## Notes

- `npm i -D zod fast-check @playwright/test` covers the dependencies used here.
- The ESLint file is named `hardening.eslintrc.json` on purpose: merge its `rules`
  and `overrides` into the project's existing config rather than replacing it.
- Where a listing references a helper that is part of your codebase
  (`scanCommandRegistry`, `JournalStore`, `diffModel`, `testEngine`), the contract it
  must satisfy is described in the corresponding plan section and issue body.

## Wiring status in this repo (2026-11-01)

These starters are **not yet wired into the app** — that is deliberate, and done in
phase order. Until an issue wires a file, the file stays inert:

- `src/core/crashLog.ts` and `src/shell/AppErrorBoundary.tsx` already typecheck clean
  and live under the normal `tsc --noEmit` program (nothing imports them yet).
- `src/core/backup.ts` typechecks clean (Node form; browser/OPFS variant is P0-03).
- `src/core/safeLoad.ts`, `src/core/registry.ts`, `src/core/journal.ts` are excluded
  from `tsc` via `tsconfig.json` `exclude` because they reference contracts that do
  not exist yet (`zod` install, real service types, `JournalStore`). The issue that
  wires each file **removes it from that exclude list** — that removal is the gate.
- `.github/workflows/golden-roundtrip.yml` is `workflow_dispatch`-only until P1-04;
  flip its `on:` to `[push, pull_request, workflow_dispatch]` when `diff.ts` and the
  golden corpus land.
- `tests/property/*`, `tests/e2e/*`, `playwright.config.ts` are inert: the CI unit
  battery (`scripts/ci-unit-tests.mjs`) runs an explicit script allow-list, and the
  typecheck include is `src` only. They activate when P1-05/P1-06/P1-07 wire them.
