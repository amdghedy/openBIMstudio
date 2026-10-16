# OpenBIMStudio - Revit gaps, Milestone 1

Milestone 1 turns four things that were shown as "done" but did nothing into working features, and adds the
first real Revit-interchange path (IFC export of the authored model).

## Install (3 steps)

1. Copy `src/modules/revit-gaps/` from this package into your project's `src/modules/`.
2. `node scripts/install-revit-gaps.mjs <projectRoot>` (add `--dry-run` first if you like).
   It makes three small edits, marker `openbim-revit-gaps:v1`, keeps originals in `.revit-gaps-backup/`, preserves
   CRLF/LF, and tells you if an anchor was not found instead of guessing:
   - `src/critical-gaps-boot.ts` - starts the revit-gaps boot
   - `src/shell/file-menu.ts` - File > Export > Model -> IFC4 / IFC2X3
   - `src/modules/export/native-twin-ifc.ts` - valid IFC GlobalIds
3. `npx tsc --noEmit` then `npm run dev`. The console prints `[revit-gaps] <version>: N/N steps started` (5/5 for M1 alone, 6/6 with M2).
   (the command palette entry "Revit gaps: show status" prints the table again.)

To run the tests: copy `tests/` next to `package.json` and run `node tests/run-tests.mjs`.

## What changed

| Gap found in the review | Now |
|---|---|
| Hide / Isolate / category overrides / phase filter / design options changed nothing in the viewport (the filter's change event had no subscribers) | `visibility-bridge.ts` applies the filter to authored meshes (visibility + halftone opacity, re-applied after every rebuild) and to Fragments models through `OBC.Hider` (`set`, `isolate`, categories via `model.getItemsOfCategories`) |
| `selection.getSelectedIds()` did not exist, so the Hide / Isolate / Group buttons always got an empty list | added; returns authored ids plus `frag:<modelId>::<localId>` keys |
| Nothing ever wrote `phaseCreated` / `phaseDemolished` / `designOptionId` on elements | palette commands "Phase: set ... on selection" and "Design option: assign selection" (tags live in `element.properties`) |
| Rooms: "Create Room" made a fixed 4x3 m rectangle at the origin | `room-detect.ts` + `room-tool.ts`: click inside walls (or `RM`) -> room on the wall finish faces; "Place rooms automatically"; islands (shafts) become holes; tags + outlines in the viewport. The old sample call is routed to automatic placement |
| Rooms / areas / phases / design options / groups / ref planes / shared params / copy-monitor lived in global localStorage (leaked across projects, missing from the saved project and Project JSON) | `project-scope.ts`: stored in `project.revitStores`, swapped on project open/new. First run adopts what is already in localStorage |
| No IFC export of the authored model; native-twin writer emitted invalid GlobalIds | `authored-ifc.ts`: IFC4 and IFC2X3 writer (see below); `ifc-guid.ts`: real compressed GUIDs, stable per element id |

### IFC export coverage
Analytic extruded solids (editable in Revit/other tools): walls, slab / roof / ceiling polygons, columns, footings,
beams, braces, duct / pipe / cable tray / conduit runs, doors and windows with real openings in the host wall
(`IfcOpeningElement` + void + fill relations), equipment (box), rooms as `IfcSpace` with `BaseQuantities`. Native twins are
tessellated. Storeys come from levels; every element carries an `OpenBIMStudio` property set (element id, type, family,
all primitive `properties`) and a material when `properties.material` is set. Anything else (stairs, railings, curtain
walls placed by the parity buttons, trusses, fittings) is listed in the console as "not exported" - never silently dropped.

## How this was verified (and what was not)

Run here: 34 automated tests, all passing -
- GUIDs (round trip, 2000 random, deterministic ids), rooms (rectangle, L-shape against the analytic area, T-junction
  8 cm off the wall face, overshooting walls, dangling stub, island hole, separation line, open plan returns null);
- IFC output for IFC4 and IFC2X3: every `#ref` resolves, attribute counts per entity match the schema, GlobalIds valid and
  unique, REAL values carry a decimal point, wall origin/axis/profile/depth and door position asserted numerically,
  escaping, determinism;
- the visibility bridge against fake meshes, a fake Hider and a fake Fragments model.
The new modules typecheck (strict) against your own sources; the installer was tested on LF and CRLF copies, twice
(idempotent) with no new type errors.

NOT done here, please check on your machine:
1. **Open an exported file in a third-party reader** (Revit link / IfcOpenShell / BIMvision). I validated it with my own
   structural checker, not with Revit. Revit 2020 reads IFC2X3 everywhere; if it rejects the IFC4 file use the IFC2X3 item.
2. The DOM/three.js parts (room click tool, tags, preview, Hider calls) were typechecked and the Hider/visibility logic was
   run against mocks, but not executed in a browser.
3. The Fragments pattern used (`Hider.set` / `isolate` with a model-id map, `getItemsOfCategories`) matches the That Open
   components docs and the calls already used elsewhere in your code base.

## Known limits of M1 (honest list)
- Room tool works in the 3D view; the 2D plan panel is not wired yet. Rooms are not associative (they do not follow wall
  edits; re-run "place rooms automatically" or delete and re-place).
- IFC: straight wall extrusions (no mitred joins), pipes/conduits exported round although the app draws boxes, no
  `Pset_*Common` yet.
- Phase / design-option filters only act on authored elements that carry tags; linked IFC items cannot be phased.
- Tagging and room placement are not in the undo stack yet.
- `ChunkProject.ps1` probably corrupts non-ASCII text on Windows PowerShell 5.1 (144 of 269 source files showed
  double-encoded characters in the chunks). Use `Get-Content -Raw -Encoding UTF8` and write with
  `Out-File -Encoding utf8`. All files in this package are plain ASCII.

## Roadmap to Revit-level parity (what remains, in order)

Matching Revit "from all sides" is several milestones of work; this is the dependency order.

- **M2 - Authored model completeness.** Stairs, railings, ramps, curtain walls, sloped roofs, ceilings as real authored
  elements (level-hosted, click-placed, editable, scheduled, exported); wall joins and profile edit; plan-panel room
  placement and tags; Properties palette for instance/type parameters, phases and options; undo for all of it.
- **M3 - Documentation.** Plan / section / elevation views driven by rooms and phases, view templates and a Visibility/
  Graphics dialog, sheets, door / window / room tags, dimensions, room / door / window schedules, print.
- **M4 - Revit round trip (Revit 2020 add-in).** Extend RevitBatchExporter: FRAG plus a JSON sidecar with levels, rooms and
  boundaries, phases, worksets, schedules, sheets, families / types / parameters and ElementId <-> IFC GlobalId; import
  of authored elements back into Revit.
- **M5 - Worksharing.** Element-level ownership / locks, sync, conflict handling and presence instead of whole-project
  last-write-wins.
- **M6 - Hardening.** Remove dead code (COBie, BCF 2.1, federation, standards report, model-health and the enhanced formula
  engine exist but are unreachable), typed APIs instead of `as any`, one boot path, CI.
