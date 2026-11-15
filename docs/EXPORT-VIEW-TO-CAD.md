# Export views to CAD (DWG / DXF)

**Where:** File menu → Export → *Views → CAD (DWG / DXF)…*, or the command palette: *Export: Views to CAD*.

Like Revit's *Export › CAD Formats*, it turns the project's **plan, RCP, section and elevation views** into drawings,
one file per view (several views download as one ZIP).

## Options
| Option | Meaning |
|---|---|
| Views | Any plan / ceiling plan / section / elevation. If the project has none, one click creates a plan per level and four elevations. |
| Format | DWG (written through the bundled CAD engine) or DXF |
| Version | DWG/DXF version written (default DWG 2010) |
| Units | Millimetres (default) or metres; geometry is 1:1 |
| Layer prefix | Optional, e.g. `ARC-` |
| Layers | Choose which of the view layers are exported |
| View title | Adds the view name and scale under the drawing |

## Layers
`A-CUT` (cut elements), `A-PROJ` (projected), `A-OVHD` (overhead), `A-BELW` (below), `A-GRID`, `A-ANNO` (annotation,
tags, dimensions text), `A-SYMB` (symbols), `A-ANNO-TTLB` (title). Colours and lineweights come from the view's strokes
(true colour and pen weight in mm); dashed strokes use a `DASHED` linetype.

## Limits (be aware)
- **3D model export is separate and limited:** the same dialog has *3D model → DXF* (3DFACE triangles, layers by element type, Z up, DXF R12). It covers authored elements and, optionally, every geometric element of the loaded IFC/Revit models (layers by IFC entity: A-WALL, S-COLS, M-DUCT…; capped at 4 million triangles; the selected/visible filters apply to authored elements only). It writes triangles not solids, and offers DXF or DWG (DWG is written as R12 3D faces by the CAD engine; a real-browser test re-reads the written DWG and finds all 12 faces of an IFC wall; opening it in AutoCAD, BricsCAD or Revit is not verified). **Current 3D view → 2D lines:** the same dialog can export the model as you see it now (your camera) as 2D LINE work with hidden edges removed, as DXF or DWG, optionally keeping hidden edges on dashed `-HIDDEN` layers. Edges are boundaries, creases over 30° and silhouettes. Visibility is sampled on a 1600-pixel-wide depth buffer, so lines are accurate to about a pixel; triangles crossing the camera are dropped; perspective views are sized at the model's distance. Verified: 12 unit assertions on cubes and occluders, and a browser test (an IFC wall seen from the front gives about 5.04 m × 3.03 m). Not verified: comparison with a CAD package's own hidden-line output, large models, opening the file in AutoCAD.
- Layers are by *view layer*, not by Revit category (wall, door…), because the view scene does not carry the category.
- Symbols (doors, etc.) are written as a circle plus a label; there are no CAD blocks or xrefs.
- Hatches are written with the pattern name; the receiving CAD program substitutes its own definition.
- Text uses the default text style; fonts are not embedded.
- Views are exported only as the app's generators draw them. They are as complete as the on-screen views, no more.

## DWG path (verified in the real CAD engine)
`tests/export-cad-dwg.test.cjs` runs the committed CAD WASM in Node: a view scene → DXF → **binary DWG** → read back by the
real reader. Layers, lines, arcs, circles, text (including its height), solid and patterned hatches, true colours,
dashed linetypes and millimetre coordinates all survive. That proves our converter and the engine keep the content; it
does **not** prove AutoCAD opens the file. For 3D faces the engine also converts DXF → DWG and the read-back keeps the Z
values, but the 3D dialog stays DXF-only until that is checked in a real CAD program.

## Verification
`tests/view-to-cad.test.cjs` checks the conversion (units, layers, colours, linetypes, arcs, hatches, text height, file names,
ZIP) and that the DXF text is complete. **Not verified:** that AutoCAD / BricsCAD / Revit open the produced DWG/DXF without
warnings, and the dialog has not been used by a person.
