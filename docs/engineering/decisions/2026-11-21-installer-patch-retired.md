# Decision: the installer-patch mechanism is retired (not documented as live)

**Decided:** 2026-11-21 (hardening plan item 21).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## The mechanism

`scripts/install-bim-gaps.mjs` (Milestones 1–3) and `scripts/install-m4.mjs`
(M4) were anchor-based patch scripts from when the bim-gaps / M4 packages were
external: copy the package's `src/modules/bim-gaps/` into a checkout, run the
installer, and it injected hook lines into the host tree (markers
`openbim-bim-gaps:v1 / :m2 / :m3`), with originals saved in `.bim-gaps-backup/`.
The hooks it wired were `window.__obsViewExt` (plan/section/elevation view
extensions, `m3-register.ts`), `window.__obsM2Quantities` (cost takeoff rows,
`m2-register.ts`), `window.__obsM2.start` (stair/railing/curtain-wall click
tools, `m2-tools.ts`), and `window.__obsMeshBuilders` (authoring mesh
builders), all reached through `setupBimGaps()` in `bim-gaps-boot.ts`.

## Evidence — the mechanism is dead as a live path (2026-11-21)

1. **No test, no CI.** No test file and no workflow ever runs either script.
   The mechanism's only "proof" was its own `--dry-run` output.
2. **Dry run on current `main` fails 2 of 11 edits and would still inject 8:**
   `node scripts/install-bim-gaps.mjs . --dry-run` reported `NOT PATCHED —
   anchor not found` for the boot hook and the File-menu edit (those were
   wired directly into the tree instead), and `would patch` for the other
   eight — including `native-twin-ifc.ts`, `authoring.ts`, `cost/quantities.ts`,
   `bim-compatibility-bridge.ts`, the plan/section/elevation generators, and
   `pdf.ts`. The injected lines were never executed in this tree.
3. **One of the 8 would break the build.** The native-twin patch
   unconditionally prepends
   `import { newIfcGuid } from "../bim-gaps/ifc-guid";` — but
   `src/modules/export/native-twin-ifc.ts:9` already imports `newIfcGuid` from
   that module, and `guid()` already returns it. A duplicate named import is
   a `SyntaxError: Identifier 'newIfcGuid' has already been declared`
   (verified against Node v24.22.1 on 2026-11-21 with a minimal reproduction).
   Running the installer for real today would break the build it claims to
   install into.
4. **The hooks have no production callers.** Repo-wide search: `__obsViewExt`
   and `__obsM2Quantities` are referenced only by their own register modules,
   the installer script text, and their unit tests (`m2-tools.test.cjs`,
   `m3-register.test.cjs` — which test the hooks in isolation, not the
   installed path). `setupBimGaps()` is defined in `bim-gaps-boot.ts:97` and
   never invoked anywhere; `docs/engineering/BASELINE.md:83` and
   `docs/MODELING_PANEL_V73.md:139` both record it as "registered but never
   invoked". The M2/M3 runtime path is unreachable in production with or
   without the installer.
5. **`install-m4.mjs` is fully superseded in-tree.** Its dry run reported
   "boot already references m4-view-dims-boot — no patch needed"
   (`critical-gaps-boot.ts` calls `setupM4ViewDims()` directly), and its copy
   step would copy the repo's own `src/` onto itself (861 files) when run
   inside the repo it was written to install into.

## Resolution: retire, don't document as live

Both scripts were deleted, and every doc that told users to run them was
updated (`docs/BIM_GAPS_M1.md`, `docs/BIM_GAPS_M2.md`, `docs/RVT_GAPS_M3.md`,
`docs/M4_VIEW_TEMPLATES_AUTO_DIMS.md`, `docs/README.md`, plus the stale
installer comment in `src/critical-gaps-boot.ts`). Documenting the mechanism
as a "real tested step" was rejected: there is no test that proves it, the
dry run proves two anchors are dead, and the native-twin edit proves a real
run breaks the build.

## What this does NOT do

- It does not delete the hooks. `__obsViewExt`, `__obsM2Quantities`,
  `__obsM2`, and `__obsMeshBuilders` remain registered and unit-tested; only
  the installer that was supposed to wire their call sites is gone. (Note:
  `authoring.ts` *does* consult `__obsMeshBuilders` directly for compound
  walls and in `createMesh` — that native wiring stays.)
- It does not make M2/M3 features work. They were unreachable before this
  change and remain unreachable after it. Re-enabling them is a separate
  implementation task: wire the call sites natively (as M4 was), with tests
  that execute the wired path — not an installer run.
- It does not touch `scripts/archive/apply-fixes.mjs`, which references the
  installer as a historical record of a past fix. Archives record the past;
  they are not live paths.

## Verification

`tsc --noEmit`, `npm run build`, `test:ui-honesty`, and the hook suites
(`tests/m2-tools.test.cjs`, `tests/m3-register.test.cjs`) were re-run after the
deletion — see the PR description for results. The deletion changes no runtime
behaviour: the scripts were never imported, executed, or referenced by any
build step, test, or workflow.
