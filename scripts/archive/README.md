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
