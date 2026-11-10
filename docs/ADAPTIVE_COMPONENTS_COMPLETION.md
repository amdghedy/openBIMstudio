# Adaptive Components — Completed Authoring, Constraints, Families and IFC

This document records the extended adaptive-component milestone. The editable project definition remains the source of truth; Three.js meshes and IFC geometry are regenerated from it.

## Arbitrary work planes

The named work-plane service stores a plane as a world-space origin, unit normal, in-plane rotation, and optional picked-face provenance. The viewport placement HUD provides **Pick Work Plane**: choose a visible model face, then place subsequent adaptive points by ray/plane intersection. Snaps are projected back onto the active plane before being accepted.

Work planes support 3D-to-plane projection, signed plane distance, rotation of the local sketch axes, named-plane activation/removal, and serializable snapshots. Project save/open now writes and restores the complete named-plane snapshot. Each adaptive definition also stores the placement plane used for that instance.

## Persistent face locks

A face-pick records:
- the source authored element id (when available);
- source mesh index and picked triangle index;
- the picked point and face normal in source-mesh local coordinates;
- the last resolved world-space plane.

Each adaptive placement point receives a `face-lock` plane constraint. During authored mesh regeneration the source mesh reference is resolved again; the local anchor and normal are transformed to world space and the saved plane is refreshed. This means normal source-object transform changes can carry the adaptive placement with the face.

The source-local anchor is retained so the plane can be re-resolved after save/reopen. If the source element/mesh is unavailable, the last saved world plane is retained as a safe fallback. If source topology changes substantially, the stored local anchor may no longer describe the intended face; a future topology-aware persistent face identifier/barycentric anchor would improve that case.

## Constraint network and glyphs

The adaptive solver now supports:
- fixed 3D points and single-axis coordinate locks;
- plane and picked-face locks;
- coincident points and fixed distances;
- horizontal and vertical relationships;
- parallel, perpendicular and equal-length segment relationships;
- angular relationships defined by two segments, an angle in radians, and a rotation axis.

The solver applies deterministic projection passes over the whole constraint list, evaluates residuals, and rejects a network that does not converge within the configured iteration/tolerance bounds. It preserves shared vertices for common angle/perpendicular joints. Contradictory dimensions are rejected rather than silently stored.

When an adaptive instance is selected, the viewport displays distinct 3D constraint glyphs alongside point grips: axis crosses, axis/relationship lines, distance/coincidence markers, plane patches and segment-relation markers. Point handles remain independently pickable so the glyph geometry does not steal grip gestures.

This is a bounded geometric projection solver for the listed relationships, not a general symbolic/nonlinear CAD solver for every possible constraint equation. It intentionally rejects unsupported or contradictory networks.

## Compound and custom family-type propagation

Shared family types can now map into one or more swept section parts:
- box and cylinder primitives;
- rectangular, circular and polygon extrusion profiles (without inner voids);
- recursively composed families, flattened into multiple swept solids;
- custom family builders with a registered adaptive profile adapter.

A custom builder adapter is registered through the native adaptive API:

```ts
window.__obsAdaptive.registerCustomFamilyProfileAdapter(
  "my-family-builder",
  (params, resolve, geometry) => [
    { name: "Web", profile: [ /* closed {u, v} ring */ ] },
    { name: "Flange", profile: [ /* closed {u, v} ring */ ] },
  ],
);
```

The adapter must return 1–64 valid closed profile parts. Every returned part is swept along the adaptive point path, stored in `adaptiveDefinition.profileParts`, regenerated as an individual mesh, and included in the IFC tessellation. Family type edits propagate to all linked adaptive instances in one history transaction.

Supported in-plane family section transforms include X/Z translation, positive X/Z scale and rotation about the section's local Y axis. Along-path translation/scale, rotations about the other axes, unsupported extrusion profiles and profiles with voids are rejected instead of being approximated silently. Custom family builders require an explicit adapter; there is no generic safe way to infer a cross-section from arbitrary THREE.Object3D output.

## IFC export

Adaptive components have an explicit branch in the authored IFC exporter. Their generated triangle soup is exported as:
- `IfcBuildingElementProxy` with `IfcTriangulatedFaceSet` in IFC4;
- `IfcBuildingElementProxy` with `IfcFacetedBrep` in IFC2X3.

A dedicated `Pset_OBS_AdaptiveComponent` carries the editable definition data:
- definition schema version and family identity;
- ordered placement points;
- legacy and compound profile definitions;
- geometric constraints, including face-lock references;
- placement work plane;
- shared family/type binding.

The IFC geometric representation is interoperable fallback geometry; the custom property set preserves Open BIM Studio's parametric/adaptive authoring data for round-trip-aware consumers. Adaptive components are not mapped to a nonexistent standard IFC adaptive-component entity.

## Regression coverage and verification

The CI suite now includes:
- work-plane creation, arbitrary-normal projection, local-axis rotation and snapshot restore;
- plane/face constraints, segment relationships, shared-vertex angle solving and contradiction rejection;
- source-face rebinding after a host transform change;
- compound-family and registered custom-family profile propagation;
- IFC4 and IFC2X3 adaptive geometry plus the adaptive property set.

The pull request's current GitHub Actions checks remain the release gate. Build, CodeQL and the complete unit/native test suite must all pass on the final PR head before merging.
