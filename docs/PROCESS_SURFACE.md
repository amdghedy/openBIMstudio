# Process surface — gate retirement policy + docs-freshness rule

Why this doc exists: the repo accumulates one-shot verification scripts
and numbers-bearing docs faster than anyone retires them. Unwatched
gates that fail on `main` are worse than no gates (they teach everyone
to ignore failures), and undated numbers rot silently (the 14 Nov 2026
perf numbers were still gating releases weeks later). This doc is the
single place that records what was retired, why, and how often each
number-bearing doc must be re-checked.

## 1. Retirement policy (verify gates + one-shot scripts)

**Rule 1 — nothing runs that nothing runs.** A gate is live only if
some enforced runner executes it (CI workflow step, `ci-unit-tests.mjs`,
or a documented release checklist). A script referenced only by a
commented-out workflow line or by its own doc is not live, whatever the
doc claims. The `verify-v70.mjs` case is the cautionary example: its
"CI wiring" check greps the workflow file for the string `verify:v70`,
and the workflow contains that string — as a comment. The check passed
while the workflow never executed it. (The gate was in fact executed
elsewhere — see §2 — which is why the check was fixed to grep the real
runner instead of deleted with the gate.)

**Rule 2 — retire by moving, never by deleting.** Retired gates move to
`scripts/archive/` (provenance, reversible). The move keeps the file
byte-identical; only the `package.json` script entry and the doc claims
change. Deletion destroys the only record of what the milestone
asserted. `scripts/archive/README.md` is the archive's policy; this
doc is the retirement log.

**Rule 3 — retirement needs evidence, per gate.** Before a move,
record for each gate: result on current `main` (pass/fail + the failing
checks), the failure class (stale assertion / broken harness / live
alarm), and the disposition. A gate whose failure is a **live alarm**
(a real suite test failing underneath it) is NOT retired — the
underlying failure is fixed first, or the gate stays and is escalated.
Every gate retired on 2026-11-21 passed this test: the six suite tests
underlying the test-execution failures (`hip-roof`, `hatch-patterns`,
`stair-winder-spiral`, `rebar`, `v40-modules`,
`scope-box-section-box-crop`) all pass standalone (13/13, 14/14, 13/13,
21/21, 36/36, 15/15) — the gates failed on their own harness
(`npx tsc` in a temp dir with no local TypeScript), not on the code.

**Rule 4 — a build/test check follows every retirement.** After the
move: `tsc --noEmit`, `npm run build`, and every test touching a moved
or edited file must pass. The retirement PR records the results.

**Rule 5 — no new verify gates.** New milestone checks go in the real
test suite (`tests/*.test.cjs`, wired into `scripts/ci-unit-tests.mjs`)
or in the bench gate (`bench/check-budgets.mjs`). Do not add another
`scripts/verify-*.mjs`.

## 2. Retirement log — `verify-v*.mjs` gates, 2026-11-21 (item 22)

Base: `bb0f55c`. All 23 gates (`v50`–`v73`; no `v69` file ever
existed) were run fresh on live `main` by hand. The census corrected
itself once: an early grep for `verify-v` (hyphen) missed the
`verify:vXX` (colon) entries in `scripts/ci-unit-tests.mjs`, which
made the first draft of this log wrongly claim nothing runs any gate.
The truth is split — **five gates are live, eighteen are dead:**

- **Live, kept (5): `v68`, `v70`, `v71`, `v72`, `v73`.** They are
  executed on every CI run via the batched runner
  (`scripts/ci-unit-tests.mjs`, last line of the script list), and all
  five pass on `bb0f55c` (44/44, 33/33, 77/77, 39/39, 43/43). They
  are not retired. Their "CI wiring" checks were fixed in the same
  change where they grepped the workflow file for their own names —
  the workflow carries those names only as comments
  (`.github/workflows/unit-tests.yml:108–118`) — to grep the batch
  runner instead, which is the real wiring (`v70`, `v71`, `v72`;
  `v73` already accepted the batch leg, `v68` never grepped the
  workflow). The docs' "wired into CI" claims for these five are true
  (via the batch runner, not via workflow steps) and were left alone
  except where the wording named the workflow file
  (`DEEP_MODELING_V70.md`, `MODELING_PANEL_V73.md` — reworded to the
  batch runner).
- **Dead, retired (18): `v50`–`v67`.** None is listed in
  `scripts/ci-unit-tests.mjs`, no workflow step runs them, and the
  only workflow mentions are comments. Fourteen fail on live `main`
  and nobody noticed, because nothing runs them. Moved to
  `scripts/archive/verify-vXX.mjs`; `package.json` `verify:*` scripts
  for them removed. (Two files, `v51` and `v53`, never had a
  `package.json` script at all — only the file existed.)

| Gate | Result on `bb0f55c` | Failing checks (failure class) | Disposition |
|---|---|---|---|
| v50 | FAIL | middle-button plan pan; release version (stale shape/version assertions) | Retired |
| v51 | FAIL | replace-existing preserves placement; cached FRAG integrity hash; cached FRAG reopen verification (stale shape assertions) | Retired |
| v52 | FAIL, 2/12 | dimension references require model boundaries; linked model plan edges can be dimensioned (stale shape assertions) | Retired |
| v53 | FAIL, 1/6 | renderer fallback retained (stale — the fallback was removed) | Retired |
| v54 | FAIL | Cube face uses exact cardinal camera commands (stale shape assertion) | Retired |
| v55 | PASS, 52/52 | — | Retired (unwatched; shape greps duplicate the real suite) |
| v56 | PASS, 45/45 | — | Retired (as v55) |
| v57 | PASS, 8/8 | — | Retired (as v55) |
| v58 | PASS, 62/62 | — | Retired (as v55) |
| v59 | FAIL, 1/32 | Hip roof tests failed (broken harness — `tests/hip-roof.test.cjs` passes standalone, 13/13) | Retired |
| v60 | FAIL, 2/49 | Hatch pattern tests failed (broken harness — `tests/hatch-patterns.test.cjs` passes standalone, 14/14); v59 inherited | Retired |
| v61 | FAIL, 2/13 | Own checks 11/11 pass; v59 + v60 inherited (chained gate — re-runs all predecessors) | Retired |
| v62 | FAIL (own 8/8 pass) | v59 + v60 inherited; run killed mid-chain per the one-retry rule, exit unrecorded | Retired |
| v63 | FAIL | Own checks 33/33 pass; stair tests failed (broken harness — `tests/stair-winder-spiral.test.cjs` passes standalone, 13/13); v59–v61 inherited | Retired |
| v64 | FAIL | version 0.64 pin (stale — version is 0.74+); rebar tests failed (broken harness — `tests/rebar.test.cjs` passes standalone, 21/21); v59–v61 inherited | Retired |
| v65 | FAIL, 2/39 | v40 module tests failed (broken harness — `npx tsc` with no local TypeScript; `tests/v40-modules.test.cjs` passes standalone, 36/36) | Retired |
| v66 | FAIL, 2/26 | view-crop tests failed; v40 module tests failed (broken harness — `npx tsc`; `tests/scope-box-section-box-crop.test.cjs` passes standalone, 15/15) | Retired |
| v67 | FAIL, 2/28 | version 0.67 pin (stale); CI wiring pattern not found in workflow (stale grep) | Retired |

Structural notes: `v61`–`v65` are chained gates — each re-runs all
predecessors via `execSync`, so one stale predecessor fails the whole
chain and total runtime grows quadratically (a full `v61`–`v65` sweep
exceeds 5 minutes on this VM, which is why the first sweep was killed
and the later gates were assessed from their own-check sections). The
chain also has ad-hoc skip logic (`v65` skips the `v64` regression
check "version bumped to 0.65"). The live gates do **not** chain-run
any retired gate (verified: no `execSync` of a `verify-v*` script in
`v68`/`v70`–`v73`), so the move cannot break them — confirmed by
re-running all five after the move (see the retirement PR description).
None of this is a substitute for the test suite, which is why the dead
gates retire as a set rather than one by one.

Doc pointers updated in the same change (live docs only; dated
snapshots such as `docs/engineering/BASELINE.md` and
`docs/BIM_AUTHORING_REVIEW_V67.md` are historical records and were
left untouched per §4): `README.md` ("Per-version milestone checks"
now names the five live gates), `documentation/DEVELOPER_GUIDE.md`
and `documentation/MASTER_TOOL_CATALOG.md` (retired `v50`/`v52`/`v54`
examples replaced with live gates), `docs/DEEP_MODELING_V70.md` and
`docs/MODELING_PANEL_V73.md` ("wired into the workflow" → "wired into
the CI batch runner"), `docs/PARAMETRIC_ENGINE.md` ("extend
`verify-v54.mjs`" → assert in the real test suite), `docs/ARCHITECTURE.md`
(gates as a live generation → partial retirement noted),
`CHANGELOG.md` (pre-0.73.0 summary pointer notes the archive move).
The commented workflow lines (`# npm run verify:v70` etc.) are left
untouched: they are inert, and removing them is a separate cleanup —
but they must not be read as wiring (Rule 1). `feature-maturity.ts`
evidence strings citing `verify:v68`/`v71`/`v72`/`v73` were left
alone: those gates are live, so the citations are valid.

## 3. `scripts/archive/` policy

- **Append-only provenance.** One-shot fix/repair scripts and retired
  gates live here so history can be read. Nothing in the archive is
  executed by CI, `package.json`, or any other script.
- **Do not run them.** They anchor on file contents that have since
  changed; re-running an old patch can silently corrupt unrelated code
  (see `scripts/archive/README.md`).
- **Do not re-apply them.** Everything they did is part of `main` and
  covered by the test suite.
- **Retirements append here:** move the file, keep it byte-identical,
  log the move in §2 above.

## 4. Docs-freshness rule

**General rule:** any doc containing a number, version, date, test
count, or performance figure must carry its as-of date + commit
(either inline or by the dated-snapshot convention of
`docs/engineering/BASELINE.md`). An undated number is treated as
stale until verified. Never edit a dated snapshot in place — supersede
it with a new dated snapshot.

| Doc | What must stay fresh | How often / trigger |
|---|---|---|
| `bench/BENCHMARKS.md` | All numbers come from a bench run; §9 scale-target table only on a real-hardware run | Every perf PR; §9 only per §9.4 procedure. Item 11's gate enforces ≤ 7-day freshness once landed. |
| `bench/fixtures/manifest.json` + `large-reference.ifc.checksum` | Regenerate on any exporter change | On exporter change. Known drift: checked-in fixtures predate #256 (regeneration adds 8 lines/file from IfcXxxType rows) — re-cut deliberately, not silently. |
| `docs/INTEROPERABILITY_MATRIX.md` | One row per reference-tool validation, with tool + version + date | On every reference-tool pass (items 12/13 process). |
| `CHANGELOG.md`, `docs/ISSUES.md` | Reconciled with the open tracker (counts, issue numbers, P0 status) | Every release, or monthly, whichever first. |
| `docs/engineering/BASELINE.md` | Dated snapshot (2026-10-26, v0.73.0) — historical, do not edit in place | Supersede with a new dated baseline per program phase. |
| `README.md` | Version badge, maturity counts (9 verified / 30 limited / 10 experimental / 0 planned after item 22) | Every version bump. BASELINE already caught a stale badge once (0.66.2 vs 0.73.0). |
| `src/features/feature-maturity.ts` | Each entry's status + evidence + limitations match the code and tests | Every feature PR that changes maturity; `tests/feature-registry.test.cjs` enforces the shape rules. |
| i18n catalogues (`src/locales/*`) | Regenerate via the restored generator (item 14) on string changes | On string changes; stale catalogues were a full dive finding. |
| This doc (§2) | Retirement log | On every retirement. |

**Known stale pointers (observed 2026-11-21, not fixed here):**
- `docs/engineering/BASELINE.md` §5 points at `docs/PERFORMANCE.md`
  ("budgets defined in docs/PERFORMANCE.md, Phase 6 deliverable") —
  that file does not exist; budgets live in `bench/BENCHMARKS.md` +
  `scripts/budget.json`. Fix by updating the pointer, not by creating
  a duplicate budget doc.
- `bench/BENCHMARKS.md` §1 prose says fragments scene load is
  "~2–3 ms per element"; its own table says 692 ms / 2,036 elements
  (~0.34 ms/element). The table is the measured value; §9.3 relies on
  the table, not the prose.
