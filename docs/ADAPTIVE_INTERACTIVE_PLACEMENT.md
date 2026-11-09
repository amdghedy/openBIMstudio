# Adaptive Components — Interactive Placement, Constraints and Shared Types

## What is now available

The adaptive component command starts in **Interactive 3D point picking** mode. The user selects an adaptive profile/family and then clicks the viewport to place its ordered points. Hits on visible 3D model geometry are used directly; when no model surface is under the cursor, picking falls back to the active horizontal work plane. The existing coordinate-entry path remains available as a fallback.

During placement, the viewport shows a live path/section preview, point progress, Undo point and Cancel controls. Escape cancels the active placement; Backspace or the HUD button removes the last point; right-click also removes the last point.

After an adaptive component is selected, a 3D handle is displayed at each saved placement point. Dragging a handle updates the stored point and regenerates geometry during the gesture. Releasing commits one undo step; Escape restores the starting definition. The existing viewport gesture router pauses camera controls during the grip drag.

## Persistent point constraints

Constraints are stored in the project's adaptive element definition alongside its profile and placement points. The project JSON remains the source of truth, and the geometry builder reapplies constraints after reload.

Supported constraint JSON forms:

```json
[
  { "kind": "fixed", "pointIndex": 0, "value": { "x": 0, "y": 0, "z": 0 } },
  { "kind": "axis", "pointIndex": 1, "axis": "y", "value": 3.2 },
  { "kind": "coincident", "a": 0, "b": 2, "driven": "b" },
  { "kind": "distance", "a": 0, "b": 1, "distance": 6.0, "driven": "b" }
]
```

- `fixed` locks a point to an absolute 3D coordinate.
- `axis` locks one coordinate while leaving the other two free.
- `coincident` keeps two points together.
- `distance` keeps the distance between two points at a positive value.
- During a live handle drag, the point under the cursor drives its connected relationship. Without a drag, the optional `driven` property selects the default dependent endpoint (defaults to `b`).

Point indices are zero-based. The validator rejects out-of-range indices, invalid axes, non-finite values, zero/negative distances, and self-referencing relationships. Constraints are limited to 128 entries per component.

## Shared family-type propagation

The Edit Adaptive dialog exposes compatible shared family types. A selected family type is stored as a `familyBinding` on the adaptive definition, and the authored element's `familyId` / `familyTypeId` fields refer to that shared catalog item.

The first profile adapter supports:
- box family geometry (width × depth section);
- cylinder family geometry (circular section);
- extrusion geometry with rectangular, circular or polygon profiles.

When the shared family/type service reports a change, all linked adaptive instances are regenerated in one history transaction from the resolved family/type dimensions. Unsupported `composed` and `custom` family geometries are intentionally omitted from the type picker rather than being converted inaccurately.

## Persistence and undo

The adaptive definition remains under the project-authored element properties. Live point motion uses transient previews; only the final drag release adds a history command. Undo/redo rebuilds the native element from the saved before/after definition. Family type propagation also records a single transaction for the affected linked instances.

## Current scope and next refinement

Interactive placement picks model surfaces and the active horizontal work plane. A free-space arbitrary work-plane/face-lock workflow, dedicated on-screen constraint glyphs and a full constraint solver for complex multi-relationship networks are not part of this slice. The current distance/coincident solver is deterministic and relationship-oriented, not a general CAD nonlinear solver. Family bindings currently map supported cross-sections; they do not yet compose every solid in a multi-part family or synchronize non-profile metadata/connectors.
