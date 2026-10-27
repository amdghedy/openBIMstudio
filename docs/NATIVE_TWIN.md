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

## Geometry retrieval (2026-10-27)

Failure mode addressed: *“no usable per-item geometry”* for items such as
`3032_ECG-INT-T2-BASE2-S / 35960`.

### Root cause
Fragments 3.x viewport tiles store `userData.itemIds`, not classic `idRanges`.
The older traverse helpers (`getElementTriangles*`) therefore returned null for
many visible elements. In addition, `getItemsGeometry` MeshData transforms may
arrive as `{ elements: number[] }` rather than `THREE.Matrix4`, which broke
triangle world transforms when not normalized.

### Retrieval order
1. `model.getItemsGeometry([localId])` (multiple LOD attempts)
2. Exclusive single-item tiles (`userData.itemIds` length === 1)
3. Legacy `getElementTrianglesExact` / `getElementTriangles` (idRanges)

Approximate bounding-box meshes are **never** synthesized.
