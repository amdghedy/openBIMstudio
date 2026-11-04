# Changelog

All notable changes to OpenBIMStudio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) informally while the project is in 0.x
(pre-1.0, breaking changes may land in minor releases).

Versions before 0.73.0 are summarized by the commit history and the milestone
verification scripts (`npm run verify:v50` … `verify:v67`) rather than this
file — the project adopted a written changelog at 0.73.0.

## [Unreleased]

### Added

- Revit-style section box face arrows: each of the six crop faces now carries
  a double-headed drag arrow pointing along its face normal, next to the
  translucent drag quad. Grabbing the arrow (or the quad) stretches or
  shrinks that face live; hovering highlights the face. Arrow orientation is
  pinned by unit tests (every face rotation must map local +Z onto the
  outward normal) alongside new pure helpers `faceNormal`, `faceCenter`,
  `ARROW_SPEC` in `section-box-math.ts`.
- Region-profile service (`src/core/region.ts`): 20 country profiles unifying
  language, units, currency, paper sizes, date formats and standards packs;
  wired into Settings as a single "Region profile" control with browser
  auto-detection on first run (PR #137).
- Fourteen locale catalogs (fr, es, pt-BR, it, zh-TW, ko, ru, tr, pl, nl, hi,
  he, fa, ur) bringing the UI to 19 languages.
- GCC standards pack (`src/modules/standards/rules/packs/gcc.ts`): UAE FSC
  2018 fire rules, SBC 201 egress rules, Dubai Build accessibility rules and
  USSC issue categories, registered in the built-in rule-pack index.

### Changed

- Repository governance: squash-only merges with branch auto-deletion,
  linear-history branch protection on `main`, required CI status checks,
  Discussions enabled, curated issue backlog (#140–#144), stale branches
  pruned.
- Repository hygiene pass: disabled one-shot recovery workflows removed;
  23 single-use fix/repair scripts moved to `scripts/archive/`; test fixtures
  consolidated under `tests/`; README de-duplicated (release notes now live
  here); CONTRIBUTING rewritten with the actual workflow, commit conventions
  and AI-assistance policy.

### Fixed

- `.gitignore` no longer excludes the golden IFC corpus
  (`tests/fixtures/ifc-corpus/`), whose sources had been silently kept out of
  version control — leaving the golden-roundtrip CI gate running against an
  empty corpus (0 files). The corpus folder is documented in its README; see
  `docs/engineering/ISSUES.md` (P1-03) for the rebuild plan.

## [0.74.0] — 2026-11

### Added

- Cursor-accurate wheel zoom with a guaranteed orientation invariant: zooming
  never rotates the camera (`tests/wheel-zoom-orientation.test.cjs`,
  `tests/cursor-zoom.test.cjs`).
- Full Content-Security-Policy with a self-hosted Fragments worker
  (`docs/CSP.md`).
- Trimble point-cloud import assistant: real LAS (1.0–1.4, RGB) and PTX
  parsers with survey-coordinate recentering; explicit guidance for
  proprietary formats (.rwcx, .rcp, .rcs, .fls, LAZ, E57).
- Point-cloud management actions; contextual `Modify | <Category>` tabs;
  multi-element dimension editing; Flip and one-undo batch edits.

### Changed

- AutoCAD-style CAD shell ribbon (tabs above, panels below, drawing tabs under
  the ribbon); Revit-style contextual placement tabs with a real options bar
  (level, dimensions, location line, join, chain, offset, justification,
  slope) for every placement tool.

## [0.73.0]

> Earlier release — exact date not tracked here; see the commit history.

### Added

- Justification-aware wall & MEP modeling with magnetic snapping and
  persistent snap relationships (`tests/magnet.test.cjs`,
  `tests/linear-follow.test.cjs`).
- Dependent-geometry updates applied in a single undo step
  (`tests/boundary-edit.test.cjs`).
- Dynamic per-tool property panels and stronger family/parametric workflows
  (`tests/v73-just`, `v73-mag`, `v73-panels`, `v73-rel` suites).

[Unreleased]: https://github.com/amdghedy/openBIMstudio/commits/main
[0.74.0]: https://github.com/amdghedy/openBIMstudio/releases
[0.73.0]: https://github.com/amdghedy/openBIMstudio/commits/main
