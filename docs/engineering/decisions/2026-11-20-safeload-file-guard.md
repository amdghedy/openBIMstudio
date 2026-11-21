# Decision: every file-load boundary goes through a shared guard (#90)

**Decided:** 2026-11-20 (P0 hardening deep dive + hardening plan item 3).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## Decision

No untrusted payload reaches a parser before validation. JSON boundaries go
through `safeLoad` (size limit, iterative complexity walk, schema); non-JSON
boundaries go through the shared pre-parse file guard (size, signature, ZIP
audit, XML entity ban, LAS header). The coverage audit must catch the escapes,
not just the easy cases — including `JSON.parse` inside `.then()` chains — and
a failed load must leave the current project unchanged, proven at runtime, not
asserted in an inventory.

## Evidence (2026-11-20)

- The P0 dive (§4) verified the JSON core is good: `src/core/safeLoad.ts`
  (8 MB default cap, max depth 64, max 250,000 nodes, typed `LoadError`) with
  seven wired boundaries, inventoried in
  `docs/engineering/FILE-IMPORT-BOUNDARIES.md` and audited in CI by
  `scripts/check-safe-load-coverage.mjs`.
- The concrete escape: `src/features/cad-viewer.ts:13215` loaded a user-chosen
  `.markups.json` via a `.then()` chain with no size limit, schema, or depth
  guard, invisible to the audit because the parse was not after an `await`
  assignment. A hostile or corrupt file could hang the tab or corrupt state —
  the same failure shape as #231, on a different boundary.
- The non-JSON guard did not exist on `main` at the dive: PR #240
  ("fix(security): shared pre-parse file guard for all non-JSON import
  boundaries", 31 tests, updated inventory) was written, open, and unmerged,
  with the honest caveat that its ordering proof is static, not a browser
  runtime test.

## Status (re-verified 2026-11-21)

- **PR #240 is merged:** `52e0ef01` ("fix(security): shared pre-parse file
  guard for all non-JSON import boundaries (refs #90) (#240)") is on `main`,
  verified via the GitHub API (`merged: true`, state closed). `src/core/file-guard.ts`
  exists on `main`.
- **The markups escape is closed:** `1906e79` routes the cad-viewer markups
  loader through `safeLoad` and extends the coverage audit to `.then()`-chain
  parses (19/19 `test:safe-load`, 8/8 `test:safe-load-audit`, build clean —
  verified on landing, 2026-11-21).
- **Not verified in this item:** the runtime test the issue asks for — opening
  a malformed file in a browser test and asserting the current project is
  byte-identical afterwards. Evidence link TBD; do not claim #90 closed on
  the merged PR plus the markups fix alone.
- **Tracker state unverified:** the unauthenticated GitHub API rate-limited
  when reading issue #90 on 2026-11-21. Evidence link TBD.

## What would change this decision

#90 closes only on its own acceptance criteria: the boundary inventory maps
every entry point to its schema and tests, valid/malformed/oversized/adversarial
inputs are tested per format, no untrusted payload reaches a parser before
validation, and CI runs the tests as a required check — plus the runtime
unchanged-project test above. A follow-up note should record the long-tail
triage of the remaining file/network/peer `JSON.parse` sites (GeoJSON import,
SSE payloads, journal replay, schedule import, agent-bridge orders, server PUT
bodies) as each is guarded or explicitly ruled not-a-boundary.
