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
- **Not the 3D view.** A 3D model export (3DFACE / solids) and "export the current 3D camera view as lines" are not
  implemented. Create a plan, section or elevation for what you need.
- Layers are by *view layer*, not by Revit category (wall, door…), because the view scene does not carry the category.
- Symbols (doors, etc.) are written as a circle plus a label; there are no CAD blocks or xrefs.
- Hatches are written with the pattern name; the receiving CAD program substitutes its own definition.
- Text uses the default text style; fonts are not embedded.
- Views are exported only as the app's generators draw them. They are as complete as the on-screen views, no more.

## Verification
`tests/view-to-cad.test.cjs` checks the conversion (units, layers, colours, linetypes, arcs, hatches, text height, file names,
ZIP) and that the DXF text is complete. **Not verified:** that AutoCAD / BricsCAD / Revit open the produced DWG/DXF without
warnings, and the dialog has not been used by a person.
