# Native Adaptive Components

## Scope

Adaptive components are native project-authored elements. The stored definition is authoritative; the generated Three.js mesh is derived geometry.

The implementation reuses the existing adaptive sweep engine and the authoring mesh-builder registry. It does not introduce a second geometry engine.

## Stored definition

Every adaptive-component authored element stores a versioned properties.adaptiveDefinition object:

| Field | Purpose |
|---|---|
| schemaVersion | Definition migration version |
| familyId, familyName | Source family identity |
| pointCount | Number of ordered placement points |
| points | One to eight world-space coordinates in metres |
| profile | Cross-section polygon in local (u, v) metres |
| pointLength | Extrusion length for one-point families |

The native AuthoredElement also stores its normal project identity, family reference, level, name, color and base quantity parameters. Because the definition lives under the project's elements collection, it is included in normal project serialization.

The definition is a snapshot of the source profile. This is intentional in this milestone: an element can still regenerate if its source family catalogue entry is not loaded. Type-wide propagation from a shared family catalogue is not implemented yet.

## Geometry and regeneration

src/modules/adaptive/index.ts owns profile validation, ordered point validation, sweep generation and volume calculations. It accepts one to eight placement points. A one-point family extrudes its profile along local +Y by pointLength (defaulting to one metre at the engine level).

src/modules/adaptive/native-integration.ts registers the adaptive-component builder in window.__obsMeshBuilders. During authoring.rebuildAuthored(), authoring.ts asks this builder for derived geometry. The builder reads properties.adaptiveDefinition, regenerates the indexed sweep, and returns a Three.js group tagged with the authored element ID.

The Architecture ribbon exposes:
- Adaptive Sweep — create a native component from a family or custom rectangular/circular profile and one to eight coordinate points.
- Divide & Repeat — create native instances along a divided line. The full repeated placement is one undo operation.
- Edit Adaptive — edit one selected native component's ordered points and profile, then regenerate.

Individual create/edit operations use the existing History manager. Failed geometry validation occurs before the model element is changed.

## Tests

- tests/adaptive.test.cjs verifies the 1–8 point engine range, one-point extrusion, eight-point sweeps, finite coordinates and volume.
- tests/adaptive-native.test.cjs verifies native element creation, mesh-builder registration, rebuild, JSON save/reopen reconstruction, point/profile editing, undo/redo and batch rollback.
- scripts/ci-unit-tests.mjs includes both adaptive suites.

## Known limitations

This is the first native-integration milestone, not a claim of full adaptive-family authoring parity.

- Placement points are entered as coordinates in the dialog; interactive 3D point picking and editable viewport grips are not implemented yet.
- Geometric point constraints, reference-plane constraints and dimension-driven point relationships are not yet attached to the native definition.
- Editing updates an instance's stored definition. Shared family type propagation and a persisted family catalogue are follow-up work.
- Custom profiles are stored on each instance; there is no dedicated adaptive family creation/catalogue editor yet.
- IFC export mapping for adaptive-component is not yet implemented.
- The integration regression test uses a mock authoring service and JSON serialization. Browser end-to-end placement, a real project save/reopen cycle and a representative building model still need runtime validation.

These boundaries are also recorded in src/features/feature-maturity.ts.
