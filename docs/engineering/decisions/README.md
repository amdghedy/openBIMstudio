# Decision notes

Short, dated records of the consequential decisions behind this project — what
was decided, on what evidence, and what would change it. Each note is a
starting point, not a verdict: if the evidence changes, the note gets a dated
amendment, not a silent edit.

The hardening plan (§21) asked for these notes to start with the P0 decisions
and the #231 fuzz gate. The P0 dive ranked **four** P0s, so there are four P0
notes here, plus the fuzz gate — five notes, not three.

| Note | Decided | Status as of 2026-11-21 (`main` `bb0f55c`) |
|---|---|---|
| [Branch protection first (#142)](2026-11-20-branch-protection-first.md) | 2026-11-20 | OPEN — verified against the live tracker |
| [Backup-on-load (#91)](2026-11-20-backup-on-load.md) | 2026-11-20 | Fix landed (`e8e5afb`); tracker closure unverified |
| [Fail-closed server (#92)](2026-11-20-fail-closed-server.md) | 2026-11-20 | Residual SSE-token gap still present in code |
| [safeLoad / file guard (#90)](2026-11-20-safeload-file-guard.md) | 2026-11-20 | PR #240 merged (`52e0ef01`); markups fix landed |
| [IFC fuzz containment gate (#231)](2026-11-20-ifc-fuzz-containment-gate.md) | 2026-11-20 | Gate wired; post-fix timeout rate unproven |
| [AI attribution policy rewritten](2026-11-21-ai-attribution-policy.md) | 2026-11-21 | Policy now matches audited history (358 Claude-authored commits) |
| [Installer-patch mechanism retired](2026-11-21-installer-patch-retired.md) | 2026-11-21 | Retired in the same change that adds this index |
| [Canonical element store](2026-11-26-canonical-element-store.md) | 2026-11-26 | PROPOSAL — Phase 1 single-source-of-truth design, pending review |
| [Parametric engine consolidation](2026-11-26-parametric-engine-consolidation.md) | 2026-11-26 | PROPOSAL — four layers kept, parametric-regen folds in, pending validation |

**Convention:** a note records the decision date (when the decision was made),
the evidence available then, and a "Status" section re-verified at the time the
note was written. Where the live tracker could not be read from here
(unauthenticated GitHub API rate-limited 2026-11-21), the note says so and
marks the closure evidence "link TBD" rather than inventing it.
