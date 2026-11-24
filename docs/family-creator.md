# Free family creator (slice 1, partial)

OpenBIMStudio is the family creator and engine. Revit is the destination.
Everything here uses free tools only: no paid APIs, no cloud calls.

## What slice 1 does

Product size in, editable family out, IFC2X3 written and structure-checked.

1. **Intake** (`creator/cutsheet.ts`, `creator/units.ts`): reads an overall
   `W x D x H` size from cut-sheet or spec text (one string per page, for
   example from pdf.js). Each value keeps its page, line and exact source
   text. If sizes conflict or none is clear it returns nothing and the caller
   must ask the user. It never picks one.
2. **Family** (`creator/build.ts`, `creator/templates.ts`): builds an ordinary
   `FamilyDefinition` for the existing parametric engine. `Width`, `Depth`,
   `Height` are type parameters, a template adds more (plinth, door, handle),
   and every part size is a formula. Templates: `box`, `cabinet`.
3. **Engine check** (`creator/pipeline.ts`): the family is built through the
   real `buildParametricFamily` and its bounding box must match the spec.
4. **IFC2X3** (`creator/ifc2x3.ts`): one element, one extruded solid per part,
   a property set with the parameters, standard spatial spine. The text is read
   back with the repo's STEP reader and checked.

Status is real. `progress` is finished stages over total stages, nothing else.
There is no timer. A failed stage stops the run and says why.

## What it does not claim

- No "Ready for Revit". `status.revit.state` is always `"unverified"` here.
  Only a run in Revit can change that, and a person records it.
- IFC import is geometry and properties, not a native editable Revit family.
  The family stays parametric inside OpenBIMStudio.
- No image or URL intake, no vision model, no UI yet. Those are later slices.
- GLB stays an export for other tools. Revit 2020 has no documented GLB import.
- The two templates are small. Real products need richer parts (later slices).

## Revit 2020 acceptance (run by the user, not automated)

- R1 Open the IFC in Revit 2020 (File > Open > IFC, or Insert > Link IFC).
  Expect one element, 1200 x 700 x 2000 mm for the sample.
- R2 Units and orientation: width along X, depth along Y, base at level 0.
- R3 The `OBS_FamilyParameters` property set is present on the element.
- R4 Note what can and cannot be edited after import.

## Independent check used in CI-less review

`ifcopenshell` (LGPL, dev tool only, not shipped) opened the sample as IFC2X3,
EXPRESS validation returned 0 messages, and the geometry bbox was
1.2 x 0.7 x 2.0 m.
