# Make Editable Native Twin

## Purpose

Convert selected **linked** IFC/FRAG elements into independently editable native OpenBIMStudio objects (Native Twins) while keeping the 3D viewport stable.

Linked models stay read-only. Edits live on Native Twin overlays registered in the authored element registry.

## Editability

- Converted objects are registered in the authored element registry (`nativeGeometry` + IFC metadata).
- They participate in selection, properties, move/rotate (gizmo), save/project restore, and IFC export paths where supported.
- Geometry is boundary-mesh based by default (exact triangles from the source).
- When a reliable parametric definition is recovered (baseline / point / polygon), the twin may classify into a parametric edit mode (see [DIGITAL_TWIN_CAPABILITY_MATRIX.md](./DIGITAL_TWIN_CAPABILITY_MATRIX.md)).
- Parametric wall/door reconstruction is **not** claimed for arbitrary IFC shapes without recovered definition data.

## Black-screen safeguards (2026-10-27)

Root causes addressed:

1. Full authored-scene `rebuild()` disposed every mesh on each conversion — replaced with **incremental mesh add**.
2. Non-finite geometry could corrupt WebGL buffers — **validated and rejected**.
3. Source item was hidden before a visible replacement was guaranteed — commit order is now: **register → verify mesh → hide source**.
4. Forced `fragments.core.update(true)` after hide could blank large linked models — uses **soft update**.

## Workflow (single or multi-select)

1. Load one or more linked IFC/FRAG models (Manage Links / Federation).
2. **Multi-select** linked elements in the viewport, model tree, or box-select.
3. Run **Make Editable Native Twin** from:
   - Context menu (right-click), or
   - Command palette / BIM Command Center, or
   - Native Twin panel → **Make Editable** / **Bulk Convert Selection**.
4. Each successful item: source is hidden; Native Twin becomes editable.
5. **Undo** restores source visibility and removes the twin(s). Bulk convert uses **one history entry** for the whole batch when possible.

### Bulk convert (multi-selection)

Use bulk convert when many linked objects should become Native Twins in one action:

| Input | Behaviour |
|-------|-----------|
| Current selection snapshot | Preferred — all selected linked localIds across models |
| Explicit `{ modelId → localIds[] }` map | API / automation |
| Empty selection | No-op (toast: nothing selected) |

**Guarantees:**

- Continues after individual failures (skip + log; viewport not blanked).
- Emits **one summary toast** (created / skipped / failed) instead of one toast per element.
- Soft fragments update at end of batch (not per item).
- Optional `AbortSignal` cancellation mid-batch.
- Progress callbacks for UI (current index, total, last result).
- Does not mutate shared linked geometry; twins are independent overlays.

```ts
import { bulkConvertLinkedToNativeTwin } from "./frag-edit";

const result = await bulkConvertLinkedToNativeTwin({
  // omit selection → uses current multi-selection
  onProgress: (p) => console.log(p.index, p.total, p.status),
  signal: controller.signal,
});
// result.created, result.skipped, result.failed, result.twins
```

## Limitations

- Unsupported or empty geometry is skipped; the viewport is not modified for that item.
- Relationships beyond preserved property sets / placement are not fully re-wired.
- Requires usable per-item geometry from the Fragments API or viewport mesh fallback.
- Door/window parametric openings need a host wall in the **authored** model; linked-only hosts are not auto-created.
- Very large batches (thousands of elements) should be chunked by the caller for responsiveness.

## Geometry retrieval (2026-10-27)

Failure mode addressed: *“no usable per-item geometry”* for items such as  
`3032_ECG-INT-T2-BASE2-S / 35960`.

### Root cause

Fragments 3.x viewport tiles store `userData.itemIds`, not classic `idRanges`.  
Older traverse helpers (`getElementTriangles*`) returned null for many visible elements.  
`getItemsGeometry` MeshData transforms may arrive as `{ elements: number[] }` rather than `THREE.Matrix4`.

### Retrieval order

1. `model.getItemsGeometry([localId])` (multiple LOD attempts)
2. Exclusive single-item tiles (`userData.itemIds` length === 1)
3. Legacy `getElementTrianglesExact` / `getElementTriangles` (idRanges)

Approximate bounding-box meshes are **never** synthesized.

## API surface (`ctx.features.fragEdit`)

| Method | Role |
|--------|------|
| `begin(modelId, localId)` | Convert one linked element |
| `beginFromSelection()` | Convert current multi-selection (bulk path) |
| `bulkConvert(options?)` | **Bulk** convert with progress, cancel, summary |
| `remove(id)` / `clearAll()` | Revert twin(s), restore source visibility |
| `list()` / `count()` | Query twins |
| `serialize` / `deserialize` | Project persistence |
| `togglePanel()` | Native Twin panel |

## Related docs

- [DIGITAL_TWIN_CAPABILITY_MATRIX.md](./DIGITAL_TWIN_CAPABILITY_MATRIX.md) — category → edit mode matrix
- Geometry extract: `src/modules/native-twin/geometry-extract.ts`
- Conversion UI: `src/features/frag-edit.ts`, context menu in `src/features/context-menu.ts`
