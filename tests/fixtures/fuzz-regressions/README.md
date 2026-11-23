# Fuzz regression fixtures

Crashing / hanging / bad-output inputs found by the nightly parser fuzz
(`.github/workflows/nightly-fuzz.yml`) live here, one directory per format.
They are committed regression fixtures: a future parser change must keep
parsing them the way the manifest says (or fix the underlying defect and
update the manifest entry).

## Layout

```
fuzz-regressions/
  <format>/                  # ifc | dxf | bcf
    <sha256>.<ext>           # the exact crashing input, named by content hash
    manifest.json            # one entry per fixture (see below)
    capture-report.json      # last capture run's report (overwritten each run)
```

## Manifest entry

```json
{
  "sha256": "…",
  "file": "<sha256>.dxf",
  "format": "dxf",
  "seed": 42,
  "kind": "structural",
  "iteration": 137,
  "outcome": "timeout",
  "replayedOutcome": "timeout",
  "detail": null,
  "op": null,
  "code": null,
  "signal": "SIGKILL",
  "source": { "artifactDir": "fuzz-artifacts-dxf", "summarySeed": 42, "summaryIterations": 500, "summaryKind": "mixed" },
  "reproduced": true,
  "firstSeen": "2026-11-23T…",
  "lastSeen": "2026-11-23T…"
}
```

`outcome` is what the fuzz run saw; `replayedOutcome` is what the capture
replay saw. Only failures that reproduce are promoted — a failure that does
not reproduce on replay is reported in `capture-report.json` and NOT
committed here.

## How fixtures get here

1. The nightly fuzz writes failing inputs + `summary.json` to an artifact dir.
2. `node scripts/fuzz-capture-regressions.mjs --format <fmt> --artifact-dir <dir>`
   replays each failure in an isolated parser child and promotes the ones
   that reproduce (see the script header for the replay budgets).
3. The workflow uploads this tree as the `fuzz-regression-fixtures`
   artifact. The workflow itself cannot commit (`contents: read`), so a
   human — or a follow-up PR — commits the promoted fixtures from that
   artifact. Auto-creating GitHub issues from a fuzz failure is out of
   scope for the same reason (no write access to the issue tracker from the
   nightly job); the artifact + manifest is the hook point for it.

## Local use

```sh
# fuzz DXF, then capture whatever reproduced
FUZZ_ITER=500 FUZZ_ARTIFACT_DIR=fuzz-artifacts-dxf npm run test:fuzz-dxf
node scripts/fuzz-capture-regressions.mjs --format dxf --artifact-dir fuzz-artifacts-dxf
```
