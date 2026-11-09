# Family sketch editor

Open it from the **Parametric Families** panel (FAM button / Ctrl+Shift+F): **Sketch profile…** adds an outline to the selected
family; **New from sketch…** (or the command palette: "Family sketch: new family from an outline…") makes a new family.

1. Pick a tool: **Polygon** (click points; close by clicking the green first point, Enter, or *Close outline*), **Rectangle**
   (two corners) or **Circle** (centre, then radius).
2. Grid and snap, zoom, Undo point (Backspace), Clear. Esc cancels.
3. Set **Depth** and **Elevation** in metres. They become two type parameters (`sketchDepth`, `sketchElevation`; a second sketch
   gets `sketchDepth2`, …) that you can edit in the panel afterwards.
4. **Add to family** / **Create family**. Built-in families are copied first (`… (sketch)`), so the original is untouched.

The sketch plane is the **plan**: +X right, +Y up the screen (north / +Z in the model). The outline is extruded upwards from the elevation.

## Validation

At least 3 distinct points, at most 500, non-zero area, and no self-crossing edges. A clockwise outline is turned counter-clockwise.

## Limits (first version)

Straight edges only (a circle is a 48-sided polygon); one outline per extrusion; no holes/voids, arcs, splines, sweeps or revolves;
no dimension or reference-plane constraints in the sketch; the outline's shape is fixed data (only depth and elevation are parameters).
Verification: `tests/family-sketch.test.cjs` checks the maths and, where real three.js is installed (CI), the built geometry.
The drawing window itself has not been used in a real browser yet.
