# Decision: rewrite the CONTRIBUTING attribution policy to match audited practice

**Decided:** 2026-11-21 (hardening plan item 21).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## The contradiction

`CONTRIBUTING.md` ("AI-assisted contributions") said: "You are the author.
Commits carry your own git identity; do not attach auto-generated attribution
trailers or push commits authored by the tool."

The history said the opposite. Fresh count on `main` `bb0f55c` (1,472 commits),
2026-11-21:

| Identity in the history | Count |
|---|---|
| Author `Claude <noreply@anthropic.com>` | **358** |
| Author `Z User <z@container>` | 128 |
| Author `obs-agent <obs@local>` | 6 |
| Author `qwen.ai[bot]` | 3 |
| `Co-Authored-By: Claude Sonnet 5.5` trailer | 350 commits |
| `Co-authored-by: Claude` trailer | 21 commits |
| `Co-authored-by: Manus` trailer | 12 commits |

The 358 figure matches the single-maintainer dive's count exactly
(2026-11-20, then 1,451 commits). This is not a handful of lapses: roughly a
third of the history carries a tool identity, including the maintainer's own
workflow (354 commits point at one Claude session, per the dive). Both the
policy and the practice could not stand.

## Resolution chosen: rewrite the policy, keep the practice

The policy was rewritten to require honest attribution (tool identity as
author or `Co-Authored-By:` trailer, never re-attributed to a human) and to
keep the accountability rule that was always the policy's real intent: a human
reviews every line, runs the checks, and defends the design.

## Why not the other way (enforce the old policy)?

Enforcing "commits carry your own git identity" would mean rewriting 358+
commits of published history to a human identity — a force-push of the entire
`main` history, breaking every clone, tag, and the deploy pipeline, and
falsifying the audit trail in the process. It would also misdescribe who (or
what) actually wrote the code, which is the opposite of accountability. The
policy was the wrong artefact; the history is the true record, so the policy
changed.

## What did not change

Human responsibility. The rewrite keeps — and sharpens — the rule that the
contributor reviews, tests, and answers for every line, whoever typed it, and
that substantial AI generation is disclosed in the PR description. Attribution
changed; accountability did not.
