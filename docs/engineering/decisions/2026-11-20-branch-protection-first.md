# Decision: branch protection on `main` comes first (#142)

**Decided:** 2026-11-20 (P0 hardening deep dive + hardening plan item 1).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## Decision

Enable branch protection on `main` **before** relying on any other control in
the hardening plan. It is a five-minute Settings change with zero code risk,
and it underpins every other fix: without it, CI gates, required checks, and
review requirements are unenforceable — including PR #240's own condition,
"stays open until CI is green and a reviewer accepts the inventory".

## Evidence (2026-11-20)

- The P0 dive ranked #142 first of the four P0s for exactly this reason, and
  documented the failure modes concretely: direct push to `main`, force-push /
  history rewrite, merging red, and silent drift between policy and
  enforcement (`~/workspace/openBIMstudio-p0-hardening.md` §1 — read-only
  reference, not copied here).
- `main` had gone red repeatedly in the two days before the dive (commits #241
  "fix(ci): main red", #238, `fa99c9c` "typecheck red on main") — the symptom
  branch protection exists to prevent.
- Three sources in the repo asserted the P0s were done while the tracker said
  they were not: `docs/engineering/ISSUES.md` listed P0-03/P0-04 "satisfied",
  the CHANGELOG claimed linear-history branch protection, and
  `.github/workflows/rvt-build.yml:35` assumed "main is protected". The dive's
  first fix was to make tracker, docs, and settings agree with evidence.

## The defect in the issue itself (do not apply #142 verbatim)

The required checks #142 names — "Unit tests", "golden-roundtrip",
"native-bim-validation" — **do not exist as CI job names**. The CI workflow
(`.github/workflows/unit-tests.yml`) has exactly two jobs: `quality`, named
"Build and quality checks", and `browser-smoke`, named "Browser smoke
(blocking, Chromium)". Enabling protection with #142's list verbatim would
make **no PR ever mergeable** — GitHub would wait forever for checks that
never report. The checklist must be corrected to the real job names before the
rule is created. (The advisory cross-browser workflow is `continue-on-error`
and must not be required.)

## Status (re-verified 2026-11-21)

- **#142 is still OPEN** (verified against the live tracker 2026-11-21).
- Branch protection is a GitHub Settings state: no file in the repo can
  enforce it or prove it. The check is
  `gh api repos/amdghedy/openBIMstudio/branches/main/protection`, or
  Settings → Branches → the `main` rule.
- The premature CHANGELOG claim has been corrected since the dive: the
  governance line in `CHANGELOG.md` now reads "Branch protection on `main`
  and required CI status checks are not yet enabled (tracked in #142)".
- The runbook (`docs/engineering/RUNBOOK.md` §6) records the same check and
  the same warning about the stale check names.

## What would change this decision

Nothing short of the rule existing with evidence attached to #142 (the
protection JSON or a screenshot, plus the corrected check names) and #142
closed on that evidence. If the rule is created with different checks than the
two real jobs, this note and the runbook must be amended to say which, and why.
