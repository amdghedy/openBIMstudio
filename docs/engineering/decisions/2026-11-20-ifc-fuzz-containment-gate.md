# Decision: the IFC fuzz gate is containment, not robustness (#231)

**Decided:** 2026-11-20 (IFC fuzz deep dive).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## Decision

A malformed IFC file must not hang the tab. The defence is two layers: a
structural pre-flight in the browser before `web-ifc` ever sees the bytes, and
a nightly fuzz gate that fails the build only when the parser's failure rates
exceed containment thresholds — not on any single failure. The thresholds are
deliberately loose: this gate proves the parser stays *contained*, not that it
is *robust*. Do not describe a green fuzz run as "the parser is robust".

## Evidence (2026-11-20)

- The fuzz dive found the hang fix **is** wired in via
  `src/modules/ifc-semantics/step-preflight.ts`, called before `web-ifc`.
  Re-verified 2026-11-21: `src/features/importer.ts:1` imports
  `preflightStep` from `../modules/ifc-semantics/step-preflight` and calls it
  at line 1198 before parsing.
- The gate thresholds in `scripts/fuzz-ifc-corpus.mjs` (re-read 2026-11-21,
  lines 37–46, 214–218):
  - parser timeout rate exceeds **30%** → fail (`TIMEOUT_RATE_MAX = 0.3`,
    child timeout 40 s, `FUZZ_CHILD_TIMEOUT_MS` override);
  - contained-crash rate exceeds **35%** → fail (`CRASH_RATE_MAX = 0.35`);
  - startup timeout rate exceeds **1%** → fail
    (`STARTUP_TIMEOUT_RATE_MAX = 0.01`, init timeout 30 s,
    `FUZZ_INIT_TIMEOUT_MS` override).
- The gate runs nightly (`.github/workflows/nightly-fuzz.yml`, 60-minute
  timeout) and as `npm run test:fuzz-ifc`.
- The dive's residual gaps, recorded here so they are not forgotten: no parse
  timeout in the browser import itself, pre-flight is structural only (it
  cannot catch semantic hangs), the golden corpus was 9 files against a
  target of 20, and the `.ifczip` path was unverified.

## Status (re-verified 2026-11-21)

- The pre-flight call and the three thresholds are present on `main` exactly
  as decided.
- **Post-fix timeout rate unproven:** the dive's headline open question —
  whether the timeout rate actually fell after the fix — still needs a nightly
  run check or a fuzz re-run. A green gate run dated after the fix is the
  evidence; until one exists, the decision's *effect* is unproven even though
  its *mechanism* is wired.
- **Tracker state unverified:** the unauthenticated GitHub API rate-limited
  when reading issue #231 on 2026-11-21. Evidence link TBD.

## What would change this decision

Two things, either of which needs a dated amendment to this note, not a
silent threshold edit: (1) the corpus reaching its 20-file target or the
`.ifczip` path being verified, which would justify tightening the thresholds;
(2) a fuzz run showing the post-fix timeout rate, which either confirms the
containment claim or reopens the parser-robustness work. Tightening the gate
to "robustness" numbers (single-digit timeouts) without that evidence would
turn the nightly run red for the wrong reason.
