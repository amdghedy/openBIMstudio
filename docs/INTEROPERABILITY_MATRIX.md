# Interoperability Matrix

> Prepared 2026-11-20 from the external-validation deep dive
> (`openBIMstudio-external-validation.md`, §5). This is the Phase 4 file
> already promised by `docs/COMPATIBILITY.md` and
> `docs/engineering/BASELINE.md:101`.
>
> Status: **rows 1–3 and 6 were run 2026-11-21 by hardening-plan item 13**
> (branch `test/external-validation-passes`, base `eabab92`). Rows 4, 5,
> 7 remain blocked as recorded. This file is the recording place, not a
> claim: a row moves from "Not run" / "Blocked" only when the validation
> it describes has actually been performed and recorded.
>
> Note: item 12's matrix landed on main first; this updates its rows
> with the item-13 measured results (2026-11-21), keeping item 12's
> structure and rules unchanged.

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
| 1 | DWG: open one exported multi-sheet DWG (hatch, block, dimension, MTEXT, wipeout) in desktop CAD | 2026-11-21 | None run — AutoCAD 2027 trial is Windows 64-bit / Mac only (15 days, Autodesk Account); BricsCAD Linux build exists, 30-day trial, no credit card, but download needs account creation + email verification (user-side, not done) | App export `openbimstudio-cad-export.zip`, 37,622 bytes, sha256 `fb66d1c481988b9cd3133dc9acd995ddf9d1d7638b98482c53d4f7771b466722`, authored in-app 2026-11-21 (2 walls + door + window, Chromium e2e). Contains 4 DWG files: `Level_0_Plan.dwg` 9,803 bytes sha256 `f9676d3b…bcb37`, `Level_1_Plan.dwg` 9,803 bytes sha256 `1cd7272c…34c3ac`, `North_Elevation.dwg` 8,875 bytes sha256 `89b255ee…2ea9`, `Section_A-A.dwg` 8,683 bytes sha256 `303829f7…8904` (all 4 distinct files). All 4 start `AC1024` = AutoCAD 2010 format (header control-read only) | **Blocked** (file exported; reference-tool open not run) | No reference tool has opened the DWGs. AutoCAD cannot run on this Linux VM; BricsCAD trial needs a user account signup. Header version read is a control, not a pass. | No |
| 2 | BCF: round-trip one clash BCF with Solibri **and** BIMcollab ZOOM, both ways (viewpoints + snapshots + GUID stability) | 2026-11-21 | `bcf-client` 0.9.0 (PyPI, structural check — control only, not a round-trip). Solibri: no verifiable self-service trial (Oct 2026); tiers Starter €99 / Essential €1,428 / Advanced €2,109 / Premium €2,772 per licence/yr; Windows/macOS only. BIMcollab ZOOM: free viewer tier; 30-day full trial; Windows/Mac/web | App export `coordination-2026-11-21.bcfzip`, 5,586 bytes, sha256 `01803473231f088a0bd175250e2e061bc17b3598fb30bf08ce985a6d550321f0`, exported from 3 real clashes (seeded `__authored__` selections, Chromium e2e). Valid BCF 2.1 zip: `bcf.version` VersionId 2.1, `project.bcfp` (project "Test 1"), 3 topics each with `markup.bcf` + `viewpoint.bcfv`, e.g. topic `28b75e39-90c8-4852-acc2-4055aedc7263` "[INTERSECT] Wall 001 × Window 001", Hard Clash, Open, overlap 1,737,063.67 cm³, 25 tri pairs | **Partial** (structurally valid BCF 2.1; round-trip NOT run) | No reference tool has opened the file, so this is not a pass. Solibri and BIMcollab ZOOM both need Windows/macOS. Two quality notes on the export itself: `viewpoint.bcfv` carries no camera (Components only, no viewpoint position), and `markup.bcf` header has `IfcProject=""` (no link to the IFC project GUID). | No |
| 3 | IFC: authored model into BlenderBIM / Bonsai and Solibri; plus one licensed third-party IFC in → out → re-open | 2026-11-21 | **Bonsai 0.9.0** (extension, `bonsai_py311-0.9.0-linux-x64.zip`, sha256 `979a8259…442ec`) in **Blender 4.2.0** (2024-07-16 build), headless via `bim.load_project`; **IfcOpenShell 0.9.0.post1** (venv). Solibri: unavailable (see row 2) | App export `OpenBIMStudio_IFC4.ifc`, IFC4, 9,517 bytes, sha256 `50ef8809d6b8251c632f5fe4d7c5670e7e4397ed5ccae646e63afd2781e2bca0`, authored in-app 2026-11-21 (2 walls + door + window, Chromium e2e) | **Partial** (Bonsai leg **passed**; Solibri + third-party-in blocked) | Nothing broke in the Bonsai open: `bim.load_project` returned `{'FINISHED'}`; IfcOpenShell and Bonsai agree — 161 entities, 11 IfcProducts: 2 IfcWall, 1 IfcDoor, 1 IfcWindow, 2 IfcOpeningElement, 3 IfcBuildingStorey, 2 IfcRelVoidsElement, 2 IfcRelFillsElement; all 4 authored products became MESH objects (8 verts / 12 faces each); walls keep psets `OpenBIMStudio` + `BaseQuantities` with Length/Width/Height/GrossVolume (Wall 001: 84.68 / 0.255 / 3.0 / 64.78). Solibri open not run (Windows/macOS only). Third-party IFC in: no licensed file in workspace (corpus is self-authored). | No |
| 4 | RVT: one small real project `.rvt` (2023–2025) through rvt-rs; Revit IFC export of the same file as control | 2026-11-21 (attempt) | None run — Revit is Windows-only | Only `.rvt` in workspace: `tests/fixtures/rvt/architectural-2024.rvt`, 20,480 bytes, sha256 `3f50ce849ff022eb1c28ebfd91fb450d4a36af72fd19105d93caffb861e9560b`, **synthetic** scaffold from the rvt-rs corpus (per its README: "not a real building … no geometry"), Apache-2.0 | **Blocked** | No real `.rvt` anywhere in the workspace. | No |
| 5 | NWD: one real `.nwd` through the Navisworks bridge + BIMCamel | 2026-11-21 (attempt) | None run — Navisworks is Windows-only (2024–2027 + BIMCamel required) | No `.nwd` / `.nwc` anywhere in the workspace (0 files found) | **Blocked** | No file; no Windows machine. | No |
| 6 | Sheets: print / open one sheet PDF in a reader (settles the suspected poche / glazing coordinate bug) | 2026-11-21 | pdf-lib 1.17.1 (in-app exporter); rendered with `pdftoppm` (poppler) and inspected visually; content stream parsed with zlib | App export `A-001.pdf`, A1, 1 page, 3,257 bytes, sha256 `619e1cb3c162c74a1785325004d7b5f37c239c4fc245b9c4febcdb244bade76e`, generated in-app 2026-11-21 (Chromium e2e). Before the fix the same sheet was 1,759 bytes, sha256 `03da2ba4…a6e6ea0ef`, and rendered empty (border + titleblock + red dashed missing-view box only) | **Pass** | **Bug was real and is fixed.** `src/modules/export/pdf.ts:129,171` fed PDF y-up page coords into `drawSvgPath`, which applies `scale(1,-1)` (pdf-lib 1.17.1), so every fill rendered at `y = −py` — below the page, invisible — while `drawLine` outlines were correct. Fix: `svgPathFromPdfPoints` negates y in the path `d` at both call sites (commit on `test/external-validation-passes`). Regression test `tests/pdf-svg-fill.test.ts` fails on unfixed code (`fill 0 rendered off-page: {"minX":100,"minY":-200,"maxX":120,"maxY":-180}`) and passes with the fix (fills on-page, coincident with outlines). Rendered run-2 PDF: two crossing walls with visible grey poché fill, door/window gaps, "Level 0 Plan (+0.00 m)", scale bar, north arrow, titleblock — confirmed in `exports/sheet-run2-1.png`. A second bug found during the leg is also fixed: "Place plan viewport" hardcoded `viewId: "plan-current"`, which never exists, so every placed viewport rendered as the missing-view box; it now uses the first real plan view (`src/features/sheets-panel.ts:120`). | No |
| 7 | STEP, Rhino, MS Project XML: one file each, same template | 2026-11-21 (attempt) | None run | No app-produced files; repo holds only synthetic OCCT cubes (`cube-10mm.stp`, `cube-m.step`, `cube-mm.step`, `cube-10mm.igs`); no `.3dm`, no `.mpp` under `tests/`/`docs/`/`tools/` | **Blocked** | App-level block, not a tooling block: the app has NO exporter for any of them — STEP is import-only (solid reader), `.3dm`/Rhino is import-only, MS Project XML is import-only (parser only). There is nothing to validate in a reference tool for this leg; CI already covers upstream OCCT/rhino3dm samples for import. | No |

## Notes

- Validation 1 is the cheapest and highest-stakes: if AutoCAD rejects the
  exported DWG, that is P0-class — stop and fix the writer. The DWG now
  exists (AC1024); the open still needs a Windows/macOS machine or a
  BricsCAD Linux trial (user account signup).
- Validation 3's Bonsai leg is the first genuine reference-tool pass in
  this file: an authored openBIMstudio IFC opened in Bonsai 0.9.0 with
  geometry, psets and quantities intact. Headless recipe that works on
  this VM: install with `blender --background --command extension
  install-file -r user_default -e bonsai-0.9.0-py311-linux.zip`, then
  load with `bim.load_project` after setting
  `bonsai.REGISTERED_BBIM_PACKAGE = "bl_ext.user_default.bonsai"`
  (Bonsai 0.9.0's dual extension/package identity leaves the name unset
  headless; do NOT also `addon_enable(module="bonsai")` — that creates a
  second legacy addon entry with `.preferences is None` and breaks
  `get_addon_preferences()`). Full recipe:
  `~/workspace/openBIMstudio-work/item13-external-validation/bonsai-load.py`.
- Validation 6's fix also repaired the sheet viewport bug
  (`"plan-current"` dangling view id) found while rendering the proof.
- Validation 2's BCF is structurally valid but unproven in a reference
  tool; its viewpoint carries no camera and its header has no IFC
  project GUID — both worth fixing before claiming a round-trip pass.
- Licence / trial availability for the reference tools was **checked at
  test time in this run** (2026-11-21) and is recorded per row above:
  AutoCAD/Solibri/Revit/Navisworks are Windows/macOS only and cannot run
  on this Linux VM; BricsCAD (Linux) and IfcOpenShell/Bonsai are the
  viable on-VM routes.
- No issue exists yet for any of these validations ("open our DWG in
  AutoCAD", "round-trip BCF with Solibri", "run rvt-rs on a real .rvt").
  Item 12 also calls for one issue per validation; those issue numbers
  belong in the table above once created.
- Results feed #96 (corpus 9 → 20) and #106 (per-entity interop report,
  hardening-plan item 10) — update `COMPATIBILITY.md` and
  `feature-maturity.ts` in the same PR as each validation.
- IfcOpenShell 0.9.0.post1 is installed in a venv at
  `~/workspace/openBIMstudio-work/item13-external-validation/venv/`, so
  the leg-3 tooling does not need reinstalling when the authored export
  exists.
