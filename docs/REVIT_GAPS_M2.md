# OpenBIMStudio - BIM gaps, Milestone 2: real stairs, railings, ramps, curtain walls, roofs, ceilings

Before M2 these types had no mesh in the authoring engine. The ST / RA / CW / RF / CL shortcuts were aliased to a box
("equipment"), a plain wall or a flat slab, and the ribbon's Place Stair / Railing / Curtain Wall buttons dropped fixed-size
scene objects at the origin that were not saved, selectable, scheduled or exported. M2 turns all six into ordinary authored
elements. This package is cumulative (M1 + M2).

## Install (upgrade from M1, or fresh)

1. Copy `src/modules/bim-gaps/` over your project's folder (10 files, all plain ASCII).
2. `node scripts/install-bim-gaps.mjs <projectRoot>` (use `--dry-run` first if you like). It is idempotent and now makes six
   small edits (M1: boot hook, File menu, native-twin GlobalIds. M2: `createMesh` asks `window.__obsMeshBuilders` for unknown
   types, cost takeoff gets rows for the new types, the three parity buttons start the click tools). Originals go to
   `.bim-gaps-backup/`; CRLF/LF is preserved; an anchor that is not found is reported, never guessed.
3. `npx tsc --noEmit`, `npm run dev`. Console: `[bim-gaps] 1.1.0-m2: 6/6 steps started` (7/7 with M3).
4. Tests: copy `tests/` next to `package.json`, `node tests/run-tests.mjs` (works on Windows).

## Using it

| Element | Start it | Interaction |
|---|---|---|
| Stairs (straight / L / U) | existing Stairs tool or shortcut, ribbon button, palette: "Stairs: straight run / L-shape / U-shape" | click start, click end of the first flight (Shift = orthogonal) |
| Railing | Railing tool / palette "Railing: draw path" | click points, double-click or Enter to finish |
| Ramp | palette "Ramp: place" | click start, click end |
| Curtain wall | Curtain wall tool / ribbon / palette | click start, click end |
| Roof (gable / shed) | Roof tool / palette "Roof: draw footprint" | click footprint points, double-click or Enter |
| Ceiling | Ceiling tool / palette, or "Ceiling: place one in every room of this level" | polygon, or automatic from rooms |

Everything snaps to existing end points / vertices (25 cm) and a 5 cm grid; Esc cancels. Elements are placed on the active
level; stairs and curtain walls take their height from the next level above (3.0 / 3.6 m when there is none). Each placement
is one undo step. Placed elements can be selected, moved / copied / rotated, edited with grips (stair run line, curtain wall and
ramp end points, railing and roof / ceiling vertices) and in the Properties palette (new schemas for all six types).

| Type | Main parameters (palette) |
|---|---|
| stairs | total rise, run width, shape (straight / L / U), turn direction, max riser (17.5 cm), waist, second flight length, gap (U), landing thickness |
| railing | rail height, rail size, rise along path (for stair railings), post spacing, baluster spacing, balusters on/off |
| ramp | rise, width, slab thickness (the ramp reports its slope and whether it is within 1:12) |
| curtain wall | height, mullion depth / width, horizontal and vertical grid spacing |
| roof | eaves elevation, thickness, type (gable / shed), slope in degrees, slope direction |
| ceiling | elevation, thickness |

## What else now works for them

- **Hide / isolate / category / phase / design option** (M1 bridge): they use the same mesh tagging, so they work with no extra code.
- **Cost takeoff**: real quantities (stairs: length, plan area, concrete volume and riser count; curtain wall: area; roof: sloped
  surface area and volume; railing: length; ramp: slope).
- **IFC export** (File > Export > Model): `IfcStair` (straight / quarter turn / half turn), `IfcRailing`, `IfcRamp`,
  `IfcCurtainWall` (frame and glazing as two coloured items), roofs as `IfcSlab` ROOF, ceilings as `IfcCovering`. Stairs, railings,
  ramps, curtain walls and roofs are tessellated from the same generators as the viewport, with storey-relative placement,
  quantities and the `OpenBIMStudio` property set. In IFC2X3 they are faceted breps and `IfcCurtainWall` has no predefined type.

## How it was verified, and what was not

Run here: **64 automated tests, all passing** (M1: 13 geometry/GUID/room, 11 visibility; M2: 19 geometry, 7 tools / registration, IFC grew
from 10 to 14).
- Geometry: every generated shell is closed with outward winding (edge-matching check, signed volume), the stair result is
  identical for any run direction, exact analytic volumes (waist-slab flight cross-section, ramp, roof = plan area x
  thickness, ceiling), L and U stairs: flights + landing sum exactly, second flight on the correct side, top at exactly the total
  rise; mullions keep their cross-section on rotated walls.
- Tools: snapping, defaults produce valid geometry for all six types, the stair rise follows the next level, one undo step
  reverts a placement, ceilings from rooms (no duplicates), palette schemas have no duplicate fields, mesh builder returns null
  instead of throwing on bad parameters, legacy tool names are redirected and all other tools pass through.
- IFC: attribute counts per entity for IFC4 and IFC2X3, valid unique GlobalIds, resolved references, tessellation indices in
  range, storey-relative heights, stair shapes mapped to the right enumerations.
- Compiles under your own `tsconfig` flags (isolatedModules, noImplicitReturns, ...); the installer was run twice on LF and CRLF
  copies with no new type errors.

NOT verified, please check on your machine:
1. The click tools, preview and snapping were never run in a browser (the DOM / three.js parts are typechecked and covered with fakes).
2. Open an exported IFC in BIM or another reader (my validator is my own; use the IFC2X3 item if BIM 2020 rejects IFC4).
3. The 2D plan panel (156 KB, not read in this review): I did not check how it draws the new types.

## Limits (deliberately not done yet)

- Stairs are monolithic waist-slab steps: no separate treads / risers / stringers / nosings, no winders or spirals, rectangular
  landings, and no automatic railings (draw a railing and set "Rise along path"). The run length includes the top step.
- Stairs and ramps do not cut openings in the floor above; roofs do not join or trim walls; there are no hip / valley roofs and no
  holes in roof or ceiling polygons. Curtain walls: uniform grid, no panel types, no doors in them, no corner mullions.
- Rooms (M1) and palette edits are still outside the undo stack unless the palette already records them.

## Still open from the original M2 list

Wall joins and profile edit (the engine already has corner join helpers; not touched), room placement and tags in the **plan panel**,
phases / design options in the Properties palette (today: palette commands from M1), and shaft / floor openings for stairs.
Next milestones are unchanged: M3 documentation (views, sheets, tags, schedules), M4 BIM 2020 round trip, M5 worksharing, M6 hardening.
