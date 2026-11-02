# Golden IFC corpus

Round-trip fixtures for `scripts/golden-roundtrip.mjs` (CI workflow
`.github/workflows/golden-roundtrip.yml`). The harness parses every `*.ifc`
file in this folder twice, diffs entity-class counts, and compares the result
against the golden snapshot in `snapshots/<file>.ifc.json`. A mismatch fails CI.

## Current state (read this before trusting the green badge)

`snapshots/` currently contains three snapshots (`test.ifc.json`,
`example.ifc.json`, `IfcOpenHouse_IFC4.ifc.json`) whose **source `.ifc` files
are not in the repository** — they were blocked by the old catch-all `*.ifc`
ignore rule (now excepted for this folder). With no sources present, the
harness iterates zero files and the gate passes vacuously (`0/0 pass`).

To make the gate real again:

1. Rebuild the corpus sources (e.g. `node scripts/generate-ifc.mjs` writes a
   sample authored model, or add small self-authored / openly licensed models).
2. Run `node scripts/golden-roundtrip.mjs` locally; it writes a snapshot for
   every new file and reports mismatches for existing ones.
3. Review the snapshots, then commit **both** the `.ifc` sources and the
   snapshots together.

Track this in [docs/engineering/ISSUES.md](../../docs/engineering/ISSUES.md)
(P1-03: corpus should reach ~20 fixtures, each self-authored or openly licensed,
with source tool + license recorded in `MANIFEST.md`).
