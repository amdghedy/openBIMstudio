# Interoperability Matrix

> Prepared 2026-11-20 from the external-validation deep dive
> (`openBIMstudio-external-validation.md`, §5). This is the Phase 4 file
> already promised by `docs/COMPATIBILITY.md` and
> `docs/engineering/BASELINE.md:101`.
>
> Status: **no validation below has been run yet.** This file is the
> recording place, not a claim. A row moves from "Not run" only when the
> validation it describes has actually been performed and recorded.

## Rules for this file

- One row per validation. Columns: **date · tool + version · file (name, hash,
  size, source, licence) · result (pass / partial / fail) · what broke ·
  COMPATIBILITY.md row updated**.
- **No row may say "pass" without a file and a tool version.** A self
  round-trip, a LibreDWG / ezdxf cross-read, or a unit test alone is a
  control, not a pass — the reference-tool open is the test.
- No status moves from "limited" / "experimental" to "verified" in
  `src/features/feature-maturity.ts` on the basis of a row here until the
  validation it records is a real reference-tool pass.

## Validations

| # | Validation | Date | Reference tool + version | File (name, hash, size, source, licence) | Result | What broke | COMPATIBILITY.md updated |
|---|---|---|---|---|---|---|---|
| 1 | DWG: open one exported multi-sheet DWG (hatch, block, dimension, MTEXT, wipeout) in desktop CAD | Not run | e.g. AutoCAD (version TBD) or BricsCAD trial | — | Not run | — | No |
| 2 | BCF: round-trip one clash BCF with Solibri **and** BIMcollab ZOOM, both ways (viewpoints + snapshots + GUID stability) | Not run | Solibri (version TBD); BIMcollab ZOOM (version TBD) | — | Not run | — | No |
| 3 | IFC: authored model into BlenderBIM / Bonsai and Solibri; plus one licensed third-party IFC in → out → re-open | Not run | BlenderBIM / Bonsai (version TBD); Solibri (version TBD) | — | Not run | — | No |
| 4 | RVT: one small real project `.rvt` (2023–2025) through rvt-rs; Revit IFC export of the same file as control | Not run | rvt-rs (version TBD); Revit (version TBD) | — | Not run | — | No |
| 5 | NWD: one real `.nwd` through the Navisworks bridge + BIMCamel | Not run | Navisworks 2024–2027 (version TBD) | — | Not run | — | No |
| 6 | Sheets: print / open one sheet PDF in a reader (settles the suspected poche / glazing coordinate bug) | Not run | PDF reader (name + version TBD) | — | Not run | — | No |
| 7 | STEP, Rhino, MS Project XML: one file each, same template | Not run | Tool + version TBD per file | — | Not run | — | No |

## Notes

- Validation 1 is the cheapest and highest-stakes: if AutoCAD rejects the
  exported DWG, that is P0-class — stop and fix the writer.
- Validation 6 is minutes of work and should be done with this file, not
  deferred to the full suite (hardening plan, item 13 note).
- Licence / trial availability for the reference tools was **not** verified
  in the dives — confirm at test time.
- No issue exists yet for any of these validations ("open our DWG in
  AutoCAD", "round-trip BCF with Solibri", "run rvt-rs on a real .rvt").
  Item 12 also calls for one issue per validation; those issue numbers
  belong in the table above once created.
- Results feed #96 (corpus 9 → 20) and #106 (per-entity interop report,
  hardening-plan item 10) — update `COMPATIBILITY.md` and
  `feature-maturity.ts` in the same PR as each validation.
