# Make Editable Native Twin

## Purpose
Convert selected IFC/FRAG elements into independently editable native OpenBIMStudio objects while keeping the 3D viewport stable.

## Editability
- Converted objects are registered in the authored element registry (`nativeGeometry` + IFC metadata).
- They participate in selection, properties, move/rotate (gizmo), save/project restore, and IFC export paths where supported.
- Geometry is boundary-mesh based (exact triangles from the source). Parametric wall/door reconstruction is **not** claimed for arbitrary IFC shapes.

## Black-screen safeguards (2026-10-27)
Root causes addressed:
1. Full authored-scene `rebuild()` disposed every mesh on each conversion — replaced with **incremental mesh add**.
2. Non-finite geometry could corrupt WebGL buffers — **validated and rejected**.
3. Source item was hidden before a visible replacement was guaranteed — commit order is now: register → verify mesh → hide source.
4. Forced `fragments.core.update(true)` after hide could blank large linked models — uses soft update.

## Workflow
1. Select one or more IFC/FRAG elements.
2. Context menu / command: **Make Editable Native Twin**.
3. Source is hidden; native twin is editable.
4. Undo restores the source visibility and removes the twin.

## Limitations
- Unsupported or empty geometry is skipped with a toast; the viewport is not modified.
- Relationships beyond preserved property sets / placement are not fully re-wired.
- Requires usable per-item geometry from the Fragments API or viewport mesh fallback.
