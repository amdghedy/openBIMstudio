# Contributing to OpenBIMStudio

Thank you for considering contributing. If this project helps you, please [⭐ star the repository](https://github.com/amdghedy/openBIMstudio) so others can find it.

Thank you for considering contributing. This guide describes the workflow the
maintainers actually use — following it keeps review fast and the history
readable.

## Where to start

1. Run the project locally (see [Quick start](./README.md#quick-start) in the README).
2. Read the [Developer Guide](documentation/DEVELOPER_GUIDE.md) and the
   [documentation index](docs/README.md).
3. Pick a task from the gap analyses in `docs/` or an open issue. For anything
   substantial, open an issue first and agree the design and validation
   strategy before writing code.

## Development setup

Requirements: Node.js 18+ (CI runs 22), npm.

```bash
git clone https://github.com/amdghedy/openBIMstudio.git
cd openBIMstudio
npm install                           # peer-dep behavior via .npmrc
git config core.hooksPath .githooks   # enables the repo's pre-commit hook
npm run dev                           # http://localhost:3000
```

The pre-commit hook (`.githooks/pre-commit`) rejects commits containing
mojibake (UTF-8 read as CP1252) — a real failure mode in this codebase's past.
Without `core.hooksPath` it never runs, which is why wiring it is part of
setup, not an optional extra.

## Branches and commits

- Branch from `main`; name branches by intent:
  `fix/<topic>`, `feature/<topic>`, `refactor/<topic>`, `docs/<topic>`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for the
  subject line: `type(scope): imperative summary`, e.g.
  `fix(cad): keep big real-world DWGs from blowing the 120s parser timeout`.
  The scope is the subsystem (`mep`, `cad`, `viewcube`, `ui`, `dock`, `tests`, …).
- One logical change per commit. The body (when needed) explains *why*, not
  *what* — the diff already shows what.
- Do not commit generated artifacts, credentials, or private model files (see
  `.gitignore` and [SECURITY.md](SECURITY.md)).

## Engineering-first change policy

- Start substantial work with a short specification: problem, scope, non-goals, units/coordinates, acceptance criteria and failure cases.
- Trace the existing domain owner, callers, event lifecycle and persistence path before implementing. Reuse the current engine; do not add a parallel implementation without an architecture decision.
- For a bug, reproduce it and add a failing regression test before changing production code. For a feature, add deterministic domain tests and realistic fixtures alongside the implementation.
- Keep each PR focused. Separate UI adapters, domain logic, persistence and file-format adapters according to the [Engineering Architecture Map](docs/engineering/ARCHITECTURE.md).
- Never make a test green by raising a baseline or weakening an assertion unless the changed contract is independently justified, reviewed and the remaining debt is recorded.
- Do not describe a feature as complete because its UI exists or a mock passes. Update the feature maturity registry with evidence and known limitations.
- Do not merge on typecheck alone: run focused tests, relevant integration/round-trip checks, and browser acceptance tests for important user workflows.

## AI-assisted contributions

AI tooling may be used for drafting, refactors and test scaffolding. The
contributor remains responsible for the result:

- **You are the author.** Commits carry your own git identity; do not attach
  auto-generated attribution trailers or push commits authored by the tool.
- Review every line as if you wrote it, run the checks below, and be able to
  defend the design in review.
- If AI generated a substantial portion of the change, say so in the PR
  description — it changes what reviewers should focus on.

## What to run before opening a PR

Run what is relevant — CI (`node scripts/ci-unit-tests.mjs`) runs the full
98-suite batch:

```bash
npm run typecheck                # always
node tests/run-tests.mjs         # BIM gap battery
node scripts/ci-unit-tests.mjs   # full suite (required for broad changes)
npm run build                    # required for anything touching build/CSP
npm run test:native-bim          # native BIM validation checks
```

New logic comes with a test in `tests/` wired into `scripts/ci-unit-tests.mjs`;
new user-facing commands are added to the
[Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) with an honest
maturity level (source code ≠ validated workflow). Keep the app
crash-contained: use the `safe()` wrappers rather than letting errors escape.

## Pull requests

Open a PR against `main` using the template: what changed, why, the linked
issue, and which checks you ran. Keep PRs reviewable — a focused 300-line PR
merges faster than a 5,000-line one.

## Reporting bugs

Open a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) with title,
reproduction steps, and browser console output (look for
`[critical-gaps-boot]` entries). Include the browser, OS and, for import
issues, a minimal file that reproduces it — or the smallest anonymized
fragment of one.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
