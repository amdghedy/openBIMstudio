# OpenBIMStudio - BIM gaps, Milestone 3 (part 1): drawings that show the model

M3 is the documentation milestone. Before building anything I traced the real drawing pipeline (views -> scene -> sheet SVG /
PDF). Findings, then what this package changes.

## What I found

| Area | Finding (verified in the code) |
|---|---|
| Plans | The generator had no rooms at all (the `room` text kind existed but nothing produced it) and no poche. Stairs, ramps and curtain walls fell into a generic "thin box" branch, **railings were drawn as closed loops**, roofs and ceilings as plain outlines. No door / window marks. |
| Elevations | Every element was its bounding rectangle: no door / window openings, no hidden surfaces (everything drawn, nothing occluded), no roof slope, no glazing. |
| Sections | Walls were cut as if always perpendicular to the cut line (thickness used as width), no openings, stairs and roofs as rectangles. |
| Sheet PDF | Polygon fills use pdf-lib `drawSvgPath(d, {x:0, y:0})` with page coordinates that are already y-up; `drawSvgPath` is y-down, so those fills very probably fall below the page (poche, tag bubbles, glazing would be missing in printed sheets). I could not run pdf-lib here, so treat this as "probable, from reading the code". |
| View templates | `ViewDef.templateId` exists but nothing reads it. There is no per-view Visibility/Graphics for 2D views. |
| Two systems | The old plan panel (`plan-view-panel.ts`, 156 KB) has its own drawing code. Sheets and PDF use the newer Scene2D pipeline (`modules/views`). M3 changes the Scene2D pipeline; the old panel is untouched. |

## What changed

**Plans** (`m3-plan.ts`)
- Wall and column **poche**, broken at the door / window openings the cut plane passes through.
- **Room tags** (number, name, area) from the rooms of that level (matched by elevation), optional boundaries.
- **Stair symbols**: flight outlines, riser lines (solid up to the cut plane, dashed above), up arrow and "UP", landings, L / U shapes.
- Railings as double lines, ramps with arrow and slope (1:12.0), curtain walls with mullion ticks and a glazing line, roofs as
  dashed outline with ridge and slope, ceilings on reflected ceiling plans only.
- **Door and window marks** (D1, W1 ... in element order, or `properties.mark`) in tag circles.
- The base generator's geometry for the six M2 types is dropped so nothing is drawn twice.

**Elevations** (`m3-project.ts`): real geometry - walls with openings, door leaves and frames, translucent glazing, sloped roofs,
stairs. Each connected piece contributes its front-facing triangles; nearer pieces hide farther ones; crease lines are drawn
where faces bend; level datums are added.

**Sections**: closed solids are cut by the plane. The cap of every cut solid is rebuilt (poche, holes punched), so oblique cuts
have the right width, a cut through a door shows only the lintel, a cut along a stair shows the stepped waist-slab profile, and
what lies beyond is drawn as projection. "Right" / "left" look directions are never mirrored. Level datums are added.

**PDF**: filled polygons are drawn with raw PDF path operators in page coordinates (`m3-pdf-fill.ts`); the old path is the fallback.

## Install

1. Copy `src/modules/bim-gaps/` (now 15 files) over the project's folder.
2. `node scripts/install-bim-gaps.mjs <projectRoot>` (`--dry-run` first if you like). It is idempotent, now eleven small edits in
   ten files; the new ones are in `generators/plan.ts` (two lines), `section.ts`, `elevation.ts` and `export/pdf.ts`.
3. `npx tsc --noEmit`, `npm run dev`. Console: `[bim-gaps] 1.2.0-m3: 7/7 steps started`.
4. Run the palette command **"Views: regenerate all views and sheets"** once (sheets cache scenes), then open a plan, section,
   elevation and a sheet.
5. Tests: copy `tests/` next to `package.json`, `node tests/run-tests.mjs`.

Palette commands: "Plan graphics: toggle wall poche / room tags / room boundaries / door and window marks / stair symbols" and
"Views: regenerate all views and sheets". Choices persist.

## How it was verified, and what was not

Run here: **96 automated tests, all passing** (32 of them new in M3). For M3: exact wall-with-openings volumes; closed solids; painter order;
oblique cut width = thickness / sin(angle); cut through a door = lintel only; stair cap area = analytic cross-section; clipping
conserves surface area for both look directions at several positions; poche areas with and without openings; riser lines below
and above the cut; ridge position; marks and tag placement; room matching by elevation; hooks into the real generator
signatures; PDF operator sequence, white blending of translucent fills and fallbacks. Everything compiles under your own
`tsconfig` flags and the installer was run twice on LF and CRLF copies with no new type errors.

NOT verified, please check:
1. **Open a sheet and print a PDF** with a plan, a section and an elevation. In particular confirm poche and glazing now show
   in the PDF (and say if they already did - then the fix is harmless).
2. Nothing was run in a browser; the generators were exercised through their real hook signatures with fake data.
3. Orientation: your plan panel draws +Z up ("north up") while the 3D world is right-handed with Y up, so a plan with X to the
   right is the mirror of the 3D top view. M1's IFC export keeps the 3D geometry (IFC X = x, Y = -z). If you design in the plan
   panel and the exported IFC looks flipped north-south against it, tell me which one should win and I will change the mapping.

## Limits (not done yet)

- No hatch patterns (neither renderer draws hatches): poche is one colour per type.
- Depth ordering is per connected piece (far to near); interpenetrating or very large overlapping solids can mis-order.
- Views ignore phase / design-option filters and the section's top / bottom crop; truss, fitting and grid elements are not drawn.
- Door / room tags are generated from element data on every regeneration (not movable annotations).
- Plan symbols are not in the old plan panel.

## Still open in M3

View templates and a Visibility/Graphics dialog (the `templateId` plumbing), automatic dimensions, schedules for rooms / doors /
windows / the M2 types linked to the marks, section and elevation markers on plans, callouts / detail views, print preview and
sheet checks. Then M4 (BIM 2020 round trip), M5 (worksharing), M6 (hardening).
