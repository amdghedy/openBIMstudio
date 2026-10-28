# Digital Twin Capability Matrix

Universal **linked-model → Native Twin** conversion and parametric editing.

## Shared pipeline

```
Discover → Identify → Extract → Classify → Normalize → Convert
  → Validate → Register → Render → Edit → Regenerate → Synchronize → Persist
```

Property edits for geometric parameters use:

`applyElementParamChange` → `rebuild` → element-specific `createMesh` path.

## Bulk conversion entry points

| UI / API | Multi-select | Progress | Cancel | Batch history |
|----------|--------------|----------|--------|---------------|
| Context menu **Make Editable Native Twin** | Yes | Summary toast | No | Per-item (legacy) |
| `beginEditFromSelection()` | Yes | Per-item toasts | No | Per-item |
| **`bulkConvertLinkedToNativeTwin()`** | Yes | Callback + summary | `AbortSignal` | Single batch entry |

Prefer **`bulkConvertLinkedToNativeTwin`** for large multi-selections from linked models.

## Editing modes

| Mode | Meaning |
|------|---------|
| `parametric-linear` | Start/end baseline recovered; solid from length × height × thickness |
| `parametric-vertical` | Point placement; solid from section × height |
| `parametric-slab` | Plan polygon; extruded thickness |
| `boundary-mesh` | Exact source triangles; scale from base dimensions |
| `metadata-only` | No safe geometric edit |
| `read-only` | Conversion/geometry unavailable |

## Category matrix

| Category | Discipline | Conversion | Default mode | Geometric params |
|----------|------------|------------|--------------|------------------|
| wall | Arch / Struct | Geometry + baseline | parametric-linear | height, thickness, width, depth, elevation |
| beam / brace / truss | Structural | Geometry + baseline | parametric-linear | height, thickness, width, depth, elevation |
| duct / pipe / cable-tray / conduit | MEP | Geometry + route | parametric-linear | height, thickness, width, depth, elevation |
| column / footing / equipment / fitting | Struct / MEP | Geometry + point | parametric-vertical | height, thickness, width, depth, elevation |
| slab / roof / ceiling / room / terrain | Arch / Civil | Geometry + polygon | parametric-slab | height, thickness, elevation |
| door / window | Architectural | Mesh; host for openings | boundary-mesh | height, width, sillHeight, … |
| stairs / railing / ramp / curtain-wall | Architectural | Mesh | boundary-mesh | height, thickness, elevation |
| generic | Any | Mesh fallback | boundary-mesh | height, thickness, width, depth, elevation |

## Bulk multi-select behaviour

1. **Selection sources (priority):** explicit map → selection manager snapshot → highlighter adopt → (optional) single pick under cursor.
2. **Per item:** extract geometry → validate finite buffers → register native element → verify mesh → hide linked source.
3. **On failure:** skip item; continue batch; record reason (`no_geometry`, `validation`, `register`, `already_twin`, `aborted`).
4. **After batch:** soft `fragments.core.update(false)`, one panel refresh, one summary toast, optional single undo group.

## Limitations (honest)

- Door/window **parametric openings** require a host wall in the authored model; linked-only hosts are not auto-created.
- Boundary-mesh height/thickness uses **base-dimension scale**, not full CSG reconstruction.
- Slab polygons from AABB are axis-aligned approximations when IFC profile curves are not recovered.
- Shared source geometry is never mutated; Native Twins are independent overlays.
- Source linked files remain read-only; edits live in the project document.
- Bulk convert does not auto-resolve cross-model relationships (Copy/Monitor-style) in this version.
