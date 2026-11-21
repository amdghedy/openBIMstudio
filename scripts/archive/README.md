# Archived one-shot scripts

These scripts were single-use maintenance tools: they patched specific files at
specific points in history (a `fix-*`, `repair-*`, `apply-*` or version-numbered
hardening pass). They have all been applied and are kept for provenance only.

**Do not run them against the current tree.** They anchor on file contents that
have since changed; running an old patch again can silently corrupt unrelated
code. Everything they did is already part of `main` and covered by the test
suite (`npm run typecheck` + `node scripts/ci-unit-tests.mjs`).

If you need to know what one of them changed, read the file here or find the
commit that introduced it — the scripts are self-documenting about their intent.

## Retired verify gates (2026-11-21)

`verify-v50.mjs` … `verify-v67.mjs` were retired here — see
`docs/PROCESS_SURFACE.md` §2 for the per-gate census (result on live
`main`, failure class, disposition). They are milestone acceptance
checks that nothing executed; 14 of the 18 failed on current `main`
(stale assertions or broken harness invocations) without anyone
noticing. `verify-v68.mjs` and `verify-v70`–`v73.mjs` remain live in
`scripts/` and run via `scripts/ci-unit-tests.mjs` — do not move them
here. Do not run the archived gates against the current tree: most
fail on current `main`, which is why they were retired.
