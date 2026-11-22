# Browser IFC import timeout

## Problem

The browser import path (`src/features/importer.ts`, `runTask` and
`convertIfcToFrag`) used to race the web-ifc conversion only against user
cancel. A conversion that made no progress — or that ran far longer than
any legitimate file should — left the import queue wedged on
"converting…" forever: no failure, no recovery, no way for the next queued
file to proceed, and no record anywhere that a bound had been exceeded.
The Node fuzz gate bounds the *parser* (a child killed after a fixed
budget), but it bounds nothing in the tab. This was the residual gap in
issue #231, recorded as such in the fuzz fix's PR description.

## Design

`src/modules/ifc-semantics/import-timeout.ts` (pure, DOM-free) holds the
bounds and the watchdog; the importer wires it to the existing cancel
machinery:

- The watchdog is armed when the conversion starts and re-armed on every
  `progressCallback` invocation. On firing it rejects through the same
  `rejectActive` the Cancel button uses — but with an
  `IfcImportTimeoutError`, and **without** setting `cancelRequested`, so
  the importer's catch classifies the result as a *failure*, never as a
  user cancellation. (The error message deliberately contains no
  "cancel": the catch treats any message containing "cancel" as a
  cancellation.)
- On firing, the importer is disposed (`disposeImporter()`), so the next
  import starts from a fresh `IfcImporter` instead of inheriting the
  timed-out conversion's state.
- The timeout is recorded in the bench phase log
  (`ctx.features.importer.lastImportPhases()`) with `timedOut: true`, so
  the bound shows up in measurements instead of vanishing.
- A conversion abandoned by timeout or cancel may still call back from
  WASM later; the progress callbacks ignore callbacks from an abandoned
  conversion, and a cleared watchdog cannot be re-armed by a late poke.

## Bounds

Grounded in measured conversion times on the reference VM
(`bench/results/browser-after.json`: 0.1 MB → 0.8 s, 0.4 MB → 1.2 s,
2.3 MB / 2,036 elements → 2.5 s — roughly 1 s per MB):

| Bound | Default | Rule |
|---|---|---|
| Stall | 120 s | No `progressCallback` for this long → the conversion is stuck, not slow. Conversion streams chunks continuously, so two silent minutes is a hang by any measure. |
| Total | auto-scaled | `min(30 min, max(5 min, 30 s × sizeMB))`. A 2.3 MB file gets 5 min (120× its measured 2.5 s); a 550 MB file — the largest the browser will attempt by default — gets 30 min (at the measured rate it needs ~9). |

Settings (`ifcSettings`, persisted in localStorage `toc.ifc.settings.v1`,
same pattern as `browserSafeMaxMB`):

- `importStallTimeoutMs` (default 120000; 0 disables the stall bound;
  values 1–9999 ms are clamped up to 10000).
- `importTotalTimeoutMs` (default 0 = auto-scaled; an explicit value
  overrides the auto-scaling, clamped to a 1 s minimum).

There is no settings-form UI for these two fields yet; they are set
through the same localStorage key as the other importer settings. A user
who hits the timeout on a legitimate slow machine raises the bound there
(the timeout error message says so) or converts to `.frag` offline.

## Honest limit

web-ifc runs **single-threaded** in this app (`getImporter()` forces
`forceSingleThread=true`), so a *synchronous* hang inside one WASM call
— the `OpenModel` hangs behind #231 — cannot be interrupted from the
page: no timer can fire while the main thread is inside WASM. That class
is stopped *before* WASM by the structural pre-flight
(`src/modules/ifc-semantics/step-preflight.ts`, including the malformed
enumeration validation from #231) and bounded by the Node fuzz gate
(`scripts/fuzz-ifc-corpus.mjs`, 500-mutation nightly campaigns). This
timeout bounds everything the page *can* observe: conversions that yield
to the event loop but stall or run past any legitimate time. It does not
claim to interrupt a synchronous WASM hang, and no test here pretends
otherwise.

## Evidence

- Node suite `tests/import-timeout.test.cjs` (`npm run test:import-timeout`,
  wired into `scripts/ci-unit-tests.mjs`): 18 assertions — bound
  computation (floor / per-MB scaling / ceiling / overrides / clamping /
  invalid inputs), the error message (names the file and bound, carries
  the recovery hint, never contains "cancel"), and the watchdog with real
  timers (stall fires on inactivity, `poke()` postpones it, total fires
  despite pokes, `clear()` prevents firing, fires at most once, a cleared
  watchdog cannot be re-armed by a late poke, `stallMs: 0` disables).
- Browser spec `tests/e2e/import-timeout.spec.ts` (Chromium, in
  `.github/workflows/unit-tests.yml`): with a 3 s total bound set through
  the real settings path, the 17.9 MB real-world `duplex-mep.ifc` must
  fail with a `timedOut` phase record and load nothing — then
  `generated-small.ifc` must still import under the same 3 s bound,
  proving the queue recovered. Chromium-only in CI by design
  (timing-sensitive, large-file); the mechanism is engine-agnostic JS.
- Fuzz (post-fix, measured on the rebased stack — see the rank-2 PR
  description for the numbers): 500-mutation bitflip and mixed campaigns,
  seed 42, 40 s child / 120 s init budgets locally (init raised from 30 s
  because the shared VM was at load ~24; the parser budget is unchanged).
